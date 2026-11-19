// S700 configurator: WebHID + WebHID fallback + diagnostics.
// All in the browser: finds the mouse, reads its memory, lets you edit it and
// rewrites the same blocks the vendor tool writes.
import * as g6 from "./g6.js";
import {
  readConfig, applyEdits, planWrites, hexdump, ACTIONS, MEDIA_CHOICES, DPI_CHOICES, BUTTON_LABEL, BUTTONS,
  macroValue, macroStream, MAX_STEPS, readLed, arenaUsage,
} from "./core.js";
import {
  LED_EFFECTS, LED_DIRECTIONS, LED_REACT_NAMES, LED_MAX, LED_USER_COUNT, LED_DPI_COUNT,
} from "./g6.js";
import { DEFAULT_MEM_HEX } from "./default_image.js";
import * as store from "./storage.js";
import { keyName, usageFromEventCode } from "./g6.js";

const MEM_SIZE = 0x568;   // how far the vendor tool writes (0x0008–0x0567)
// This firmware can be written but not read (docs/PROTOCOL.md §4), so there is
// no read state: the base is always the factory image or a backup.
const state = {
  dev: null, mem: new Uint8Array(MEM_SIZE), ready: false, dirty: false, edits: {},
  bytes: g6.DATA_LEN, pause: 2,
  macros: [],          // list kept in this browser (see the Macros tab)
};

// Debug panel probe: bytes forced AFTER the edits are applied,
// to look at fields the UI does not expose. They are never saved anywhere.
const pokes = new Map();          // address -> byte

const $ = id => document.getElementById(id);
const statusEl = $("status"), logEl = $("log"), hexEl = $("hex"), barEl = $("bar");

// image = base + edits + Debug panel probes
function imgNow() {
  const img = applyEdits(state.mem, state.edits, state.macros);
  for (const [addr, val] of pokes) img[addr] = val;
  return img;
}

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls;
}

// The log is buffered and flushed every 120 ms: writing to the DOM for each
// of the 1280 frames in a dump makes the read 3-4 times slower.
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

// loose text line in the HID traffic panel (for messages, not frames)
function logText(line) {
  logBuf.push(line + "\n");
  logCount++;
  if (!logTimer) logTimer = setTimeout(flushLog, 120);
}

// Vendor memory image (its factory config.ini, captured from the EXE).
// It is the only reliable base: this firmware implements SetFeature but does not
// answer GetFeature, so what the mouse holds right now cannot be read.
function stockImage() {
  const img = g6.fromHex(DEFAULT_MEM_HEX);
  const full = new Uint8Array(MEM_SIZE);
  full.set(img.subarray(0, MEM_SIZE));
  return full;
}

// Browser storage status row.
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

// Every pending change is saved to the browser right away (there is no save
// button): reloading the page does not lose it and the file is only needed to
// carry the configuration elsewhere. The image is saved WITH the changes, but
// without folding them into state.mem: `dirty` still means "not sent to the mouse".
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

// Goes back to the committed configuration (the last one written to the mouse or
// imported) and drops the unsent changes. With nothing saved, to the factory one.
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

// Factory image in the selects. With `pending` (the button) it stays as an unsent
// change: the user decides whether to send it with Apply. At startup with nothing
// saved it is loaded without marking changes.
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

// This firmware does not answer GetFeature (§4), so there is nothing to read: the
// base is the image saved in the browser or the factory one. The function exists
// because the connect path calls it; it used to be undefined and connecting
// ended in «connect error: read is not defined» even though the device had
// opened fine.
async function read() {
  const msg = "nothing to read: this mouse does not answer GetFeature (see PROTOCOL §4)";
  logText("read · " + msg);
  return msg;
}

// No read-back is possible (the firmware does not answer GetFeature), so the only
// thing that can be stated is how many blocks were sent and without error.
function reportWrite(blocks) {
  state.lastWrite = { blocks, at: Date.now() };
  setStatus(`written ${blocks} blocks · not verifiable: this mouse cannot be read`, "ok");
}

// The write bar is the same in every tab that sends the image.
function progress(done, total) {
  for (const bar of document.querySelectorAll(".bar")) {
    bar.classList.add("on");
    bar.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
    if (done >= total) setTimeout(() => { bar.classList.remove("on"); bar.firstElementChild.style.width = "0"; }, 250);
  }
}

// ---------------------------------------------------------------- device
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
  // No filter by vendorId: the mouse exposes two interfaces (mouse and
  // configuration) with the same VID:PID and the dialog shows them alike, so the
  // user ended up picking the mouse one. Collections 0xFF00/0xFF01
  // identify the right one and leave a single entry in the dialog.
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
    // If the dialog returns several, the one declaring feature report 7 is
    // preferred; if it does not open, the rest are tried before giving up.
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
    render();          // the Apply state depends on there being a device
    await read();
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/No device selected|NotFoundError/i.test(msg)) {
      setStatus("no matching devices found", "warn");
      $("btnConnectAll").hidden = false;
      $("hintAll").hidden = false;
      selectTab("debug");   // the diagnostic and the broad search live there
    } else if (/Failed to open|Permission denied|Access denied/i.test(msg)) {
      setStatus("connect error: " + msg, "err");
      // Always happens on Linux while /dev/hidrawN is root:root 0600, and on
      // Windows if the vendor program holds the mouse open.
      $("device").textContent = openHelp(msg);
      selectTab("debug");   // see the diagnostic without having to look for it
    } else {
      setStatus("connect error: " + msg, "err");
    }
  }
}

// Positions of the numbers 1..10 over the picture (web/mouse.png), in % of the
// width and height: the vendor tool's originals
// (skin_main_en.ini, [BUTTONPOS] 35..44) corrected onto the new view, which
// frames the mouse a bit further right. Checked by overlaying them.
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
  // The image is painted WITH the pending changes: otherwise, on repaint the select
  // goes back to the mouse value and the change looks like it was not made.
  const cfg = readConfig(imgNow(), state.macros);

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
    td2.className = "fn";          // the only cell that can give up width
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    // if the mouse holds a code we cannot represent, it is shown as it is
    none.textContent = btn.action ? "(unassigned)"
      : g6.MACRO_CODES.includes(btn.code) ? "(macro · not in the list)"
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
    // the advanced action record slots are only measured in
    // profile 1, so the other profiles only offer the 20 functions
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
    // saved macros: the mouse runs the stream by itself (profile 1 only)
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
      if (sel.value === "k") {                                  // opens the capture modal
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

  const shown = imgNow();   // what would be sent right now
  hexEl.textContent = !state.ready
    ? "(nothing loaded yet)"
    : hexdump(shown, 0, 0x80) + "\n…\n" +
      hexdump(shown, 0x0a0, 0x1a0) + "\n…\n" + hexdump(shown, 0x400, 0x568);

  $("btnDefaults").disabled = false;
  // Apply ALWAYS sends the whole image, so there do not have to be changes:
  // it also serves to dump an already saved configuration into a new mouse.
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

  // if an edit did not fit in the 0x400 block, the select goes back to the old one:
  // warn instead of letting it look like the change was made
  const pending = state.edits.buttons || {};
  const failed = cfg.buttons.filter(b => pending[b.i] !== undefined && b.action !== pending[b.i]);
  const warn = $("cfgWarn");
  if (failed.length) {
    const msg = `No room for button${failed.length === 1 ? "" : "s"} ` +
      `${failed.map(b => b.i + 1).join(", ")} in the mouse's macro block (192 B) — ` +
      `remove a macro or key, or lower “copies per key” in Debug`;
    setStatus(msg, "warn");
    warn.textContent = msg;
    warn.hidden = false;
  } else {
    warn.hidden = true;
    warn.textContent = "";
  }

  // how a keyboard key is written: hold (default), one tap when
  // pressed, or taps while it is held.
  const keyMode = ["tap", "repeat"].includes(state.edits.keyMode) ? state.edits.keyMode : "hold";
  const modeEl = $("keyMode");
  if (document.activeElement !== modeEl) modeEl.value = keyMode;
  const pairs = Number(state.edits.repeatPairs) || g6.REPEAT_PAIRS;
  const perKey = keyMode === "repeat" ? 2 + pairs * 4
    : keyMode === "hold" ? g6.HOLD_STREAM_LEN : 8;
  const fit = Math.floor(g6.STREAM_SIZE / (Math.ceil(perKey / 8) * 8));
  const slotEl = $("slotMode");
  if (slotEl && document.activeElement !== slotEl) {
    const m = Number.isFinite(Number(state.edits.slotMode)) ? Number(state.edits.slotMode) : 0x04;
    slotEl.value = (m & 0xff).toString(16).padStart(2, "0");
  }
  $("keyModeHint").textContent =
    keyMode === "repeat" ? `${perKey} B per key (${pairs} down/up pairs) · about ${fit} keys in the block`
    : keyMode === "hold" ? `${perKey} B per key (${g6.HOLD_COPIES} copies) · about ${fit} keys · run until release (0x2e)`
    : `${perKey} B per key · about ${fit} keys in the block`;

  renderMacroList();

  // any pending change is persisted in the browser (it does not touch the mouse)
  if (state.dirty) scheduleAutosave();
}

function countEdits() {
  const b = Object.keys(state.edits.buttons || {}).length;
  const d = Object.keys(state.edits.dpi || {}).length;
  const p = state.edits.profile === undefined ? 0 : 1;
  const l = state.edits.led ? 1 : 0;
  return b + d + p + l;
}

// ------------------------------------------------------- key capture
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

// ---------------------------------------------------------------- actions
async function apply() {
  if (!state.dev || !state.ready) return;
  try {
    const img = imgNow();
    // The full image is ALWAYS sent, like the vendor tool. Writing only the
    // touched blocks leaves the pointer table at 0x006E stale and the
    // mouse discards the change (checked on hardware on 17/11/2026: with the
    // whole image the configuration does take effect).
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
    // what the mouse just received is what is worth keeping, and there are
    // no pending changes any more
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
  // What is on screen is exported, not just the base: pending changes
  // live in state.edits, so without folding them in the file came out stale.
  const data = {
    tool: "s700-webhid", version: 1, date: new Date().toISOString(), size: MEM_SIZE,
    // the stamp and the state go in the file: that way you know which build made it
    // and whether it carried unsent changes, without having to ask.
    build: window.__S700_BUILD__ || "dev",
    dirty: !!state.dirty,
    pendingEdits: Object.keys(state.edits.buttons || {}).length,
    connected: !!state.dev,
    mem: g6.toHex(imgNow()),
    macros: state.macros,   // the stream is already in the image; this is name and steps
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `s700-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Import does NOT write to the mouse: it leaves the file's image in the editor (and
// in the browser) to review it and send it with Apply, like any other change.
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
  selectTab("main");   // the selects are there: review and Apply
  setStatus("configuration imported · review it and press Apply to write it to the mouse", "ok");
}


// ---------------------------------------------------------------- tabs
// The page is split into two views: the configurator and the debug scaffolding.
// The active tab lives in the hash (#debug) so that reloading does not change it;
// some browsers do not allow replaceState on file://, so it is wrapped.
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
  const wanted = location.hash.slice(1) || "main";
  selectTab(PANELS.includes(wanted) ? wanted : "main");
}

// ---------------------------------------------------------------- macros
// A macro is a list of key steps the mouse runs by itself. The list
// (name + steps) is saved in this browser; its byte stream is written into
// the image and travels to the mouse with Apply (docs/PROTOCOL.md §5-ter).
let macroSel = null;

const newMacroId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const macroById = id => state.macros.find(m => m.id === id) || null;
const macroUsers = (cfg, id) => cfg.buttons.filter(b => b.action === macroValue(id)).map(b => b.i + 1);

function cfgNow() { return readConfig(imgNow(), state.macros); }

function saveMacros() {
  if (!store.saveMacros(state.macros)) setStatus("could not save the macros in this browser", "warn");
}

// The buttons that already ran this macro are reassigned so Apply rewrites their
// stream: the bytes live in the image and do not follow edits to the definition.
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
  const beforeBytes = String(macroStream(m));
  mutate(m);
  saveMacros();
  // only if the bytes change is there anything to rewrite in the mouse (renaming is not)
  if (String(macroStream(m)) !== beforeBytes) touchMacroUsers(id, before);
  render();
}

function newMacro() {
  const m = { id: newMacroId(), name: "", repeat: "release", count: 1,
    steps: [{ kind: "key", usage: 0x04, delay: 10 }] };
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
  // the buttons that ran it go back to whatever the image holds:
  // the pending edit is removed so as not to leave a phantom change
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
  // the limit is not the steps: it is the 192 B arena, shared with the keys
  const used = state.macros.reduce((n, m) => n + (macroUsers(cfg, m.id).length ? m.steps.length : 0), 0);
  const arena = arenaUsage(state.mem, state.edits, state.macros);
  const over = arena.wanted > arena.size;
  $("macroSpace").textContent = !used
    ? `arena ${arena.bytes} / ${arena.size} B · nothing assigned`
    : `arena ${arena.bytes} / ${arena.size} B · ${used} step${used === 1 ? "" : "s"}` +
      (over ? ` · needs ${arena.wanted} B` : "");
  $("macroSpace").className = "mono hint" + (over ? " warn" : "");
}

function paintMacroBytes(m) {
  const bytes = macroStream(m);
  $("macroBytes").textContent = bytes.length
    ? `stream ${bytes.length} B: ` + g6.toHex(bytes).replace(/(..)/g, "$1 ").trim()
    : "stream: no steps yet";
}

function renderMacroForm() {
  const m = macroById(macroSel);
  if (!m) macroSel = null;
  $("macroEmpty").hidden = !!m;
  $("macroForm").hidden = !m;
  if (!m) return;
  if (document.activeElement !== $("macroName")) $("macroName").value = m.name;

  const repeat = m.repeat || "on";
  for (const r of document.querySelectorAll('input[name="macroRepeat"]')) r.checked = r.value === repeat;
  if (document.activeElement !== $("macroCount")) $("macroCount").value = String(m.count ?? 1);
  $("macroCount").disabled = repeat !== "on";

  const box = $("macroSteps");
  box.textContent = "";
  m.steps.forEach((st, i) => {
    const kind = st.kind || "key";
    const row = document.createElement("div");
    row.className = "macro-step";
    row.dataset.i = String(i);

    const n = document.createElement("span");
    n.className = "mono step-n";
    n.textContent = String(i + 1);

    const kindSel = document.createElement("select");
    kindSel.className = "kind";
    for (const [v, label] of [["key", "Key"], ["mouse", "Mouse"], ["move", "Move"], ["dpi", "DPI"], ["delay", "Delay"]]) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      if (v === kind) o.selected = true;
      kindSel.appendChild(o);
    }
    kindSel.onchange = () => {
      const defaults = {
        key: { kind: "key", usage: 0x04, delay: 10 },
        mouse: { kind: "mouse", button: "left", dir: "down" },
        move: { kind: "move", x: 0, y: 10 },
        dpi: { kind: "dpi", dpi: 800, reset: false },
        delay: { kind: "delay", ms: 10 },
      };
      editMacro(m.id, mm => { mm.steps[i] = defaults[kindSel.value]; });
      renderMacroForm();
    };

    const fields = [];
    const msLabel = () => {
      const s = document.createElement("span");
      s.className = "mono";
      s.textContent = "ms";
      return s;
    };
    const num = (value, min, max, step, title, oninput) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = String(min); inp.max = String(max); inp.step = String(step);
      inp.value = String(value); inp.title = title;
      inp.oninput = () => oninput(Number(inp.value));
      return inp;
    };

    if (kind === "key") {
      const key = document.createElement("button");
      key.textContent = "Key: " + keyName(st.usage);
      key.title = "Change the key";
      key.onclick = () => openKeyModal(usage => {
        editMacro(m.id, mm => { mm.steps[i].usage = usage; });
        renderMacroForm();
      });
      // tap = down and up in the same step; separate down and up are the shape
      // the vendor tool uses to leave a key held («Run until release»)
      const dir = document.createElement("select");
      dir.className = "keydir";
      for (const [v, label] of [["tap", "Tap"], ["down", "Down"], ["up", "Up"]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        if ((st.dir || "tap") === v) o.selected = true;
        dir.appendChild(o);
      }
      dir.onchange = () => {
        editMacro(m.id, mm => {
          if (dir.value === "tap") delete mm.steps[i].dir;
          else mm.steps[i].dir = dir.value;
        });
        renderMacroForm();
      };
      fields.push(key, dir);
      if ((st.dir || "tap") === "tap") {
        fields.push(
          num(st.delay ?? 10, 0, 255, 5, "Milliseconds the key stays pressed",
            v => editMacro(m.id, mm => { mm.steps[i].delay = Math.max(0, Math.min(255, Math.round(v) || 0)); })),
          msLabel());
      }
    } else if (kind === "mouse") {
      const b = document.createElement("select");
      for (const [v, label] of [["left", "Left"], ["middle", "Middle"], ["right", "Right"]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        if ((st.button || "left") === v) o.selected = true;
        b.appendChild(o);
      }
      b.onchange = () => { editMacro(m.id, mm => { mm.steps[i].button = b.value; }); renderMacroForm(); };
      const d = document.createElement("select");
      for (const [v, label] of [["down", "Down"], ["up", "Up"]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = label;
        if ((st.dir || "down") === v) o.selected = true;
        d.appendChild(o);
      }
      d.onchange = () => { editMacro(m.id, mm => { mm.steps[i].dir = d.value; }); renderMacroForm(); };
      fields.push(b, d);
    } else if (kind === "move") {
      fields.push(
        num(st.x ?? 0, -32768, 32767, 1, "Horizontal movement (negative = left)",
          v => editMacro(m.id, mm => { mm.steps[i].x = Math.round(v) || 0; })),
        num(st.y ?? 0, -32768, 32767, 1, "Vertical movement (negative = up)",
          v => editMacro(m.id, mm => { mm.steps[i].y = Math.round(v) || 0; })));
    } else if (kind === "dpi") {
      const sel = document.createElement("select");
      for (const c of DPI_CHOICES) {
        const o = document.createElement("option");
        o.value = String(c.dpi); o.textContent = c.dpi + " DPI";
        if ((st.dpi || 800) === c.dpi) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => { editMacro(m.id, mm => { mm.steps[i].dpi = Number(sel.value); }); renderMacroForm(); };
      const chk = document.createElement("label");
      chk.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !!st.reset;
      cb.onchange = () => { editMacro(m.id, mm => { mm.steps[i].reset = cb.checked; }); renderMacroForm(); };
      chk.append(cb, document.createTextNode("restore"));
      fields.push(sel, chk);
    } else if (kind === "delay") {
      fields.push(
        num(st.ms ?? 10, 0, 510, 2, "Milliseconds to wait",
          v => editMacro(m.id, mm => { mm.steps[i].ms = Math.max(0, Math.min(510, Math.round(v) || 0)); })),
        msLabel());
    }

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

    row.append(n, kindSel, ...fields, move(-1, "↑", "Move up"), move(1, "↓", "Move down"), drop);
    box.appendChild(row);
  });

  $("btnMacroAddStep").disabled = m.steps.length >= MAX_STEPS;
  paintMacroBytes(m);
}

// ---------------------------------------------------------------- lights
// The LED block of the image (0x1C, 0x1D, 0x20–0x31, 0x3A, 0x3E, 0x3F) is
// decoded and cross-checked against the vendor config.ini (PROTOCOL §5-quater).
// The controls are built once and only synced: if they were rebuilt on
// every render, dragging a slider would lose focus.
const ledRows = { user: [], dpi: [] };
const ledDirRows = [];
let ledSpeed = 4;            // last "speed" chosen: does not drag the fixed nibble of Button response / Mute

const currentLed = () => readLed(imgNow());

// The mouse channels are 4-bit: the native picker gives 8, so it is
// quantised to the 16 levels that fit (v * 17) and the control is handed back
// the exact value that is going to be written.
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
      // on release, the control shows the quantised colour, not the one requested
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
          const mask = currentLed().mask & ~(1 << i);
          setLed({ mask: mask | (box.checked ? 1 << i : 0) });
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

// direction (0x3A bits 4–5): the vendor tool offers two, three or four options
// depending on the effect; the four radios are built once and the spare ones hidden
function buildLedDirs() {
  if (ledDirRows.length) return;
  LED_DIRECTIONS.forEach((name, k) => {
    const label = document.createElement("label");
    label.className = "ch";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "ledDir";
    input.value = String(k);
    input.onchange = () => setLed({ direction: k });
    const txt = document.createElement("i");
    txt.textContent = name;
    label.append(input, txt);
    $("ledDirs").appendChild(label);
    ledDirRows.push({ label, input });
  });
}

// "Button response": one animation per button, in bits 7–6 of its action byte
function buildLedReact() {
  const host = $("ledReact");
  if (!host || host.childElementCount) return;
  for (const { i } of BUTTONS) {
    const row = document.createElement("div");
    row.className = "led-row";
    const name = document.createElement("span");
    name.className = "led-name";
    name.textContent = BUTTON_LABEL[i];
    const sel = document.createElement("select");
    const off = document.createElement("option");
    off.value = "off";
    off.textContent = "— off —";
    sel.appendChild(off);
    LED_REACT_NAMES.forEach((n, k) => {
      const o = document.createElement("option");
      o.value = String(k);
      o.textContent = `${k + 1}. ${n}`;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      const led = currentLed();
      const on = sel.value !== "off";
      const type = on ? Number(sel.value) : 0;
      setLed({ react: led.react.map(r => (r.i === i ? { ...r, on, type } : r)) });
    };
    row.append(name, sel);
    host.appendChild(row);
  }
}

const LED_HINT = {
  react: "Each button runs its animation while it is held. The choice is stored in bits 7–6 of that " +
    "button's action byte, which is the same byte the Button tab writes (that one uses bits 4–0), so the " +
    "two do not fight. <b>off</b> clears those bits and the vendor's enable bit 5, exactly as its own tool " +
    "writes it; if a button stops responding, choose an animation again and Apply.",
  none: "This effect has no options in the vendor tool: picking it only changes the id in <span class=\"mono\">0x1C</span>.",
};

function ledHint(opts) {
  if (opts.has("react")) return LED_HINT.react;
  if (!opts.size) return LED_HINT.none;
  const bits = [];
  if (opts.has("speed")) bits.push("<b>speed</b> (low nibble of <span class=\"mono\">0x1C</span>, 0–7)");
  if (opts.has("bright")) bits.push("<b>brightness</b> (high nibble of <span class=\"mono\">0x3F</span>; 0 is the factory value and the one that lights the mouse at full level)");
  if (opts.has("colours")) bits.push("the <b>seven colours</b> and the cycle mask of <span class=\"mono\">0x1D</span>");
  if (opts.has("symmetry")) bits.push("<b>symmetry</b> (<span class=\"mono\">0x3A</span> bit 6)");
  if (opts.has("dir2") || opts.has("dir3") || opts.has("dir4")) {
    bits.push("<b>direction</b> (<span class=\"mono\">0x3A</span> bits 4–5)");
  }
  return "This effect writes " + bits.join(", ") + ".";
}

function renderLeds(led) {
  if (!led) return;
  const sel = $("ledMode");
  if (!sel.options.length) {
    for (const e of LED_EFFECTS) {
      const o = document.createElement("option");
      o.value = String(e.ini);
      o.textContent = e.name;
      sel.appendChild(o);
    }
  }
  // an effect the tool does not have (id/bank with no name) is flagged as it is
  const eff = LED_EFFECTS.find(e => e.ini === led.effect) || null;
  sel.value = eff ? String(eff.ini) : "";
  sel.classList.toggle("unknown", !eff);
  $("ledModeRaw").textContent =
    `0x${Number(led.raw ?? 0).toString(16).padStart(2, "0")} · ${led.effectName}`;

  const opts = new Set(led.opts || []);
  const dirN = opts.has("dir4") ? 4 : opts.has("dir3") ? 3 : opts.has("dir2") ? 2 : 0;
  $("ledOptBright").hidden = !opts.has("bright");
  $("ledOptSpeed").hidden = !opts.has("speed");
  $("ledOptSym").hidden = !opts.has("symmetry");
  $("ledOptDirs").hidden = dirN === 0;
  ledDirRows.forEach(({ label }, k) => { label.hidden = k >= dirN; });
  $("ledRowFeats").hidden = !opts.has("symmetry") && dirN === 0;
  $("ledOptReact").hidden = !opts.has("react");
  // the vendor tool only shows the seven colours and their boxes in the effects
  // that cycle colours; in the others the colour is fixed and there is nothing to pick
  $("secLedColours").hidden = !opts.has("colours");

  // Button response and Mute keep a fixed cycle nibble: the slider must not
  // drag it along when switching to another effect
  if (!eff || eff.cyc === undefined) ledSpeed = led.speed;

  $("ledBright").value = String(led.brightness);
  $("ledBrightVal").textContent = String(led.brightness);
  $("ledCycle").value = String(ledSpeed);
  $("ledCycleVal").textContent = String(ledSpeed);
  $("ledSymmetry").checked = led.symmetry;
  ledDirRows.forEach(({ input }, k) => { input.checked = k === led.direction && k < dirN; });

  (led.react || []).forEach(r => {
    const row = $("ledReact").children[r.i];
    if (!row) return;
    const s = row.querySelector("select");
    if (s && document.activeElement !== s) s.value = r.on ? String(r.type) : "off";
  });

  for (const kind of ["user", "dpi"]) {
    (led[kind] || []).forEach((c, i) => {
      const row = ledRows[kind][i];
      if (!row) return;
      if (document.activeElement !== row.picker) row.picker.value = toHex(c);
      row.val.textContent = `${c.r} ${c.g} ${c.b}`;
      if (row.cycle) {
        row.cycle.checked = !!(led.mask & (1 << i));
        row.cycle.disabled = !opts.has("colours");   // with no mask there is no cycle to tick
      }
    });
  }

  $("ledHint").innerHTML = ledHint(opts);
}

// ---------------------------------------------------------------- wiring
$("btnConnect").onclick = () => connect(false);
$("btnConnectAll").onclick = () => connect(true);
$("btnDefaults").onclick = () => loadDefaults(true);
$("btnLoadSaved").onclick = revertSaved;
$("btnForget").onclick = forgetSaved;
// Copies the whole image (0x0000–0x0567) as hex, to compare it with the vendor
// capture when something does not add up.
$("btnImageHex").onclick = async () => {
  const img = imgNow();
  const text = Array.from(img, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`image copied to the clipboard (${img.length} bytes)`, "ok");
  } catch (e) {
    $("keyProbeHint").textContent = text.slice(0, 4000);
    setStatus("clipboard blocked: the hex is in the hint box", "warn");
  }
};

// Copies the log of sent frames (one per line), to compare it with the capture.
$("btnLogCopy").onclick = async () => {
  const text = logEl.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`frames copied (${text.split("\n").length} lines)`, "ok");
  } catch { setStatus("clipboard blocked: select the log text by hand", "warn"); }
};

// Probe: writes the G key into buttons 4–7, one shape per button, and applies.
$("btnKeyProbe").onclick = () => {
  state.edits = { keyProbe: 0x0a };
  $("keyProbeHint").textContent = g6.KEY_PROBE_SHAPES
    .map((sh, i) => `${i + 4}: ${sh.name}`).join(" · ");
  apply();
};
$("btnApply").onclick = apply;
$("btnApplyMacros").onclick = apply;
$("btnApplyLeds").onclick = apply;
$("ledMode").onchange = () => setLed({ effect: Number($("ledMode").value), speed: ledSpeed });
$("ledBright").oninput = () => setLed({ brightness: Number($("ledBright").value) });
$("ledCycle").oninput = () => { ledSpeed = Number($("ledCycle").value); setLed({ speed: ledSpeed }); };
$("ledSymmetry").onchange = () => setLed({ symmetry: $("ledSymmetry").checked });
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
for (const r of document.querySelectorAll('input[name="macroRepeat"]')) {
  r.onchange = () => {
    const m = macroById(macroSel);
    if (!m) return;
    editMacro(m.id, mm => { mm.repeat = r.value; if (r.value !== "on") mm.count = 1; });
    renderMacroForm();
  };
}
$("macroCount").oninput = () => {
  const m = macroById(macroSel);
  if (!m) return;
  const v = Math.max(1, Math.min(999, Math.round(Number($("macroCount").value) || 1)));
  editMacro(m.id, mm => { mm.count = v; });
  paintMacroBytes(m);
};
$("btnKeyCancel").onclick = () => { closeKeyModal(); render(); };
$("btnKeyUse").onclick = useCapturedKey;
$("keyModal").onclick = e => { if (e.target.id === "keyModal") { closeKeyModal(); render(); } };
$("slotMode").onchange = () => {
  const v = parseInt($("slotMode").value.replace(/^0x/i, ""), 16);
  state.edits.slotMode = Number.isFinite(v) ? v & 0xff : 0x04;
  $("slotMode").value = state.edits.slotMode.toString(16).padStart(2, "0");
  save(); render();
};
$("keyMode").onchange = () => {
  const v = $("keyMode").value;
  state.edits.keyMode = ["repeat", "hold"].includes(v) ? v : "tap";
  state.dirty = true;
  render();
};

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
  e.target.value = "";   // lets the same file be imported again
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
  // #intro is empty and hidden: it only shows when connecting really is not possible
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
      "<br>Or copy <span class=\"mono\">dist/S700-configurator.html</span> and open it by double click.";
  } else {
    setStatus("WebHID unavailable: use Chrome, Edge, Brave or Opera", "err");
    $("intro").innerHTML = "This browser cannot talk to the mouse. Open it in " +
      "<b>Chrome, Edge, Brave, Opera, Vivaldi or Arc</b>. Firefox and Safari do not implement WebHID.";
  }
}

// reconnect if the user already granted permission before
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
    } catch { /* no previous permission */ }
  })();
}

navigator.hid?.addEventListener("disconnect", e => {
  if (state.dev && e.device === state.dev) { state.dev = null; state.ready = false; setStatus("disconnected", "warn"); renderDevice(); render(); }
});

// ---------------------------------------------------------------- theme (Debug)
// The two skins are two pages over the same app.js, the same ids and the same
// localStorage origin, so switching skin is a navigation to the sibling page —
// never a re-render: the ORIEL page is one long page with no tabs.
function currentTheme() {
  const p = location.pathname;
  return /-eva\.html?$/i.test(p) || /(^|\/)eva(\/|$)/i.test(p) ? "eva" : "classic";
}

// Where the other skin lives, from wherever this page was loaded: the native host
// and the AppImage (`window.__S700_API__`) serve both, a directory serves
// `eva/index.html`, and a double-clicked single file sits next to its twin.
function themeHref(theme) {
  const p = location.pathname;
  if (typeof window.__S700_API__ === "string") return theme === "eva" ? "/eva/" : "/index.html";
  if (/(^|\/)(index\.html?)?$/i.test(p)) return theme === "eva" ? "eva/index.html" : "../index.html";
  return theme === "eva" ? p.replace(/(\.html?)$/i, "-eva$1") : p.replace(/-eva(\.html?)$/i, "$1");
}

// Switching is a page load, so anything pending is written to the browser first:
// the other skin restores it from there, and the mouse is still untouched.
function wireTheme() {
  const sel = $("themeSelect");
  if (!sel) return;
  const here = currentTheme();
  sel.value = here;
  const to = here === "eva" ? "classic" : "eva";
  $("themeHint").textContent = (to === "eva" ? "ORIEL (EVA-01)" : "classic console") + " \u00b7 " + themeHref(to);
  sel.onchange = () => {
    if (sel.value === here) return;
    clearTimeout(autosaveTimer);
    try { if (state.ready) store.saveWorkspace(state.mem, state.edits); } catch { /* go anyway */ }
    location.href = themeHref(sel.value);
  };
}

// stamp of the build that is running, always visible in Debug: if it shows an
// old date, the browser served a cached copy and any test measures the
// previous code.
$("buildInfo").textContent = "build " + (window.__S700_BUILD__ || "dev (unstamped)");

wireTheme();

initTabs();
renderHotspots();
// The base is the last thing you saved in this browser; if there is nothing, the
// factory image the app ships (the mouse cannot be read).
// Startup: if there is unsent work it is restored as is (with its base), otherwise
// the last saved configuration and, if there is nothing, the factory image.
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

// ---------------------------------------------------------------- probe (Debug)
function parseByte(text) {
  const t = String(text).trim();
  if (!t) return null;
  const n = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16)
    : /^[0-9]+$/.test(t) ? parseInt(t, 10)
    : /^[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : NaN;
  return Number.isFinite(n) ? n : null;
}

function renderPokes() {
  const parts = [...pokes].sort((a, b) => a[0] - b[0])
    .map(([addr, val]) => `0x${addr.toString(16).padStart(4, "0")}=0x${val.toString(16).padStart(2, "0")}`);
  $("pokeState").textContent = parts.length ? parts.join("  ") : "(none)";
}

function addPoke() {
  const addr = parseByte($("pokeAddr").value), val = parseByte($("pokeVal").value);
  if (addr === null || addr < 0 || addr >= MEM_SIZE) {
    $("pokeState").textContent = `address must be 0x0000–0x${(MEM_SIZE - 1).toString(16)}`;
    return;
  }
  if (val === null || val < 0 || val > 0xff) {
    $("pokeState").textContent = "value must be a byte (0x00–0xff)";
    return;
  }
  pokes.set(addr, val);
  renderPokes();
  render();                       // so the dump and the tabs reflect it
}

$("btnPoke").onclick = addPoke;
$("btnPokeClear").onclick = () => { pokes.clear(); renderPokes(); render(); };
renderPokes();

// ------------------------------------------------------ permissions (native host)
// On Linux the /dev/hidraw* node belongs to root. If the native host says it cannot
// open it, installing the udev rule is offered: the binary asks for the password with
// pkexec, so nothing has to be copied by hand or the server run as root.
async function checkPermissions() {
  const api = window.__S700_API__;
  if (!api || typeof fetch !== "function" || !$("linPerm")) return;
  let state;
  try {
    state = await (await fetch(`${api}/permissions`)).json();
  } catch (e) {
    return;                        // host without this route (older binary)
  }
  $("linPerm").hidden = !state.needed;
  if (!state.needed) return;
  $("linPermNode").textContent = state.node || "/dev/hidraw*";
  $("linPermState").textContent = state.ruleInstalled
    ? "rule is there but the node is still closed — unplug and replug the mouse"
    : "";
}

$("btnInstallRule").onclick = async () => {
  const api = window.__S700_API__;
  if (!api) return;
  const btn = $("btnInstallRule");
  btn.disabled = true;
  $("linPermState").textContent = "asking for your password…";
  try {
    const res = await (await fetch(`${api}/install-rule`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json();
    $("linPermState").textContent = res.ok
      ? "rule installed — unplug and replug the mouse, then press Connect"
      : (res.log || "could not install the rule");
  } catch (e) {
    $("linPermState").textContent = String(e);
  } finally {
    btn.disabled = false;
  }
};

checkPermissions();

buildLedRows();
buildLedDirs();
buildLedReact();
restoreOnLoad();
renderStorage();
