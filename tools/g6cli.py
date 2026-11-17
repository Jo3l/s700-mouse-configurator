#!/usr/bin/env python3
"""CLI para el S700: backup, restauración y ajustes sin el software del fabricante.

    pip install hidapi
    sudo python3 tools/g6cli.py list
    sudo python3 tools/g6cli.py dump mi-raton.json
    python3 tools/g6cli.py show mi-raton.json
    sudo python3 tools/g6cli.py restore mi-raton.json
    sudo python3 tools/g6cli.py set-key 8 20        # botón 8 -> acción 20
    sudo python3 tools/g6cli.py set-profile 2

En Linux el acceso a /dev/hidraw* requiere root o una regla udev; en Windows y
macOS no hace falta nada especial.
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g6proto as g6

MEM_SIZE = 0x500
USAGE_PAGE = 0xFF00


def _hid():
    try:
        import hid  # hidapi
    except ImportError:
        sys.exit("falta hidapi:  pip install hidapi")
    return hid


def find_device(hid):
    devices = hid.enumerate()
    candidates = [d for d in devices if d.get("usage_page") == USAGE_PAGE]
    if not candidates:
        candidates = [d for d in devices if "S700" in (d.get("product_string") or "")]
    if not candidates:
        sys.exit("no encuentro el ratón (UsagePage 0xFF00). ¿Está conectado y tienes permisos?")
    d = candidates[0]
    dev = hid.device()
    dev.open_path(d["path"])
    return dev, d


class Mouse:
    def __init__(self, dev):
        self.dev = dev

    def _send(self, report, pause=0.002):
        # hidapi/hidraw esperan el informe con el report id delante y el tamaño
        # exacto que declara el descriptor (8 bytes en el S700)
        buf = bytes(report[:g6.PACKET_LEN])
        self.dev.write(buf)
        if pause:
            time.sleep(pause)

    def _recv(self, pause=0.002):
        data = self.dev.get_feature_report(g6.REPORT_ID, g6.PACKET_LEN)  # 8 bytes
        if pause:
            time.sleep(pause)
        raw = bytes(data)
        if raw and raw[0] == g6.REPORT_ID:
            return raw
        return bytes([g6.REPORT_ID]) + raw

    def write_block(self, addr, payload):
        for f in g6.write_block(addr, payload):
            self._send(f)

    def read(self, addr, n):
        out = bytearray(n)
        for i in range(n):
            self._send(g6.frame(g6.CMD_READ, 0, addr + i, 0, 1))
            rep = self._recv()
            d = g6.decode(rep)
            out[i] = d["data"] if d else 0
        return bytes(out)

    def flush(self):
        self._send(g6.frame(g6.CMD_FLUSH))
        self._send(g6.frame(g6.CMD_END))


def cmd_list(args):
    hid = _hid()
    for d in hid.enumerate():
        if d.get("usage_page") in (USAGE_PAGE, None) or "S700" in (d.get("product_string") or ""):
            print("%04x:%04x  %-32s %s" % (d["vendor_id"], d["product_id"],
                                           d.get("product_string") or "", d["path"]))


def cmd_dump(args):
    hid = _hid()
    dev, info = find_device(hid)
    mouse = Mouse(dev)
    print("leyendo 0x0000-0x%04x de %s …" % (MEM_SIZE - 1, info.get("product_string")))
    mem = bytearray()
    for addr in range(0, MEM_SIZE, 64):
        mem += mouse.read(addr, min(64, MEM_SIZE - addr))
        print("  %#06x" % (addr + 64), flush=True)
    data = {"tool": "g6cli", "version": 1, "date": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "vid": info["vendor_id"], "pid": info["product_id"], "mem": bytes(mem).hex()}
    out = args.out or "s700-backup.json"
    open(out, "w").write(json.dumps(data, indent=1))
    print("guardado en", out)
    show(bytes(mem))


def show(mem):
    cfg = {
        "perfil": (mem[0x01] >> 5) & 3,
        "usb": mem[0x1E], "led": mem[0x1C], "brillo": mem[0x3F] >> 4,
        "dpi": g6.parse_dpi(mem[0x15:0x18]),
    }
    print("perfil activo :", cfg["perfil"] + 1)
    print("tasa USB      :", cfg["usb"], " tipo LED:", cfg["led"], " brillo:", cfg["brillo"])
    print("códigos DPI   :", cfg["dpi"])
    print("botones       :")
    for k, addr in sorted(g6.KEY_ADDR.items(), key=lambda kv: kv[1]):
        code = mem[addr]
        action = g6.CODE_ACTION.get(code)
        print("   K%-2d  %#06x = %#04x  → acción %s" % (k, addr, code, action))


def cmd_show(args):
    data = json.load(open(args.file))
    show(bytes.fromhex(data["mem"]))


def cmd_restore(args):
    hid = _hid()
    data = json.load(open(args.file))
    mem = bytearray.fromhex(data["mem"])
    if len(mem) < 0x80:
        sys.exit("backup no válido")
    mem += bytes(MEM_SIZE - len(mem))
    dev, _ = find_device(hid)
    mouse = Mouse(dev)
    print("escribiendo %d bloques…" % len(g6.WRITE_BLOCKS))
    for addr, n in g6.WRITE_BLOCKS:
        mouse.write_block(addr, mem[addr:addr + n])
    mouse.flush()
    print("hecho")


def _read_modify_write(edit, what):
    hid = _hid()
    dev, _ = find_device(hid)
    mouse = Mouse(dev)
    mem = bytearray(mouse.read(0, 0x80))
    edit(mem)
    for addr, n in ((0x01, 1),) + tuple((a, 8) for a in range(0x08, 0x80, 8)):
        mouse.write_block(addr, mem[addr:addr + n])
    mouse.flush()
    print(what, "aplicado")


def cmd_set_key(args):
    if args.key not in g6.KEY_ADDR:
        sys.exit("botón fuera de rango (0-9)")
    if args.action not in g6.ACTION_CODE:
        sys.exit("acción desconocida; válidas: " + ", ".join(map(str, sorted(g6.ACTION_CODE))))

    def edit(mem):
        mem[g6.KEY_ADDR[args.key]] = g6.ACTION_CODE[args.action]
    _read_modify_write(edit, "botón %d -> acción %d" % (args.key, args.action))


def cmd_set_profile(args):
    def edit(mem):
        mem[0x01] = 0x03 | ((args.index & 3) << 5)
    _read_modify_write(edit, "perfil %d" % args.index)


def main():
    ap = argparse.ArgumentParser(description="Configurador libre del ratón S700")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="listar dispositivos HID").set_defaults(fn=cmd_list)

    p = sub.add_parser("dump", help="leer el ratón y guardar un backup")
    p.add_argument("out", nargs="?")
    p.set_defaults(fn=cmd_dump)

    p = sub.add_parser("show", help="mostrar un backup")
    p.add_argument("file")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("restore", help="escribir un backup en el ratón")
    p.add_argument("file")
    p.set_defaults(fn=cmd_restore)

    p = sub.add_parser("set-key", help="cambiar la función de un botón")
    p.add_argument("key", type=int)
    p.add_argument("action", type=int)
    p.set_defaults(fn=cmd_set_key)

    p = sub.add_parser("set-profile", help="elegir el perfil activo")
    p.add_argument("index", type=int, choices=range(4))
    p.set_defaults(fn=cmd_set_profile)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
