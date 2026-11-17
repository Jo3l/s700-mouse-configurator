#!/usr/bin/env python3
"""Servidor de depuración del configurador S700: sirve el repo y, sobre todo,
expone en HTTP lo que hace la página (tramas HID, clics, memoria leída, errores)
y permite mandarle órdenes desde fuera.

    python3 tools/debugd.py 8099                     # http (para el proxy)
    python3 tools/debugd.py 8099 --also-tls 8443     # + https con certs/dev.pem
    python3 tools/debugd.py 8099 --also-tls 8443 --fresh

Acepta el prefijo que añade el proxy (``/proxy/<puerto>/…``) tanto si el proxy
lo quita como si lo deja, así que las rutas relativas de la página funcionan en
los dos casos.

API (todas relativas a la raíz del servidor):

    GET  debug/ping                     ¿vivo?
    GET  debug/summary                  contadores, estado, memoria analizada
    GET  debug/state                    última foto enviada por la página
    GET  debug/mem                      volcado legible de la memoria leída
    GET  debug/events?after=N&limit=200 eventos en JSON
    GET  debug/wait?after=N&timeout=25  eventos nuevos (long poll)
    GET  debug/log.txt?n=200&grep=hid   últimas N líneas legibles
    GET  debug/hid?n=40&dir=out|in      últimas N tramas HID legibles
    GET  debug/cmds                     órdenes pendientes y resultados
    POST debug/event    [ {...}, ... ]  o  {"kind": "...", ...}
    POST debug/state    {...}           foto del estado
    POST debug/cmd      {"action":"read","args":{...}}   (o form: action=read)
    POST debug/cmd_result {"id":N,"ok":true,"result":...}
    POST debug/clear

La página habla con esto sola cuando se abre con ``?debug=1``.
"""
import argparse
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import http.server

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERTS = os.path.join(ROOT, "certs")
STORE = os.path.join(ROOT, "tools", "probe", "debug")
PREFIX_RE = re.compile(r"^/proxy/\d+(?=/|$)")

MAX_EVENTS = 20000
MAX_CMDS = 500
MAX_RESULTS = 200

KEY_ADDR = {0: 0x08, 2: 0x09, 1: 0x0a, 4: 0x0b, 3: 0x0c, 5: 0x0d,
            9: 0x0e, 8: 0x0f, 6: 0x3b, 7: 0x3c}
RANGES = ((0x08, 0x80), (0xa0, 0x2d0), (0x400, 0x4a8))


def now():
    return time.time()


def strip_prefix(path):
    path = PREFIX_RE.sub("", path.split("?", 1)[0])
    return path or "/"


# --------------------------------------------------------------------- store
class Store:
    def __init__(self):
        os.makedirs(STORE, exist_ok=True)
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.seq = 0
        self.total = 0
        self.events = []
        self.state = None
        self.cmds = []
        self.results = []
        self.next_id = 1
        self.started = now()
        self.touched = now()
        self.events_path = os.path.join(STORE, "events.jsonl")
        self.cmds_path = os.path.join(STORE, "cmds.jsonl")
        self.state_path = os.path.join(STORE, "state.json")

    # -- eventos
    def add(self, items):
        arrived = now()
        with self.lock:
            batch = []
            for ev in items:
                if not isinstance(ev, dict):
                    continue
                t = ev.get("t")
                if isinstance(t, (int, float)) and t < 1e6:      # reloj de la página
                    ev["pt"] = round(float(t), 3)
                ev["t"] = arrived
                self.seq += 1
                self.total += 1
                ev["seq"] = self.seq
                self.events.append(ev)
                batch.append(ev)
            if len(self.events) > MAX_EVENTS:
                del self.events[: len(self.events) - MAX_EVENTS]
            self.touched = now()
            self.cond.notify_all()
        with open(self.events_path, "a", encoding="utf-8") as fh:
            for ev in batch:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return self.seq

    def since(self, after, limit):
        with self.lock:
            out = [e for e in self.events if e.get("seq", 0) > after]
            return out[:limit], self.seq

    def wait(self, after, timeout):
        deadline = time.time() + max(0.0, min(timeout, 60.0))
        with self.lock:
            while True:
                out = [e for e in self.events if e.get("seq", 0) > after]
                if out or time.time() >= deadline:
                    return out[:500], self.seq
                self.cond.wait(max(0.05, min(1.0, deadline - time.time())))

    # -- estado
    def set_state(self, payload):
        payload["t"] = now()
        with self.lock:
            self.state = payload
            self.touched = now()
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_path)

    # -- órdenes
    def queue(self, action, args=None, note=None):
        with self.lock:
            cid = self.next_id
            self.next_id += 1
            cmd = {"id": cid, "action": action, "args": args or {}, "t": now()}
            if note:
                cmd["note"] = note
            self.cmds.append(cmd)
            if len(self.cmds) > MAX_CMDS:
                del self.cmds[: len(self.cmds) - MAX_CMDS]
            self.cond.notify_all()
        with open(self.cmds_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"queued": cmd}, ensure_ascii=False) + "\n")
        return cid

    def take(self, timeout=0.0):
        deadline = time.time() + max(0.0, timeout)
        with self.lock:
            while True:
                if self.cmds:
                    return self.cmds.pop(0)
                left = deadline - time.time()
                if left <= 0:
                    return None
                self.cond.wait(min(left, 1.0))

    def put_result(self, payload):
        with self.lock:
            self.results.append(payload)
            if len(self.results) > MAX_RESULTS:
                del self.results[: len(self.results) - MAX_RESULTS]
        with open(self.cmds_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"result": payload}, ensure_ascii=False) + "\n")

    def reset(self):
        with self.lock:
            self.seq = 0
            self.total = 0
            self.events.clear()
            self.state = None
            self.cmds.clear()
            self.results.clear()
            self.touched = now()
        for path in (self.events_path, self.cmds_path):
            open(path, "w", encoding="utf-8").close()
        try:
            os.remove(self.state_path)
        except OSError:
            pass


ST = Store()



# El servidor inyecta el instrumento en todo HTML que sirva, así da igual que la
# página se abra como /web/index.html o como /dist/S700-configurador.html (el
# paquete de un solo fichero no lleva el gancho). ?debug=0 lo desactiva.
HOOK = ('<script>/* debugd */if(!/[?&]debug=0/.test(location.search))'
        'import("./__debug.js").catch(function(){});</script>')


# ------------------------------------------------------------------ formato
def fmt(ev, base):
    if isinstance(ev.get("pt"), (int, float)):
        dt = "+%.3f" % ev["pt"]                                  # reloj de la página
    else:
        dt = "+%.3f" % ((ev.get("t") or base) - base)             # reloj del servidor
    kind = ev.get("kind")
    if kind == "hid":
        hexs = " ".join(ev.get("hex") or [])
        extra = ""
        if ev.get("addr") is not None:
            extra = " cmd=%s addr=0x%04x idx=%s" % (ev.get("cmd"), ev.get("addr"), ev.get("idx"))
        tail = " ERR " + str(ev.get("err")) if ev.get("err") else ""
        ms = ev.get("ms")
        ms = " %.1fms" % ms if isinstance(ms, (int, float)) else ""
        return "%s %-3s %-23s%s%s%s" % (dt, ev.get("dir", "?"), hexs, extra, ms, tail)
    if kind == "input":
        return "%s in%-2s %s" % (dt, ev.get("rid", "?"), " ".join(ev.get("hex") or []))
    if kind == "status":
        return "%s status %-42s %s" % (dt, json.dumps(ev.get("text")), ev.get("cls") or "")
    if kind == "ui":
        what = ev.get("ev")
        tgt = ev.get("target")
        val = ev.get("value")
        if what in ("click", "pointerdown", "pointerup", "keydown"):
            pos = ev.get("pos")
            pos = " @%s" % ",".join(str(v) for v in pos) if pos else ""
            return "%s %-11s %s%s" % (dt, what, tgt, pos)
        return "%s %-11s %s = %s" % (dt, what, tgt, json.dumps(val)[:80])
    if kind == "error":
        return "%s ERROR %s %s" % (dt, ev.get("msg"), ev.get("where") or "")
    if kind == "info":
        return "%s info %s" % (dt, ev.get("msg"))
    if kind == "cmd":
        return "%s >>> %s %s" % (dt, ev.get("action"), json.dumps(ev.get("args") or {})[:60])
    if kind == "cmd_result":
        return "%s <<< #%s %s %s" % (dt, ev.get("id"), ev.get("ok"), str(ev.get("result"))[:200])
    if kind == "apply":
        return "%s apply %s" % (dt, json.dumps(ev.get("blocks"))[:160])
    if kind == "state":
        return "%s state %s" % (dt, json.dumps({k: v for k, v in ev.items() if k not in ("kind", "t", "seq", "mem", "cfg")})[:160])
    return "%s %s %s" % (dt, kind, json.dumps({k: v for k, v in ev.items() if k not in ("kind", "t", "seq")})[:160])


def mem_stats(hexs):
    if not hexs:
        return {"len": 0}
    try:
        mem = bytes.fromhex(hexs)
    except ValueError:
        return {"len": len(hexs), "error": "hex inválido"}
    useful = 0
    for a, b in RANGES:
        for v in mem[a:b]:
            if v not in (0x00, 0xff):
                useful += 1
    return {
        "len": len(mem),
        "useful_bytes": useful,
        "looks_empty": useful == 0,
        "profile": (mem[0x01] >> 5) & 3 if len(mem) > 1 else None,
        "dpi_bytes": list(mem[0x15:0x18]) if len(mem) > 0x17 else None,
        "buttons": {("%d" % k): mem[a] for k, a in KEY_ADDR.items() if a < len(mem)},
        "led": mem[0x1c] if len(mem) > 0x1c else None,
        "brightness_nibble": (mem[0x3f] >> 4) if len(mem) > 0x3f else None,
        "first64": mem[:0x20].hex(),
        "at_a0": mem[0xa0:0xc0].hex(),
        "at_400": mem[0x400:0x410].hex(),
    }


def rel(ev):
    pt = ev.get("pt")
    if isinstance(pt, (int, float)):
        return round(float(pt), 2)
    return round((ev.get("t") or 0) - ST.started, 2)


def summary():
    with ST.lock:
        evs = list(ST.events)
        state = ST.state
        total = ST.total
        pending = list(ST.cmds)
        results = list(ST.results)[-10:]
    kinds = {}
    hid = {"out": 0, "in": 0, "err": 0}
    inputs = {}
    statuses = []
    errors = []
    actions = []
    for ev in evs:
        k = ev.get("kind")
        kinds[k] = kinds.get(k, 0) + 1
        if k == "hid":
            d = ev.get("dir", "?")
            hid[d] = hid.get(d, 0) + 1
            if ev.get("err"):
                hid["err"] += 1
        elif k == "input":
            inputs[ev.get("rid")] = inputs.get(ev.get("rid"), 0) + 1
        elif k == "status":
            statuses.append([rel(ev), ev.get("text"), ev.get("cls")])
        elif k == "error":
            errors.append([rel(ev), ev.get("msg"), ev.get("where")])
        elif k == "ui" and ev.get("ev") in ("click", "change"):
            actions.append([rel(ev), ev.get("ev"), ev.get("target"), ev.get("value")])
    out = {
        "server": {"started": ST.started, "uptime_s": round(now() - ST.started, 1),
                   "events_kept": len(evs), "events_total": total, "seq": ST.seq},
        "kinds": kinds,
        "hid": hid,
        "input_reports": inputs,
        "last_status": statuses[-6:],
        "status_changes": len(statuses),
        "errors": errors[-10:],
        "ui_actions": actions[-15:],
        "pending_cmds": pending,
        "last_cmd_results": results,
        "device": (state or {}).get("device"),
        "flags": {k: (state or {}).get(k) for k in ("ready", "dirty", "status", "bytes", "pause")} if state else None,
        "edits": (state or {}).get("edits"),
        "mem": mem_stats((state or {}).get("mem")),
        "cfg": (state or {}).get("cfg"),
    }
    return out


# ------------------------------------------------------------------- handler
class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "g6debugd/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # -- utilidades
    def log_message(self, fmtstr, *args):
        sys.stderr.write("[debugd] %s %s\n" % (self.address_string(), fmtstr % args))

    def end_headers(self):
        # nada de caché: al depurar siempre queremos el fichero de ahora
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def translate_path(self, path):
        return super().translate_path(strip_prefix(path))

    def _split(self):
        parts = urllib.parse.urlsplit(self.path)
        path = PREFIX_RE.sub("", parts.path) or "/"
        return path, urllib.parse.parse_qs(parts.query)

    def _send(self, body, code=200, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, indent=1)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _file(self, fp, ctype, inject=False):
        try:
            with open(fp, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            return self._send({"error": str(exc)}, 404)
        if inject:
            text = data.decode("utf-8", "replace")
            if "__debug.js" not in text:
                if "</body>" in text:
                    text = text.replace("</body>", HOOK + "\n</body>", 1)
                else:
                    text += HOOK
                data = text.encode("utf-8")
        return self._send(data, 200, ctype)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return None
        ctype = (self.headers.get("Content-Type") or "").lower()
        if "json" in ctype or raw[:1] in (b"{", b"["):
            try:
                return json.loads(raw.decode("utf-8"))
            except ValueError:
                pass
        form = urllib.parse.parse_qs(raw.decode("utf-8", "replace"))
        return {k: (v[0] if len(v) == 1 else v) for k, v in form.items()}

    # -- GET
    def do_GET(self):
        path, q = self._split()
        if path == "/":
            suffix = self.path.rstrip("/") + "/web/index.html?debug=1"
            return self._send("", 302, "text/plain", {"Location": suffix})
        if path.endswith("/__debug.js") or path == "/__debug.js":
            return self._file(os.path.join(ROOT, "web", "debug.js"), "application/javascript; charset=utf-8")
        if not path.startswith("/debug/"):
            if path.endswith(".html"):
                fp = self.translate_path(self.path)
                if os.path.isfile(fp):
                    return self._file(fp, "text/html; charset=utf-8", inject=True)
            return super().do_GET()
        one = lambda k, d=None: (q.get(k) or [d])[0]
        if path == "/debug/ping":
            return self._send({"ok": True, "uptime_s": round(now() - ST.started, 1), "seq": ST.seq})
        if path == "/debug/summary":
            return self._send(summary())
        if path == "/debug/state":
            with ST.lock:
                if ST.state is None:
                    return self._send({"error": "la página no ha enviado estado todavía"}, 404)
                return self._send(ST.state)
        if path == "/debug/mem":
            with ST.lock:
                hexs = (ST.state or {}).get("mem") or ""
            if not hexs:
                return self._send("(sin memoria: abre la página con ?debug=1 y lee del ratón)\n", 404, "text/plain; charset=utf-8")
            mem = bytes.fromhex(hexs)
            lines = []
            for a in range(0, len(mem), 16):
                row = mem[a:a + 16]
                txt = " ".join("%02x" % b for b in row)
                asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
                lines.append("%04x  %-47s |%s|" % (a, txt, asc))
            return self._send("\n".join(lines) + "\n", 200, "text/plain; charset=utf-8")
        if path == "/debug/events":
            after = int(one("after", "0") or 0)
            limit = min(int(one("limit", "200") or 200), 2000)
            evs, seq = ST.since(after, limit)
            return self._send({"seq": seq, "events": evs})
        if path == "/debug/wait":
            after = int(one("after", "0") or 0)
            timeout = float(one("timeout", "25") or 25)
            evs, seq = ST.wait(after, timeout)
            return self._send({"seq": seq, "events": evs})
        if path == "/debug/log.txt":
            n = min(int(one("n", "200") or 200), 5000)
            grep = (one("grep") or "").lower()
            with ST.lock:
                evs = list(ST.events)
            lines = [fmt(e, ST.started) for e in evs]
            if grep:
                lines = [ln for ln in lines if grep in ln.lower()]
            return self._send("\n".join(lines[-n:]) + ("\n" if lines else ""), 200, "text/plain; charset=utf-8")
        if path == "/debug/hid":
            n = min(int(one("n", "40") or 40), 2000)
            want = one("dir")
            with ST.lock:
                evs = [e for e in ST.events if e.get("kind") == "hid" and (not want or e.get("dir") == want)]
            if one("brief"):
                lines = []
                for e in evs[-n:]:
                    lines.append("%s %s %s" % ("%.3f" % rel(e), e.get("dir"), " ".join(e.get("hex") or [])))
                return self._send("\n".join(lines) + "\n", 200, "text/plain; charset=utf-8")
            return self._send([{k: v for k, v in e.items()} for e in evs[-n:]], 200)
        if path == "/debug/cmds":
            with ST.lock:
                return self._send({"pending": list(ST.cmds), "results": list(ST.results)[-20:]})
        if path == "/debug/cmd":
            # la página recoge aquí (long poll)
            timeout = float(one("wait", "0") or 0)
            cmd = ST.take(timeout)
            return self._send(cmd or {"id": None})
        return self._send({"error": "ruta desconocida", "path": path}, 404)

    # -- POST
    def do_POST(self):
        path, _ = self._split()
        if not path.startswith("/debug/"):
            return self._send({"error": "solo debug/*"}, 405)
        body = self._body()
        if path == "/debug/event":
            items = body if isinstance(body, list) else [body] if isinstance(body, dict) else []
            seq = ST.add([e for e in items if isinstance(e, dict)])
            return self._send({"ok": True, "seq": seq})
        if path == "/debug/state":
            if isinstance(body, dict):
                ST.set_state(body)
                return self._send({"ok": True})
            return self._send({"error": "se esperaba un objeto"}, 400)
        if path == "/debug/cmd":
            if not isinstance(body, dict) or not body.get("action"):
                return self._send({"error": "falta action"}, 400)
            args = body.get("args") or {}
            if not isinstance(args, dict):
                args = {"value": args}
            extra = {k: v for k, v in body.items() if k not in ("action", "args", "note")}
            args.update(extra)
            cid = ST.queue(str(body["action"]), args, body.get("note"))
            ST.add([{"kind": "cmd", "action": body["action"], "args": args}])
            return self._send({"ok": True, "id": cid})
        if path == "/debug/cmd_result":
            if isinstance(body, dict):
                ST.put_result(body)
                ST.add([{"kind": "cmd_result", "id": body.get("id"), "ok": body.get("ok"),
                         "result": body.get("result")}])
                return self._send({"ok": True})
            return self._send({"error": "se esperaba un objeto"}, 400)
        if path == "/debug/clear":
            ST.reset()
            return self._send({"ok": True})
        return self._send({"error": "ruta desconocida", "path": path}, 404)


# --------------------------------------------------------- proxy TLS opcional
class TLSForward(http.server.BaseHTTPRequestHandler):
    """https://… → http://127.0.0.1:<puerto principal>, para abrir la página por
    LAN sin tocar el resto (WebHID necesita contexto seguro)."""
    protocol_version = "HTTP/1.1"
    upstream = "http://127.0.0.1:8099"

    def log_message(self, *a):
        pass

    def do_GET(self):
        self._fwd("GET")

    def do_POST(self):
        self._fwd("POST")

    def _fwd(self, method):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        req = urllib.request.Request(self.upstream + self.path, data=body, method=method)
        for h in ("Content-Type", "Accept", "Range"):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
                code = resp.status
                headers = resp.headers
        except urllib.error.HTTPError as exc:
            data, code, headers = exc.read(), exc.code, exc.headers
        except Exception as exc:  # noqa: BLE001
            data = ("proxy TLS: %s" % exc).encode()
            code, headers = 502, {}
        self.send_response(code)
        for key, val in headers.items():
            if key.lower() in ("content-length", "transfer-encoding", "connection", "keep-alive"):
                continue
            self.send_header(key, val)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------------- main
def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    key = os.path.join(CERTS, "dev-key.pem")
    crt = os.path.join(CERTS, "dev.pem")
    if os.path.exists(key) and os.path.exists(crt):
        return crt, key
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/CN=s700.local",
        "-addext", "subjectAltName=DNS:localhost,DNS:vs.jo3l.com,IP:127.0.0.1,IP:%s" % ip,
    ], check=True, capture_output=True)
    return crt, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int)
    ap.add_argument("--also-tls", type=int, default=0, help="puerto https extra que reenvía a este")
    ap.add_argument("--fresh", action="store_true", help="borra los eventos guardados")
    args = ap.parse_args()

    if args.fresh:
        ST.reset()
    ST.add([{"kind": "info", "msg": "servidor de depuración arrancado en el puerto %d" % args.port}])

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    httpd.daemon_threads = True
    print("http  http://%s:%d/web/index.html?debug=1" % (local_ip(), args.port), flush=True)
    print("store %s" % STORE, flush=True)
    if args.also_tls:
        crt, key = ensure_cert(local_ip())
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        TLSForward.upstream = "http://127.0.0.1:%d" % args.port
        tlsd = http.server.ThreadingHTTPServer(("0.0.0.0", args.also_tls), TLSForward)
        tlsd.daemon_threads = True
        tlsd.socket = ctx.wrap_socket(tlsd.socket, server_side=True)
        threading.Thread(target=tlsd.serve_forever, daemon=True).start()
        print("https https://%s:%d/web/index.html?debug=1" % (local_ip(), args.also_tls), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
