// Instrumentación de depuración para el configurador S700.
//
// Se carga solo cuando la página se abre con «?debug=1» (lo inyecta debugd.py). No
// forma parte del paquete de dist/: sirve para que la sesión con el ratón se
// pueda seguir desde fuera (tools/debugd.py) — tramas HID de ida y vuelta,
// clics, estado de la memoria y errores — y para poder mandar órdenes desde
// ahí (leer, aplicar, eval).
//
// Nada de esto es necesario para usar el configurador: es andamio desechable.

// La página puede estar en /web/index.html, en /dist/S700-configurador.html o
// detrás de un proxy que añada prefijo: se prueban los prefijos del path de más a
// menos largo hasta que uno conteste al ping.
const CANDIDATES = (() => {
  const segs = location.pathname.split("/").filter(Boolean);
  if (segs.length) segs.pop();                       // el fichero
  const out = [];
  for (let i = segs.length; i >= 0; i--) out.push("/" + [...segs.slice(0, i), "debug/"].filter(Boolean).join("/"));
  return [...new Set(out)];
})();

let API = null;
let sent = 0;
let queue = [];
let flushTimer = null;
let dropped = 0;
let lastState = "";

const now = () => performance.now();
const t0 = now();

function push(ev) {
  if (ev.t === undefined) ev.t = Math.round(now() - t0) / 1000;   // segundos desde la carga
  queue.push(ev);
  if (queue.length > 4000) { queue.splice(0, queue.length - 4000); dropped++; }
  schedule();
}

function schedule() {
  if (flushTimer || !API) return;
  flushTimer = setTimeout(flush, 250);
}

async function flush() {
  flushTimer = null;
  if (!API || !queue.length) return;
  const batch = queue;
  queue = [];
  if (dropped) { batch.unshift({ kind: "info", msg: `se descartaron ${dropped} eventos por saturación`, t: batch[0]?.t ?? 0 }); dropped = 0; }
  try {
    const r = await fetch(API + "event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (r.ok) sent += batch.length;
  } catch {
    queue = batch.concat(queue).slice(-4000);   // se reintenta en el siguiente ciclo
  }
}

async function findApi() {
  for (const base of CANDIDATES) {
    try {
      const r = await fetch(base + "ping", { cache: "no-store" });
      if (r.ok) { API = base; return true; }
    } catch { /* siguiente candidato */ }
  }
  return false;
}

// ------------------------------------------------------------- descripciones
const norm = v => {
  if (v === undefined || v === null) return String(v);
  return String(v).replace(/\s+/g, " ").trim().slice(0, 80);
};

function describeEl(el) {
  if (!el || el.nodeType !== 1) return "(?)";
  let s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  if (cls.length) s += "." + cls.join(".");
  if (el.name) s += "[name=" + el.name + "]";
  return s;
}

const HEX = b => Array.from(b, v => v.toString(16).padStart(2, "0"));
const bytesOf = v => {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof DataView) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return new Uint8Array(0);
};

function decodeFrame(hex) {
  if (hex.length < 7) return {};
  // el ida/vuelta es [0x18, cmd, idx, addr_lo, addr_hi, data, len-1] (sin report id)
  return { cmd: "0x" + hex[1], idx: parseInt(hex[2], 16), addr: parseInt(hex[3], 16) | (parseInt(hex[4], 16) << 8) };
}

// Informes de ENTRADA (interrupción). La colección 0xFF00 declara el informe 6 y
// la de consumidor el 2; si el firmware contesta a una lectura por ahí en vez de
// por GetFeature, aquí se ve.
function attachInput(device) {
  if (!device || device.__dbgIn) return;
  device.__dbgIn = true;
  try {
    device.addEventListener("inputreport", ev => {
      const hex = HEX(bytesOf(ev.data));
      push({ kind: "input", rid: ev.reportId, hex, len: hex.length });
    });
  } catch { /* dispositivo cerrado */ }
}

// ------------------------------------------------------------------- HID raw
// Se parchea el prototipo del dispositivo: así se ven TODAS las tramas, también
// las del camino de reconexión automática, sin tocar g6.js.
function patchHid() {
  const hidDev = window.HIDDevice;
  const hidObj = window.HID;
  if (hidDev && hidDev.prototype && !hidDev.prototype.__dbgSend) {
    const P = hidDev.prototype;
    const origSend = P.sendFeatureReport;
    P.sendFeatureReport = async function (reportId, data) {
      const hex = HEX(bytesOf(data));
      const st = now();
      try {
        const r = await origSend.call(this, reportId, data);
        push({ kind: "hid", dir: "out", hex, ...decodeFrame(hex), ms: Math.round(now() - st) });
        return r;
      } catch (e) {
        push({ kind: "hid", dir: "out", hex, ...decodeFrame(hex), ms: Math.round(now() - st), err: norm(e && e.message || e) });
        throw e;
      }
    };
    P.__dbgSend = true;

    const origRecv = P.receiveFeatureReport;
    P.receiveFeatureReport = async function (reportId) {
      const st = now();
      try {
        const r = await origRecv.call(this, reportId);
        const hex = HEX(bytesOf(r));
        push({ kind: "hid", dir: "in", hex, ...decodeFrame(hex), ms: Math.round(now() - st) });
        return r;
      } catch (e) {
        push({ kind: "hid", dir: "in", hex: [], ms: Math.round(now() - st), err: norm(e && e.message || e) });
        throw e;
      }
    };
  }
  if (hidObj && hidObj.prototype && !hidObj.prototype.__dbgReq) {
    const P = hidObj.prototype;
    const orig = P.requestDevice;
    if (orig) {
      P.requestDevice = async function (opts) {
        push({ kind: "info", msg: "requestDevice filtros=" + JSON.stringify((opts && opts.filters) || []).slice(0, 400) });
        try {
          const devs = await orig.call(this, opts);
          const list = (devs || []).map(d => `${d.productName || "(sin nombre)"} ${d.vendorId.toString(16)}:${d.productId.toString(16)}`);
          push({ kind: "info", msg: "requestDevice → " + (list.length ? list.join(", ") : "ninguno") });
          return devs;
        } catch (e) {
          push({ kind: "error", msg: "requestDevice: " + norm(e && e.message || e), where: "hid" });
          throw e;
        }
      };
      P.__dbgReq = true;
      const origOpen = P.open;
      P.open = async function () {
        const r = await origOpen.call(this);
        attachInput(this);
        return r;
      };
    }
    const origGet = P.getDevices;
    if (origGet) {
      P.getDevices = async function () {
        const devs = await origGet.call(this);
        for (const d of devs || []) attachInput(d);
        push({ kind: "info", msg: "getDevices → " + ((devs || []).length ? devs.map(d => d.productName || "?").join(", ") : "ninguno") });
        return devs;
      };
    }
  }
}

// ---------------------------------------------------------------- UI y ratón
function patchUi() {
  const opts = { capture: true, passive: true };
  const onPointer = e => {
    push({ kind: "ui", ev: e.type, target: describeEl(e.target), pos: [Math.round(e.clientX), Math.round(e.clientY)], button: e.button });
  };
  window.addEventListener("pointerdown", onPointer, opts);
  window.addEventListener("click", e => {
    const el = e.target;
    push({ kind: "ui", ev: "click", target: describeEl(el), text: el && "textContent" in el ? norm(el.textContent).slice(0, 40) : "" });
  }, opts);
  window.addEventListener("change", e => {
    const el = e.target;
    push({ kind: "ui", ev: "change", target: describeEl(el), value: norm(el && el.value) });
  }, opts);
  window.addEventListener("keydown", e => {
    push({ kind: "ui", ev: "keydown", target: describeEl(e.target), value: e.code + (e.ctrlKey ? "+Ctrl" : "") });
  }, opts);

  const statusEl = document.getElementById("status");
  if (statusEl) {
    let last = statusEl.textContent;
    new MutationObserver(() => {
      const text = statusEl.textContent;
      if (text === last) return;
      last = text;
      push({ kind: "status", text, cls: statusEl.className || "" });
    }).observe(statusEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("error", e => {
    push({ kind: "error", msg: norm(e.message) + " (línea " + e.lineno + ")", where: (e.filename || "").split("/").pop() });
  });
  window.addEventListener("unhandledrejection", e => {
    push({ kind: "error", msg: "promesa rechazada: " + norm((e.reason && (e.reason.message || e.reason)) || "?"), where: "rejection" });
  });
  const cerr = console.error;
  console.error = (...a) => { push({ kind: "error", msg: "console.error: " + norm(a.map(x => (x && x.message) || String(x)).join(" ")), where: "console" }); cerr.apply(console, a); };
}

// ------------------------------------------------------------------- estado
const app = () => window.__s700;

function snapshot() {
  const s = app();
  if (!s) return null;
  const st = s.state;
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const out = {
    kind: "state",
    url: location.href,
    status: statusEl ? statusEl.textContent : "",
    cls: statusEl ? statusEl.className : "",
    ready: !!st.ready,
    dirty: !!st.dirty,
    bytes: st.bytes,
    pause: st.pause,
    edits: st.edits,
    device: st.dev ? {
      name: st.dev.productName,
      vid: st.dev.vendorId, pid: st.dev.productId,
      opened: st.dev.opened,
      collections: (st.dev.collections || []).map(c => ({
        usagePage: c.usagePage, usage: c.usage,
        feature: (c.featureReports || []).map(r => r.reportId),
        input: (c.inputReports || []).map(r => r.reportId),
        output: (c.outputReports || []).map(r => r.reportId),
      })),
    } : null,
    mem: st.ready ? HEX(st.mem).join("") : "",
    badReplies: st.mem && st.mem.badReplies || 0,
    lastWrite: st.lastWrite || null,
    cfg: st.ready ? safeCfg(s) : null,
    logTail: logEl ? logEl.textContent.split("\n").slice(-40).join("\n") : "",
  };
  return out;
}

function safeCfg(s) {
  try {
    const cfg = s.cfg();
    return {
      profile: cfg.profile,
      buttons: cfg.buttons.map(b => ({ i: b.i, addr: b.addr, code: b.code, action: b.action, label: b.actionName })),
      dpi: cfg.dpi.map(d => ({ stage: d.stage, code: d.code, settings: d.settings, dpi: d.dpi })),
      ledType: cfg.ledType, usbRate: cfg.usbRate, brightness: cfg.brightness, fireTime: cfg.fireTime,
    };
  } catch (e) {
    return { error: norm(e && e.message || e) };
  }
}

async function postState(force) {
  if (!API) return;
  const snap = snapshot();
  if (!snap) return;
  const json = JSON.stringify(snap);
  if (!force && json === lastState) return;
  lastState = json;
  try {
    await fetch(API + "state", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
  } catch { /* se reintenta al siguiente tick */ }
}

// ------------------------------------------------------------------ órdenes
const ser = v => {
  if (v === undefined) return "undefined";
  try { return JSON.stringify(v); } catch { return String(v); }
};

async function runCmd(cmd) {
  const { action, args } = cmd;
  const s = app();
  const click = id => {
    const el = document.getElementById(id);
    if (!el) throw new Error("no existe #" + id);
    el.click();
    return "click #" + id;
  };
  push({ kind: "info", msg: `orden #${cmd.id} ${action} ${JSON.stringify(args || {}).slice(0, 200)}` });
  let result;
  switch (action) {
    case "apply": result = click("btnApply"); break;
    case "connect": result = click("btnConnect"); break;
    case "connectAll": result = click("btnConnectAll"); break;
    case "backup": result = click("btnBackup"); break;
    case "reload": location.reload(); result = "reload"; break;
    case "click": result = click(String(args && args.id)); break;
    case "pause": {
      const el = document.getElementById("pauseMs");
      el.value = String(args && args.ms);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      result = "pause=" + el.value;
      break;
    }
    case "edits": {
      if (!s) throw new Error("sin __s700");
      s.state.edits = { ...s.state.edits, ...(args && args.edits) };
      s.state.dirty = true;
      s.render();
      result = "edits=" + ser(s.state.edits);
      break;
    }
    case "clearEdits": {
      s.state.edits = {};
      s.state.dirty = false;
      s.render();
      result = "edits vaciados";
      break;
    }
    case "mem": {
      // escribe una imagen de memoria tal cual (hex) sobre el estado, sin tocar el ratón
      if (!s) throw new Error("sin __s700");
      const n = Uint8Array.from((args.mem || "").match(/../g) || [], h => parseInt(h, 16));
      s.state.mem = n;
      s.state.ready = true;
      s.render();
      result = "mem=" + n.length + " bytes";
      break;
    }
    case "eval": {
      // eslint-disable-next-line no-eval
      const fn = new Function("s", "return (async () => { " + (args && args.code) + " })()");
      result = ser(await fn(s));
      break;
    }
    default:
      throw new Error("acción desconocida: " + action);
  }
  return result;
}

async function cmdLoop() {
  for (;;) {
    if (!API) { await new Promise(r => setTimeout(r, 1000)); continue; }
    try {
      const r = await fetch(API + "cmd?wait=20", { cache: "no-store" });
      const cmd = await r.json();
      if (cmd && cmd.id) {
        let ok = true, result = "", error = "";
        try { result = await runCmd(cmd); }
        catch (e) { ok = false; error = norm(e && e.message || e); }
        await fetch(API + "cmd_result", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: cmd.id, action: cmd.action, ok, result: String(result ?? "").slice(0, 4000), error }),
        });
      }
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// -------------------------------------------------------------------- badge
function badge() {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:9999;font:11px/1.3 ui-monospace,monospace;" +
    "background:#0b1020;color:#9f9;border:1px solid #2a3a55;border-radius:5px;padding:4px 7px;opacity:.9;white-space:pre";
  document.body.appendChild(el);
  const tick = () => {
    const s = app();
    el.textContent = (API ? "debug ● " + sent + " ev" : "debug ○ sin servidor") +
      "\n" + (s ? (s.state.ready ? "mem lista" : "sin leer") + (s.state.dirty ? " · cambios" : "") : "…");
    el.style.color = API ? "#9f9" : "#f99";
  };
  setInterval(tick, 500);
  tick();
}

// --------------------------------------------------------------------- init
(async () => {
  patchHid();
  patchUi();
  const ok = await findApi();
  if (ok) {
    push({ kind: "info", msg: "instrumentación conectada a " + API + " · " + navigator.userAgent.slice(0, 120) });
  }
  badge();
  setInterval(() => postState(false), 1000);
  setInterval(() => postState(true), 5000);
  postState(true);
  cmdLoop();

  window.addEventListener("pagehide", () => {
    try {
      if (queue.length) navigator.sendBeacon(API + "event", new Blob([JSON.stringify(queue)], { type: "application/json" }));
    } catch { /* da igual */ }
  });
})();
