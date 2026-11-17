// S700 configurator: WebHID + WebHID fallback + diagnostics.
// All in the browser: finds the mouse, reads its memory, lets you edit it and
// rewrites the same blocks the vendor tool writes.
import * as g6 from "./g6.js";
import {
  readConfig, applyEdits, planWrites, hexdump, ACTIONS, MEDIA_CHOICES, DPI_CHOICES, BUTTON_LABEL,
  macroValue, stepsStream, MAX_STEPS, readLed,
} from "./core.js";
import { LED_MODES, LED_MODE_IDS, LED_MAX, LED_USER_COUNT, LED_DPI_COUNT } from "./g6.js";
import { DEFAULT_MEM_HEX } from "./default_image.js";
import * as store from "./storage.js";
import { keyName, usageFromEventCode } from "./g6.js";

const MEM_SIZE = 0x500;
// Este firmware se puede escribir pero no leer (docs/PROTOCOL.md §4), así que no
// hay estado de lectura: la base siempre es la imagen de fábrica o un backup.
const state = {
  dev: null, mem: new Uint8Array(MEM_SIZE), ready: false, dirty: false, edits: {},
  bytes: g6.DATA_LEN, pause: 2,
  macros: [],          // lista guardada en este navegador (ver pestaña Macros)
};

const $ = id => document.getElementById(id);
const statusEl = $("status"), logEl = $("log"), hexEl = $("hex"), barEl = $("bar");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// El log se acumula y se vuelca cada 120 ms: escribir en el DOM por cada trama
// de las 1280 de un volcado hace la lectura 3-4 veces más lenta.
const logBuf = [];
let logTimer = null;
let logCount = 0;
const LOG_MAX_LINES = 4000;

function flushLog() {
  logTimer = null;
  if (!logBuf.length) return;
  logEl.textContent += logBuf.join("");
  logBuf.length = 0;
  if (logCount > LOG_MAX_LINES) {
    const lines = logEl.textContent.split("\n");
    logEl.textContent = lines.slice(-LOG_MAX_LINES).join("\n") + "\n… (truncated)\n";
    logCount = LOG_MAX_LINES;
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function log(report, dir) {
  const d = g6.decode(report);
  const t = d ? `cmd=${d.cmd.toString(16).padStart(2, "0")} idx=${d.index} addr=0x${d.addr.toString(16).padStart(4, "0")} data=0x${d.data.toString(16).padStart(2, "0")} len=${d.length}` : "";
  logBuf.push(`${dir === "in" ? "<-" : "->"} ${t}\n`);
  logCount++;
  if (!logTimer) logTimer = setTimeout(flushLog, 120);
}

// línea de texto suelta en el panel HID traffic (para mensajes, no tramas)
function logText(line) {
  logBuf.push(line + "\n");
  logCount++;
  if (!logTimer) logTimer = setTimeout(flushLog, 120);
}

// Imagen de memoria del fabricante (su config.ini de fábrica, capturada del EXE).
// Es la única base fiable: este firmware implementa SetFeature pero no contesta a
// GetFeature, así que lo que el ratón tiene ahora mismo no se puede leer.
function stockImage() {
  const img = g6.fromHex(DEFAULT_MEM_HEX);
  const full = new Uint8Array(MEM_SIZE);
  full.set(img.subarray(0, MEM_SIZE));
  return full;
}

// Fila de estado del almacenamiento del navegador.
function fmtWhen(ts) {
  if (!ts) return "?";
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderStorage() {
  const el = $("storageState");
  const info = store.describe();
  if (!info.available) {
    el.textContent = "browser storage: not available here";
    el.className = "mono hint warn";
    $("btnLoadSaved").disabled = true;
    $("btnForget").disabled = true;
    return;
  }
  const cfg = info.config;
  const parts = [];
  if (cfg) parts.push(`saved ${fmtWhen(cfg.savedAt)} · ${cfg.source}`);
  if (info.work) parts.push(`unsent changes kept ${fmtWhen(info.work.savedAt)}`);
  el.textContent = parts.length ? `browser storage: ${parts.join(" · ")}` : "browser storage: empty";
  el.className = "mono hint";
  $("btnLoadSaved").disabled = !cfg && !info.work;
  $("btnForget").disabled = !cfg && !info.work;
}

// Todo cambio pendiente se guarda ya en el navegador (no hay botón de guardar):
// recargar la página no lo pierde y el archivo sólo hace falta para llevarse la
// configuración a otro sitio. Se guarda la imagen CON los cambios, pero sin
// consolidarlos en state.mem: `dirty` sigue significando "no enviado al ratón".
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (!state.ready) return;
    const rec = store.saveWorkspace(state.mem, state.edits);
    renderStorage();
    if (!rec) setStatus("could not save in this browser (storage full or unavailable)", "err");
  }, 400);
}

// Vuelve a la configuración comprometida (la última escrita en el ratón o
// importada) y tira los cambios sin enviar. Sin nada guardado, a la de fábrica.
function revertSaved() {
  const rec = store.loadConfig();
  const base = rec ? rec.mem : stockImage();
  const full = new Uint8Array(MEM_SIZE);
  full.set(base.subarray(0, MEM_SIZE));
  state.mem = full;
  state.ready = true;
  state.dirty = false;
  state.edits = {};
  store.clearWorkspace();
  renderStorage();
  setStatus(rec
    ? `reverted to the configuration saved in this browser (${fmtWhen(rec.savedAt)})`
    : "reverted to the factory image · nothing was saved in this browser", rec ? "ok" : "warn");
  render();
}

function forgetSaved() {
  if (!store.loadConfig() && !store.loadWorkspace()) { setStatus("nothing saved in this browser", "warn"); return; }
  if (!confirm("Forget the configuration saved in this browser?")) return;
  store.clearConfig();
  store.clearWorkspace();
  renderStorage();
  setStatus("saved configuration removed from this browser", "warn");
}

// Imagen de fábrica en los selects. Con `pending` (el botón) queda como cambio
// sin enviar: el usuario decide si lo manda con Apply. Al arrancar sin nada
// guardado se carga sin marcar cambios.
function loadDefaults(pending = true) {
  state.mem = stockImage();
  state.ready = true;
  state.dirty = pending;
  state.edits = {};
  setStatus(pending
    ? "factory defaults loaded · nothing is written until you press Apply"
    : "factory configuration loaded · no saved configuration", "ok");
  render();
}

// Este firmware no contesta a GetFeature (§4), así que no hay nada que leer: la
// base es la imagen guardada en el navegador o la de fábrica. La función existe
// porque la llama el camino de conexión y la orden «read» de tools/debugd.py;
// antes no estaba definida y conectar terminaba en «connect error: read is not
// defined» aunque el dispositivo se hubiera abierto bien.
async function read() {
  const msg = "nothing to read: this mouse does not answer GetFeature (see PROTOCOL §4)";
  logText("read · " + msg);
  return msg;
}

// No hay relectura posible (el firmware no contesta a GetFeature), así que lo
// único que se puede afirmar es cuántos bloques se enviaron y sin error.
function reportWrite(blocks) {
  state.lastWrite = { blocks, at: Date.now() };
  setStatus(`written ${blocks} blocks · not verifiable: this mouse cannot be read`, "ok");
}

// La barra de escritura es la misma en todas las pestañas que mandan la imagen.
function progress(done, total) {
  for (const bar of document.querySelectorAll(".bar")) {
    bar.classList.add("on");
    bar.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
    if (done >= total) setTimeout(() => { bar.classList.remove("on"); bar.firstElementChild.style.width = "0"; }, 250);
  }
}

// ---------------------------------------------------------------- dispositivo
function describeDevice(dev) {
  const lines = [
    `product  : ${dev.productName || "(no name)"}`,
    `VID:PID  : ${dev.vendorId.toString(16).padStart(4, "0")}:${dev.productId.toString(16).padStart(4, "0")}`,
    `opened   : ${dev.opened}`,
    "collections:",
  ];
  for (const c of dev.collections || []) {
    const fr = (c.featureReports || []).map(r => r.reportId).join(",") || "—";
    const ir = (c.inputReports || []).map(r => r.reportId).join(",") || "—";
    const or = (c.outputReports || []).map(r => r.reportId).join(",") || "—";
    lines.push(`  usagePage 0x${c.usagePage?.toString(16)} usage 0x${c.usage?.toString(16)}  feature[${fr}] input[${ir}] output[${or}]`);
    for (const r of c.featureReports || []) {
      const size = (r.items || []).reduce((a, it) => a + (it.reportSize || 0) * (it.reportCount || 0), 0);
      lines.push(`      feature report ${r.reportId}: ${size} bits (${Math.ceil(size / 8)} bytes)`);
    }
  }
  return lines.join("\n");
}

function renderDevice() {
  const box = $("device");
  if (!state.dev) { box.textContent = "(no device)"; return; }
  const d = state.dev;
  const hasVendor = (d.collections || []).some(c => c.usagePage === g6.USAGE_PAGE || c.usagePage === g6.CONFIG_USAGE_PAGE);
  const has7 = (d.collections || []).some(c => (c.featureReports || []).some(r => r.reportId === g6.REPORT_ID));
  const warn = !has7
    ? "\n\n⚠ no feature report with id 7 in the descriptor; if reading fails, copy this diagnostic."
    : `\n\nfeature report ${g6.REPORT_ID}: ${state.bytes} bytes → frames of ${state.bytes} bytes (${state.bytes === g6.DATA_LEN ? "expected" : "unusual"})`;
  const hint = !hasVendor ? "\n⚠ this device does not declare the vendor collection 0xFF00/0xFF01" : "";
  box.textContent = describeDevice(d) + hint + warn;
  $("btnCopy").disabled = false;
}

function openHelp(msg) {
  return [
    "The browser could not open the device: " + msg,
    "",
    "The permission dialog worked, so the mouse was found; what failed is the",
    "operating system handing it to the browser.",
    "",
    "Linux — /dev/hidrawN belongs to root:root 0600 unless a udev rule says",
    "otherwise. Run this once (adjust nothing if your ids are 30fa:1540):",
    "",
    "  echo 'KERNEL==\"hidraw*\", ATTRS{idVendor}==\"30fa\", ATTRS{idProduct}==\"1540\", MODE=\"0660\", TAG+=\"uaccess\"' \\",
    "    | sudo tee /etc/udev/rules.d/60-hxsj-s700.rules",
    "  sudo udevadm control --reload-rules",
    "  sudo udevadm trigger --action=change",
    "",
    "then unplug and replug the mouse and reload this page. With TAG+=\"uaccess\"",
    "the node is handed to the user logged in on the machine; if that does not",
    "work (no seat, remote desktop), use MODE=\"0666\" instead.",
    "Quick test without udev (until the next replug): sudo chmod 666 /dev/hidrawN",
    "",
    "Windows — close the vendor app (S700 Gaming Mouse.exe) and the tray",
    "helpers: they hold the device open and the browser cannot take it.",
    "",
    "Also: a Chromium installed as a snap or flatpak may be sandboxed away from",
    "/dev/hidraw*; the distribution package or a browser run outside the sandbox",
    "is the simplest check.",
  ].join("\n");
}

function isVendorDevice(dev) {
  return (dev.collections || []).some(c => c.usagePage === g6.USAGE_PAGE || c.usagePage === 0xff00);
}

async function connect(all) {
  if (!navigator.hid) { setStatus("this browser has no WebHID", "err"); return; }
  if (!window.isSecureContext) {
    setStatus("insecure context: open the page over https or from localhost", "err");
    return;
  }
  // Sin filtro por vendorId: el ratón expone dos interfaces (ratón y
  // configuración) con el mismo VID:PID y el diálogo las muestra igual, así que
  // el usuario acababa eligiendo la de ratón. Las colecciones 0xFF00/0xFF01
  // identifican la buena y dejan una sola entrada en el diálogo.
  const filters = all
    ? [{}]
    : [
        { usagePage: g6.CONFIG_USAGE_PAGE, usage: g6.USAGE },
        { usagePage: g6.CONFIG_USAGE_PAGE },
        { usagePage: g6.USAGE_PAGE, usage: g6.USAGE },
        { usagePage: g6.USAGE_PAGE },
      ];
  try {
    const picked = await navigator.hid.requestDevice({ filters });
    if (!picked || !picked.length) { setStatus("no device selected", "warn"); return; }
    // Si el diálogo devuelve varias, se prefiere la que declara el informe
    // feature 7; si esa no abre, se prueba el resto antes de rendirse.
    const score = d => {
      const cols = d.collections || [];
      const has7 = cols.some(c => (c.featureReports || []).some(r => r.reportId === g6.REPORT_ID));
      const vendor = cols.some(c => c.usagePage === g6.CONFIG_USAGE_PAGE || c.usagePage === g6.USAGE_PAGE);
      return (has7 ? 2 : 0) + (vendor ? 1 : 0);
    };
    const candidates = [...picked].sort((a, b) => score(b) - score(a));
    let dev = null, openError = null;
    for (const cand of candidates) {
      try {
        if (!cand.opened) await cand.open();
        dev = cand;
        break;
      } catch (e) {
        openError = openError || e;
      }
    }
    if (!dev) throw openError || new Error("Failed to open the device");
    state.dev = dev;
    state.bytes = g6.reportBytes(dev);
    renderDevice();
    setStatus(`${dev.productName || "device"} connected · ${state.bytes} B report`, "ok");
    render();          // el estado de Apply depende de que haya dispositivo
    await read();
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/No device selected|NotFoundError/i.test(msg)) {
      setStatus("no matching devices found", "warn");
      $("btnConnectAll").hidden = false;
      $("hintAll").hidden = false;
      selectTab("debug");   // el diagnóstico y la búsqueda amplia viven ahí
    } else if (/Failed to open|Permission denied|Access denied/i.test(msg)) {
      setStatus("connect error: " + msg, "err");
      // Pasa siempre en Linux mientras /dev/hidrawN sea root:root 0600, y en
      // Windows si el programa del fabricante tiene el ratón abierto.
      $("device").textContent = openHelp(msg);
      selectTab("debug");   // ver el diagnóstico sin tener que buscarlo
    } else {
      setStatus("connect error: " + msg, "err");
    }
  }
}

// Posiciones de los números 1..10 sobre la imagen (web/mouse.png), en % del
// ancho y alto: las originales de la herramienta del fabricante
// (skin_main_en.ini, [BUTTONPOS] 35..44) corregidas sobre la vista nueva, que
// encuadra el ratón un poco más a la derecha. Se comprueban superponiéndolas.
const HOTSPOTS = {
  1: [36.1, 25.8], 2: [68.0, 24.7], 3: [50.5, 25.0], 4: [22.0, 45.5], 5: [22.0, 55.5],
  6: [50.0, 47.6], 7: [23.0, 19.5], 8: [22.0, 30.5], 9: [33.5, 41.6], 10: [66.5, 41.6],
};

const hotEls = {};
function renderHotspots() {
  const box = $("diagram");
  for (let n = 1; n <= 10; n++) {
    const [l, t] = HOTSPOTS[n];
    const b = document.createElement("button");
    b.className = "hot";
    b.style.left = l + "%";
    b.style.top = t + "%";
    b.title = `Button ${n}`;
    const badge = document.createElement("span");
    badge.className = "num-badge";
    badge.textContent = String(n);
    b.appendChild(badge);
    b.onmouseenter = () => markRow(n, true);
    b.onmouseleave = () => markRow(n, false);
    b.onfocus = () => markRow(n, true);
    b.onblur = () => markRow(n, false);
    b.onclick = () => {
      const row = document.querySelector(`#buttons tr[data-n="${n}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const sel = row.querySelector("select");
      if (sel) sel.focus();
    };
    hotEls[n] = b;
    box.appendChild(b);
  }
}

function markRow(n, on) {
  const row = document.querySelector(`#buttons tr[data-n="${n}"]`);
  if (row) row.classList.toggle("on", on);
  if (hotEls[n]) hotEls[n].classList.toggle("on", on);
}

// ---------------------------------------------------------------- render
function render() {
  // Se pinta la imagen CON los cambios pendientes: si no, al repintar el select
  // vuelve al valor del ratón y el cambio parece no haberse hecho.
  const cfg = readConfig(applyEdits(state.mem, state.edits, state.macros), state.macros);

  const prof = $("profiles");
  prof.textContent = "";
  for (let p = 0; p < 4; p++) {
    const b = document.createElement("button");
    b.textContent = `Profile ${p + 1}`;
    if ((state.edits.profile ?? cfg.profile) === p) b.classList.add("on");
    b.onclick = () => { state.edits.profile = p; state.dirty = true; render(); };
    prof.appendChild(b);
  }

  const tb = $("buttons");
  tb.textContent = "";
  if (!state.ready) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "hint";
    td.textContent = "No configuration loaded: connect the mouse, load the saved one or use the stock image.";
    tr.appendChild(td);
    tb.appendChild(tr);
  } else for (const btn of cfg.buttons) {
    const tr = document.createElement("tr");
    tr.dataset.n = String(btn.i + 1);
    const isMedia = typeof btn.action === "string" && /^[mx]/.test(btn.action);
    if (isMedia) tr.classList.add("hasmedia");
    tr.onmouseenter = () => markRow(btn.i + 1, true);
    tr.onmouseleave = () => markRow(btn.i + 1, false);

    const tdN = document.createElement("td");
    tdN.className = "num";
    const badge = document.createElement("span");
    badge.className = "num-badge";
    badge.textContent = String(btn.i + 1);
    tdN.appendChild(badge);

    const td1 = document.createElement("td");
    td1.textContent = BUTTON_LABEL[btn.i];

    const td2 = document.createElement("td");
    td2.className = "fn";          // la única celda que puede ceder ancho
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    // si el ratón guarda un código que no sabemos representar, se muestra tal cual
    none.textContent = btn.action ? "(unassigned)"
      : btn.code === g6.MACRO_CODE ? "(macro · not in the list)"
      : (btn.code === null || btn.code === undefined ? "(no button)" : `(as stored: 0x${btn.code.toString(16)})`);
    if (!btn.action) none.selected = true;
    sel.appendChild(none);
    const gFun = document.createElement("optgroup");
    gFun.label = "Mouse functions";
    for (const a of ACTIONS) {
      const o = document.createElement("option");
      o.value = String(a.id);
      o.textContent = a.name;
      if (btn.action === String(a.id)) o.selected = true;
      gFun.appendChild(o);
    }
    // las ranuras de los registros de acciones avanzadas sólo están medidas en el
    // perfil 1, así que en los demás perfiles se ofrecen sólo las 20 funciones
    const otherProfile = cfg.profile !== 0;
    const gMed = document.createElement("optgroup");
    gMed.label = otherProfile ? "Media keys (profile 1 only)" : "Media keys";
    gMed.disabled = otherProfile;
    for (const m of MEDIA_CHOICES) {
      const o = document.createElement("option");
      o.value = m.value;
      o.textContent = m.name;
      if (btn.action === m.value) o.selected = true;
      gMed.appendChild(o);
    }
    const gKey = document.createElement("optgroup");
    gKey.label = otherProfile ? "Keyboard (profile 1 only)" : "Keyboard";
    gKey.disabled = otherProfile;
    const cur = typeof btn.action === "string" && btn.action.startsWith("k") ? btn.action : null;
    const pick = document.createElement("option");
    pick.value = "k";
    pick.textContent = "Keyboard key…";
    gKey.appendChild(pick);
    if (cur) {
      const o = document.createElement("option");
      o.value = cur;
      o.textContent = "Key: " + keyName(Number(cur.slice(1)));
      o.selected = true;
      gKey.appendChild(o);
    }
    // macros guardadas: el ratón ejecuta el flujo solo (sólo perfil 1)
    const gMacro = document.createElement("optgroup");
    gMacro.label = otherProfile ? "Macros (profile 1 only)" : "Macros";
    gMacro.disabled = otherProfile;
    if (!state.macros.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "No macros yet — create them in the Macros tab";
      o.disabled = true;
      gMacro.appendChild(o);
    }
    for (const m of state.macros) {
      const o = document.createElement("option");
      o.value = macroValue(m.id);
      o.textContent = "Macro: " + (m.name || "(unnamed)");
      if (btn.action === macroValue(m.id)) o.selected = true;
      gMacro.appendChild(o);
    }
    sel.append(gFun, gMed, gKey, gMacro);
    sel.onchange = () => {
      if (sel.value === "k") {                                  // abre el capturador
        openKeyModal(usage => {
          state.edits.buttons = { ...state.edits.buttons, [btn.i]: "k" + usage };
          state.dirty = true;
          render();
        });
        return;
      }
      state.edits.buttons = { ...state.edits.buttons, [btn.i]: sel.value };
      state.dirty = true;
      render();
    };
    td2.appendChild(sel);

    const td3 = document.createElement("td");
    td3.className = "mono";
    td3.textContent = btn.addr === undefined ? "—" : `0x${btn.addr.toString(16).padStart(4, "0")} = 0x${btn.code.toString(16)}`;
    tr.append(tdN, td1, td2, td3);
    tb.appendChild(tr);
    if (hotEls[btn.i + 1]) hotEls[btn.i + 1].classList.toggle("media", isMedia);
  }

  const dp = $("dpi");
  dp.textContent = "";
  if (!state.ready) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No configuration loaded.";
    dp.appendChild(p);
  } else cfg.dpi.forEach((d, i) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const label = document.createElement("b");
    label.textContent = `Stage ${d.stage}`;
    const sel = document.createElement("select");
    for (const c of DPI_CHOICES) {
      const o = document.createElement("option");
      o.value = String(c.setting);
      o.textContent = `${c.dpi} dpi`;
      if (d.settings.includes(c.setting)) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { state.edits.dpi = { ...state.edits.dpi, [i]: Number(sel.value) }; state.dirty = true; render(); };
    const info = document.createElement("div");
    info.className = "hint mono";
    info.textContent = `code ${d.code}${d.dpi ? "" : " · ambiguous"}`;
    cell.append(label, sel, info);
    dp.appendChild(cell);
  });

  const shown = applyEdits(state.mem, state.edits, state.macros);   // lo que se enviaría ahora mismo
  hexEl.textContent = !state.ready
    ? "(nothing loaded yet)"
    : hexdump(shown, 0, 0x80) + "\n…\n" +
      hexdump(shown, 0x0a0, 0x100) + "\n…\n" + hexdump(shown, 0x400, 0x4a8);

  $("btnDefaults").disabled = false;
  // Apply manda SIEMPRE la imagen entera, así que no hace falta que haya cambios:
  // también sirve para volcar en un ratón nuevo una configuración ya guardada.
  $("btnApply").disabled = !state.dev || !state.ready;
  $("btnBackup").disabled = !state.ready;
  $("btnRestore").disabled = false;

  $("btnApplyMacros").disabled = !state.dev || !state.ready;
  $("btnApplyLeds").disabled = !state.dev || !state.ready;

  const n = countEdits();
  const applyText = !state.ready ? "no configuration loaded"
    : !state.dirty ? "no unsent changes"
    : n ? `${n} unsent change${n === 1 ? "" : "s"}` : "not sent to the mouse yet";
  $("applyState").textContent = applyText;
  $("macroApplyState").textContent = applyText;
  $("ledApplyState").textContent = applyText;

  renderLeds(cfg.led);

  renderMacroList();

  // cualquier cambio pendiente se persiste en el navegador (no toca el ratón)
  if (state.dirty) scheduleAutosave();
}

function countEdits() {
  const b = Object.keys(state.edits.buttons || {}).length;
  const d = Object.keys(state.edits.dpi || {}).length;
  const p = state.edits.profile === undefined ? 0 : 1;
  const l = state.edits.led ? 1 : 0;
  return b + d + p + l;
}

// ------------------------------------------------------- captura de tecla
let keyModalPick = null, keyModalUsage = null;

function openKeyModal(onPick) {
  keyModalPick = onPick;
  keyModalUsage = null;
  $("keyCap").textContent = "press a key…";
  $("btnKeyUse").disabled = true;
  $("keyModal").hidden = false;
  document.addEventListener("keydown", captureKey, true);
  $("keyCap").focus();
}

function closeKeyModal() {
  $("keyModal").hidden = true;
  document.removeEventListener("keydown", captureKey, true);
  keyModalPick = null;
  keyModalUsage = null;
}

function captureKey(e) {
  if ($("keyModal").hidden) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const usage = usageFromEventCode(e.code);
  if (usage === undefined) return;
  keyModalUsage = usage;
  $("keyCap").textContent = keyName(usage);
  $("btnKeyUse").disabled = false;
}

function useCapturedKey() {
  if (!keyModalPick || keyModalUsage === null) return;
  const pick = keyModalPick, usage = keyModalUsage;
  closeKeyModal();
  pick(usage);
}

// ---------------------------------------------------------------- acciones
async function apply() {
  if (!state.dev || !state.ready) return;
  try {
    const img = applyEdits(state.mem, state.edits, state.macros);
    // Se manda SIEMPRE la imagen completa, como el fabricante. Escribir sólo los
    // bloques tocados deja la tabla de punteros de 0x006E sin actualizar y el
    // ratón descarta el cambio (comprobado en hardware el 17/11/2026: con la
    // imagen entera la configuración sí surte efecto).
    const writes = g6.WRITE_BLOCKS.map(([addr, len]) => ({ addr, payload: img.slice(addr, addr + len) }));
    setStatus(`writing ${writes.length} blocks…`);
    for (let i = 0; i < writes.length; i++) {
      await g6.writeMemory(state.dev, writes[i].addr, writes[i].payload, log, { bytes: state.bytes, pause: state.pause });
      progress(i + 1, writes.length + 2);
    }
    await g6.flush(state.dev, { bytes: state.bytes });
    state.mem = img;
    state.dirty = false;
    state.edits = {};
    progress(writes.length + 2, writes.length + 2);
    reportWrite(writes.length);
    // lo que acaba de recibir el ratón es lo que interesa conservar, y deja de
    // haber cambios pendientes
    const rec = store.saveConfig(state.mem, "applied");
    store.clearWorkspace();
    renderStorage();
    if (!rec) setStatus(statusEl.textContent + " · could not save in this browser", "warn");
    render();
  } catch (e) {
    setStatus("write error: " + (e.message || e), "err");
  }
}

function backup() {
  // Se exporta lo que se ve en pantalla, no sólo la base: los cambios pendientes
  // viven en state.edits, así que sin consolidarlos el fichero salía viejo.
  const data = {
    tool: "s700-webhid", version: 1, date: new Date().toISOString(), size: MEM_SIZE,
    mem: g6.toHex(applyEdits(state.mem, state.edits, state.macros)),
    macros: state.macros,   // el flujo ya va en la imagen; esto es nombre y pasos
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `s700-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Importar NO escribe en el ratón: deja la imagen del fichero en el editor (y en
// el navegador) para revisarla y mandarla con Apply, como cualquier otro cambio.
async function importConfig(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { setStatus("import error: that is not a JSON backup", "err"); return; }
  const img = g6.fromHex((data && data.mem) || "");
  if (img.length < 0x80) { setStatus("import error: the file has no memory image", "err"); return; }
  const full = new Uint8Array(MEM_SIZE);
  full.set(img.subarray(0, MEM_SIZE));
  if (Array.isArray(data.macros)) {
    state.macros = data.macros.filter(m => m && typeof m.id === "string");
    store.saveMacros(state.macros);
    macroSel = state.macros.length ? state.macros[0].id : null;
  }
  state.mem = full;
  state.ready = true;
  state.dirty = false;
  state.edits = {};
  store.saveConfig(state.mem, "imported");
  store.clearWorkspace();
  renderStorage();
  render();
  selectTab("main");   // los selects están ahí: revisar y Apply
  setStatus("configuration imported · review it and press Apply to write it to the mouse", "ok");
}


// ---------------------------------------------------------------- pestañas
// La página se parte en dos vistas: el configurador y el andamio de depuración.
// La pestaña activa vive en el hash (#debug) para que recargar no la cambie;
// algunos navegadores no dejan replaceState en file://, así que va protegido.
const tabButtons = [...document.querySelectorAll("#tabs [role='tab']")];
const PANELS = tabButtons.map(t => t.dataset.panel);

function selectTab(name, focus = false) {
  const btn = tabButtons.find(t => t.dataset.panel === name);
  if (!btn) return;
  for (const t of tabButtons) {
    const on = t === btn;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
    const panel = $(t.getAttribute("aria-controls"));
    if (panel) panel.hidden = !on;
  }
  if (focus) btn.focus();
  if (location.hash.slice(1) !== name) {
    try { history.replaceState(null, "", "#" + name); } catch { /* file:// */ }
  }
}

function initTabs() {
  tabButtons.forEach((t, i) => {
    t.onclick = () => selectTab(t.dataset.panel);
    t.onkeydown = e => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (step) {
        selectTab(tabButtons[(i + step + tabButtons.length) % tabButtons.length].dataset.panel, true);
      } else if (e.key === "Home" || e.key === "End") {
        selectTab(tabButtons[e.key === "Home" ? 0 : tabButtons.length - 1].dataset.panel, true);
      } else return;
      e.preventDefault();
    };
  });
  window.addEventListener("hashchange", () => selectTab(PANELS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "main"));
  // con ?debug=1 (tools/debugd.py) se abre directamente la instrumentación
  const q = new URLSearchParams(location.search).get("debug");
  const wanted = location.hash.slice(1) || (q && q !== "0" ? "debug" : "main");
  selectTab(PANELS.includes(wanted) ? wanted : "main");
}

// ---------------------------------------------------------------- macros
// Una macro es una lista de pasos de tecla que el ratón ejecuta solo. La lista
// (nombre + pasos) se guarda en este navegador; su flujo de bytes se escribe en
// la imagen y viaja al ratón con Apply (docs/PROTOCOL.md §5-ter).
let macroSel = null;

const newMacroId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const macroById = id => state.macros.find(m => m.id === id) || null;
const macroUsers = (cfg, id) => cfg.buttons.filter(b => b.action === macroValue(id)).map(b => b.i + 1);

function cfgNow() { return readConfig(applyEdits(state.mem, state.edits, state.macros), state.macros); }

function saveMacros() {
  if (!store.saveMacros(state.macros)) setStatus("could not save the macros in this browser", "warn");
}

// Los botones que ya lanzaban esta macro se reasignan para que Apply reescriba su
// flujo: los bytes viven en la imagen y no cambian solos al editar la definición.
function touchMacroUsers(id, before) {
  const cfg = readConfig(applyEdits(state.mem, state.edits, before), before);
  const users = cfg.buttons.filter(b => b.action === macroValue(id));
  if (!users.length) return;
  for (const b of users) state.edits.buttons = { ...state.edits.buttons, [b.i]: macroValue(id) };
  state.dirty = true;
}

function editMacro(id, mutate) {
  const m = macroById(id);
  if (!m) return;
  const before = state.macros.map(x => ({ ...x, steps: x.steps.map(st => ({ ...st })) }));
  const beforeBytes = String(stepsStream(m.steps));
  mutate(m);
  saveMacros();
  // sólo si cambian los bytes hay algo que reescribir en el ratón (renombrar no)
  if (String(stepsStream(m.steps)) !== beforeBytes) touchMacroUsers(id, before);
  render();
}

function newMacro() {
  const m = { id: newMacroId(), name: "", steps: [{ usage: 0x04, delay: 10 }] };
  state.macros = [...state.macros, m];
  macroSel = m.id;
  saveMacros();
  render();
  renderMacroForm();
  $("macroName").focus();
}

function deleteMacro() {
  const m = macroById(macroSel);
  if (!m) return;
  const users = macroUsers(cfgNow(), m.id);
  const extra = users.length
    ? ` It is used by button${users.length === 1 ? "" : "s"} ${users.join(", ")}; until you reassign ${users.length === 1 ? "it" : "them"}, that button keeps pointing at a macro that is no longer here.`
    : "";
  if (!confirm(`Delete the macro “${m.name || "(unnamed)"}”?` + extra)) return;
  state.macros = state.macros.filter(x => x.id !== m.id);
  // los botones que la lanzaban vuelven a lo que tengan guardado en la imagen:
  // se quita la edición pendiente para no dejar un cambio fantasma
  const buttons = { ...state.edits.buttons };
  for (const n of users) delete buttons[n - 1];
  state.edits = { ...state.edits, buttons };
  macroSel = state.macros.length ? state.macros[0].id : null;
  saveMacros();
  render();
  renderMacroForm();
}

function renderMacroList() {
  const box = $("macroList");
  if (!box) return;
  box.textContent = "";
  if (!state.macros.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No macros yet.";
    box.appendChild(p);
  }
  const cfg = cfgNow();
  for (const m of state.macros) {
    const row = document.createElement("button");
    row.className = "macro-item" + (m.id === macroSel ? " on" : "");
    row.dataset.id = m.id;
    const name = document.createElement("b");
    name.textContent = m.name || "(unnamed)";
    const meta = document.createElement("span");
    const users = macroUsers(cfg, m.id);
    meta.textContent = `${m.steps.length} step${m.steps.length === 1 ? "" : "s"}` +
      (users.length ? ` · button ${users.join(", ")}` : " · not assigned");
    row.append(name, meta);
    row.onclick = () => { macroSel = m.id; renderMacroList(); renderMacroForm(); };
    box.appendChild(row);
  }
  const used = state.macros.reduce((n, m) => n + (macroUsers(cfg, m.id).length ? m.steps.length : 0), 0);
  $("macroSpace").textContent = `steps in use: ${used} / ${MAX_STEPS}`;
  $("macroSpace").className = "mono hint" + (used > MAX_STEPS ? " warn" : "");
}

function renderMacroForm() {
  const m = macroById(macroSel);
  if (!m) macroSel = null;
  $("macroEmpty").hidden = !!m;
  $("macroForm").hidden = !m;
  if (!m) return;
  if (document.activeElement !== $("macroName")) $("macroName").value = m.name;

  const box = $("macroSteps");
  box.textContent = "";
  m.steps.forEach((st, i) => {
    const row = document.createElement("div");
    row.className = "macro-step";
    row.dataset.i = String(i);

    const n = document.createElement("span");
    n.className = "mono step-n";
    n.textContent = String(i + 1);

    const key = document.createElement("button");
    key.textContent = "Key: " + keyName(st.usage);
    key.title = "Change the key";
    key.onclick = () => openKeyModal(usage => {
      editMacro(m.id, mm => { mm.steps[i].usage = usage; });
      renderMacroForm();
    });

    const lbl = document.createElement("label");
    lbl.className = "mono";
    lbl.textContent = "delay";

    const delay = document.createElement("input");
    delay.type = "number";
    delay.min = "0"; delay.max = "255"; delay.step = "5";
    delay.value = String(st.delay);
    delay.title = "Milliseconds the key stays pressed";
    delay.oninput = () => {
      const v = Math.max(0, Math.min(255, Math.round(Number(delay.value) || 0)));
      editMacro(m.id, mm => { mm.steps[i].delay = v; });
    };

    const ms = document.createElement("span");
    ms.className = "mono";
    ms.textContent = "ms";

    const move = (delta, glyph, title) => {
      const b = document.createElement("button");
      b.className = "move";
      b.textContent = glyph;
      b.title = title;
      b.disabled = delta < 0 ? i === 0 : i === m.steps.length - 1;
      b.onclick = () => {
        editMacro(m.id, mm => { const [x] = mm.steps.splice(i, 1); mm.steps.splice(i + delta, 0, x); });
        renderMacroForm();
      };
      return b;
    };

    const drop = document.createElement("button");
    drop.className = "drop ghost";
    drop.textContent = "✕";
    drop.title = "Remove this step";
    drop.onclick = () => { editMacro(m.id, mm => mm.steps.splice(i, 1)); renderMacroForm(); };

    row.append(n, key, lbl, delay, ms, move(-1, "↑", "Move up"), move(1, "↓", "Move down"), drop);
    box.appendChild(row);
  });

  $("btnMacroAddStep").disabled = m.steps.length >= MAX_STEPS;
  const bytes = stepsStream(m.steps);
  $("macroBytes").textContent = bytes.length
    ? `stream ${bytes.length} B: ` + g6.toHex(bytes).replace(/(..)/g, "$1 ").trim()
    : "stream: no steps yet";
}

// ---------------------------------------------------------------- luces
// El bloque LED de la imagen (0x1C, 0x1D, 0x20–0x31, 0x3A, 0x3E, 0x3F) está
// descifrado y contrastado con el config.ini del fabricante (PROTOCOL §5-quater).
// Los controles se crean una vez y sólo se sincronizan: si se reconstruyeran en
// cada render, arrastrar un slider perdería el foco.
const ledRows = { user: [], dpi: [] };

const currentLed = () => readLed(applyEdits(state.mem, state.edits, state.macros));

// Los canales del ratón son de 4 bits: el selector nativo da 8, así que se
// cuantiza a los 16 niveles que caben (v * 17) y se le devuelve al control el
// valor exacto que se va a escribir.
const toNibble = v => Math.max(0, Math.min(LED_MAX, Math.round(v / 17)));
const toHex = c => "#" + [c.r, c.g, c.b].map(n => (Math.min(LED_MAX, n) * 17).toString(16).padStart(2, "0")).join("");
const fromHex = h => ({
  r: toNibble(parseInt(h.slice(1, 3), 16) || 0),
  g: toNibble(parseInt(h.slice(3, 5), 16) || 0),
  b: toNibble(parseInt(h.slice(5, 7), 16) || 0),
});

function setLed(patch) {
  state.edits.led = { ...currentLed(), ...patch };
  state.dirty = true;
  render();
}

function buildLedRows() {
  if (ledRows.user.length) return;
  for (const [kind, count, host] of [["user", LED_USER_COUNT, "ledUser"], ["dpi", LED_DPI_COUNT, "ledDpi"]]) {
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.className = "led-row";
      const name = document.createElement("span");
      name.className = "led-name";
      name.textContent = kind === "user" ? `Colour ${i + 1}` : `Stage ${i + 1}`;

      const picker = document.createElement("input");
      picker.type = "color";
      picker.title = `${kind === "user" ? "Colour" : "Stage"} ${i + 1}`;
      const val = document.createElement("b");
      val.className = "led-val";

      const write = c => {
        const led = currentLed();
        setLed({ [kind]: led[kind].map((x, k) => (k === i ? c : x)) });
      };
      picker.oninput = () => {
        const c = fromHex(picker.value);
        val.textContent = `${c.r} ${c.g} ${c.b}`;
        write(c);
      };
      // al soltar, el control muestra el color cuantizado, no el que se pidió
      picker.onchange = () => { picker.value = toHex(fromHex(picker.value)); };

      row.append(picker, name, val);

      let cycle = null;
      if (kind === "user") {
        const label = document.createElement("label");
        label.className = "ch";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.title = `Use colour ${i + 1} in the cycling effects`;
        const txt = document.createElement("i");
        txt.textContent = "cycle";
        box.onchange = () => {
          const mask = currentLed().cycle & ~(1 << i);
          setLed({ cycle: mask | (box.checked ? 1 << i : 0) });
        };
        label.append(box, txt);
        row.appendChild(label);
        cycle = box;
      }

      ledRows[kind].push({ picker, val, cycle });
      $(host).appendChild(row);
    }
  }
}

function renderLeds(led) {
  if (!led) return;
  const sel = $("ledMode");
  if (!sel.options.length) {
    for (const id of LED_MODE_IDS) {
      const o = document.createElement("option");
      o.value = String(id);
      o.textContent = LED_MODES[id];
      sel.appendChild(o);
    }
  }
  // un id fuera de 8–15 es una configuración que este firmware no conoce (p. ej.
  // lo que escribían versiones anteriores del configurador): se marca como tal
  const known = LED_MODE_IDS.includes(led.mode);
  sel.value = known ? String(led.mode) : "";
  sel.classList.toggle("unknown", !known);
  $("ledModeRaw").textContent = `0x${Number(led.raw ?? led.mode << 4).toString(16).padStart(2, "0")}`;
  $("ledBright").value = String(led.brightness);
  $("ledBrightVal").textContent = String(led.brightness);
  $("ledSymmetry").checked = led.symmetry;
  $("ledDirection").checked = led.direction;

  for (const kind of ["user", "dpi"]) {
    (led[kind] || []).forEach((c, i) => {
      const row = ledRows[kind][i];
      if (!row) return;
      if (document.activeElement !== row.picker) row.picker.value = toHex(c);
      row.val.textContent = `${c.r} ${c.g} ${c.b}`;
      if (row.cycle) row.cycle.checked = !!(led.cycle & (1 << i));
    });
  }
}

// ---------------------------------------------------------------- wiring
$("btnConnect").onclick = () => connect(false);
$("btnConnectAll").onclick = () => connect(true);
$("btnDefaults").onclick = () => loadDefaults(true);
$("btnLoadSaved").onclick = revertSaved;
$("btnForget").onclick = forgetSaved;
$("btnApply").onclick = apply;
$("btnApplyMacros").onclick = apply;
$("btnApplyLeds").onclick = apply;
$("ledMode").onchange = () => setLed({ mode: Number($("ledMode").value) });
$("ledBright").oninput = () => setLed({ brightness: Number($("ledBright").value) });
$("ledSymmetry").onchange = () => setLed({ symmetry: $("ledSymmetry").checked });
$("ledDirection").onchange = () => setLed({ direction: $("ledDirection").checked });
$("btnMacroNew").onclick = newMacro;
$("btnMacroDelete").onclick = deleteMacro;
$("btnMacroAddStep").onclick = () => {
  const m = macroById(macroSel);
  if (!m || m.steps.length >= MAX_STEPS) return;
  editMacro(m.id, mm => mm.steps.push({ usage: 0x04, delay: 10 }));
  renderMacroForm();
};
$("macroName").oninput = () => {
  const m = macroById(macroSel);
  if (!m) return;
  editMacro(m.id, mm => { mm.name = $("macroName").value.slice(0, 40); });
};
$("btnKeyCancel").onclick = () => { closeKeyModal(); render(); };
$("btnKeyUse").onclick = useCapturedKey;
$("keyModal").onclick = e => { if (e.target.id === "keyModal") { closeKeyModal(); render(); } };
$("pauseMs").oninput = () => {
  const v = Number($("pauseMs").value);
  state.pause = Number.isFinite(v) ? Math.max(0, Math.min(50, v)) : 2;
  setStatus(`delay ${state.pause} ms`, "");
};
$("btnBackup").onclick = backup;
$("btnRestore").onclick = () => $("fileRestore").click();
$("fileRestore").onchange = e => {
  const f = e.target.files[0];
  if (f) importConfig(f);
  e.target.value = "";   // permite volver a importar el mismo fichero
};
$("btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("device").textContent); setStatus("diagnostic copied", "ok"); }
  catch { setStatus("could not copy", "warn"); }
};

window.addEventListener("beforeunload", e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

if (!navigator.hid) {
  selectTab("main");
  $("btnConnect").disabled = true;
  // #intro está vacío y oculto: sólo aparece cuando de verdad no se puede conectar
  if ($("intro")) $("intro").hidden = false;
  if (!window.isSecureContext) {
    // http:// on a LAN IP is not a secure context: WebHID does not exist there.
    const httpsURL = location.hostname && location.port === "8099"
      ? `https://${location.hostname}:8443${location.pathname}`
      : null;
    setStatus("WebHID needs https: this URL is not secure", "err");
    $("intro").innerHTML =
      "Browsers only expose WebHID in secure contexts (<b>https</b>, <b>localhost</b> " +
      "or a file opened by double click). You are on <span class=\"mono\">" +
      location.origin + "</span>, so the mouse cannot be opened from here." +
      (httpsURL ? `<br>Open <a href="${httpsURL}"><b>${httpsURL}</b></a> (accept the certificate warning).` : "") +
      "<br>Or copy <span class=\"mono\">dist/S700-configurador.html</span> and open it by double click.";
  } else {
    setStatus("WebHID unavailable: use Chrome, Edge, Brave or Opera", "err");
    $("intro").innerHTML = "This browser cannot talk to the mouse. Open it in " +
      "<b>Chrome, Edge, Brave, Opera, Vivaldi or Arc</b>. Firefox and Safari do not implement WebHID.";
  }
}

// reconectar si el usuario ya dio permiso antes
if (navigator.hid) {
  (async () => {
    try {
      const devices = await navigator.hid.getDevices();
      const dev = devices.find(isVendorDevice) || devices[0];
      if (dev) {
        if (!dev.opened) await dev.open();
        state.dev = dev;
        state.bytes = g6.reportBytes(dev);
        renderDevice();
        setStatus(`${dev.productName || "device"} already authorized`, "ok");
        await read();
      }
    } catch { /* sin permiso previo */ }
  })();
}

navigator.hid?.addEventListener("disconnect", e => {
  if (state.dev && e.device === state.dev) { state.dev = null; state.ready = false; setStatus("disconnected", "warn"); renderDevice(); render(); }
});

// Hook de depuración: expone el estado vivo del configurador para poder
// mirarlo desde la consola o desde web/debug.js (lo inyecta tools/debugd.py al
// servir la página; dist/S700-configurador.html no lo lleva).
window.__s700 = {
  state, g6,
  macros: () => state.macros,
  cfg: () => readConfig(applyEdits(state.mem, state.edits, state.macros), state.macros),
  render: () => render(),
  read: () => read(),
  apply: () => apply(),
};

initTabs();
renderHotspots();
// La base es lo último que guardaste en este navegador; si no hay nada, la imagen
// de fábrica que trae la app (el ratón no se puede leer).
// Arranque: si quedó trabajo sin enviar se recupera tal cual (con su base), si no
// la última configuración guardada y, si no hay nada, la imagen de fábrica.
function restoreOnLoad() {
  const work = store.loadWorkspace();
  const rec = work ? null : store.loadConfig();
  const base = work ? work.mem : rec ? rec.mem : stockImage();
  const full = new Uint8Array(MEM_SIZE);
  full.set(base.subarray(0, MEM_SIZE));
  state.mem = full;
  state.ready = true;
  state.edits = work ? (work.edits || {}) : {};
  state.dirty = !!work;
  state.macros = store.loadMacros();
  macroSel = state.macros.length ? state.macros[0].id : null;
  setStatus(work
    ? `restored the unsent changes kept in this browser (${fmtWhen(work.savedAt)}) · Apply to write them`
    : rec
      ? `loaded the configuration saved in this browser (${fmtWhen(rec.savedAt)})`
      : "factory configuration loaded · no saved configuration", "ok");
  render();
  renderMacroForm();
}

buildLedRows();
restoreOnLoad();
renderStorage();
