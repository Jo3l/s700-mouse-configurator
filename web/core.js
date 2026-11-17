// Pure logic for the S700 configurator: decode a device memory image into a
// readable config view and turn user edits back into memory writes.
// No DOM, no WebHID here so it can be tested in node.

import {
  KEY_ADDR, buttonAddr, ACTION_CODE, CODE_ACTION, ACTION_NAME, dpiCode, parseDpi, DPI_TABLE,
  WRITE_BLOCKS, MEDIA, MEDIA_CODE, MEDIA_SLOT, USAGE_MEDIA, mediaRecord, readMedia, MACRO_CODE, KEY_CODES,
  KEY_MACRO_LEN, STEP_LEN, STREAM_BASE, STREAM_SIZE, stepStream, keyMacroRecord, keyName,
  LED, LED_DPI_COUNT, LED_MAX, LED_MODES, LED_MODE_DARK,
} from "./g6.js";

export const BUTTONS = [
  { i: 0, name: "Button 1" }, { i: 1, name: "Button 2" }, { i: 2, name: "Button 3" },
  { i: 3, name: "Button 4" }, { i: 4, name: "Button 5" }, { i: 5, name: "Button 6" },
  { i: 6, name: "Button 7" }, { i: 7, name: "Button 8" }, { i: 8, name: "Button 9" },
  { i: 9, name: "Button 10" },
];

// UI names as the vendor tool shows them, top to bottom.
// The first five are the standard buttons; the rest depend on the model.
export const BUTTON_LABEL = {
  0: "Left", 1: "Right", 2: "Middle", 3: "Forward", 4: "Backward",
  5: "Button 6", 6: "Button 7", 7: "Button 8", 8: "Button 9", 9: "Button 10",
};

// 7..11 (Extend/Media/Macro/ShortCut/Mode) are vendor menu categories, not
// functions: the mouse ends up storing the sub-function, so they are not offered.
export const CATEGORY_IDS = new Set([7, 8, 9, 10, 11]);

export const ACTIONS = Object.keys(ACTION_CODE).map(Number).sort((a, b) => a - b)
  .filter(id => !CATEGORY_IDS.has(id))
  .map(id => ({ id, code: ACTION_CODE[id], name: ACTION_NAME[id] || ("Action " + id) }));

export function actionName(id) {
  if (!id) return "(none)";
  return ACTION_NAME[id] || ("Action " + id);
}

// media keys, as options of the same dropdown (value "m<id>")
export const MEDIA_CHOICES = Object.keys(MEDIA).map(Number).sort((a, b) => a - b)
  .map(id => ({ id, value: "m" + id, usage: MEDIA[id].usage, name: MEDIA[id].name }));

// "12" -> acción básica ; "m26" -> tecla multimedia ; "k20" -> tecla de teclado
// (usage HID) ; "xab12" -> macro guardada (id de la lista de macros)
export const macroValue = id => "x" + id;

export function parseAction(value) {
  if (typeof value === "string" && value.startsWith("m")) return { media: Number(value.slice(1)) };
  if (typeof value === "string" && value.startsWith("k")) return { key: Number(value.slice(1)) };
  if (typeof value === "string" && value.startsWith("x")) return { macro: value.slice(1) };
  return { action: Number(value) };
}

export function describeAction(value, mem, k, macros = []) {
  if (value === "m" || value === undefined || value === null) return "(none)";
  const { media, key, macro } = parseAction(value);
  if (media !== undefined) return MEDIA[media] ? MEDIA[media].name : "Multimedia";
  if (key !== undefined) return "Key: " + keyName(key);
  if (macro !== undefined) {
    const m = macros.find(x => x.id === macro);
    return m ? "Macro: " + (m.name || "(unnamed)") : "(missing macro)";
  }
  return actionName(Number(value));
}

// ---------------------------------------------------------------- macros
// Una macro es una lista de pasos { usage, delay } que el ratón ejecuta solo
// (guardada en el bloque 0x400; ver docs/PROTOCOL.md §5-ter).
export const MAX_STEPS = Math.floor(STREAM_SIZE / STEP_LEN);   // 16

const stepList = macro => (macro && Array.isArray(macro.steps) ? macro.steps : [])
  .filter(s => s && Number.isFinite(Number(s.usage)));

export function stepsStream(steps) {
  const list = (steps || []).filter(s => s && Number.isFinite(Number(s.usage)));
  const out = new Uint8Array(list.length * STEP_LEN);
  list.forEach((s, i) => out.set(stepStream(Number(s.usage), Number(s.delay ?? 10) & 0xff), i * STEP_LEN));
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function macroStream(macro) { return stepsStream(stepList(macro)); }

// Registro 01 02 ff … + flujo, tal como lo escribe el fabricante.
export function readMacroStream(mem, k) {
  const slot = MEDIA_SLOT[k];
  if (slot === undefined) return null;
  if (mem[slot] !== 0x01 || mem[slot + 1] !== 0x02 || mem[slot + 2] !== 0xff) return null;
  const offset = mem[slot + 3] | (mem[slot + 4] << 8);
  const len = mem[slot + 8] | (mem[slot + 9] << 8);
  if (!len || offset + len > STREAM_SIZE) return null;
  const steps = [];
  for (let p = 0; p + STEP_LEN <= len; p += STEP_LEN) {
    const base = STREAM_BASE + offset + p;
    if (mem[base] !== 0x01 || (mem[base + 2] & 0x80) === 0) return null;
    steps.push({ usage: mem[base + 3], delay: mem[base + 4] });
  }
  return { offset, len, steps, bytes: Uint8Array.from(mem.subarray(STREAM_BASE + offset, STREAM_BASE + offset + len)) };
}

// DPI settings the vendor tool lets you pick, with the value it displays
export const DPI_CHOICES = Object.entries(DPI_TABLE).map(([k, v]) => ({ setting: Number(k), dpi: v }))
  .sort((a, b) => a.dpi - b.dpi);

// ------------------------------------------------------------------- LED
// Los colores van en nibbles: 0x20–0x31 llevan 6 pares (color de usuario en el
// alto, color de la etapa de DPI en el bajo) y el 7º color de usuario ocupa
// 0x3E (dos canales) y el bajo de 0x3F, que comparte byte con el brillo.
//
// NIVEL INVERTIDO: el LED es activo a nivel bajo, así que el byte guarda la
// "oscuridad" del canal: enciende con 15 - valor. Comprobado en hardware —
// pedir (15,0,0) saca (0,255,255), pedir (0,15,15) saca rojo puro y pedir
// magenta saca verde. El canal sí está en su sitio (0x20 R, 0x21 G, 0x22 B);
// lo que va al revés es el nivel, así que se invierte aquí y el resto del
// código sigue hablando de {r,g,b} normales.
export const LED_ORDER = ["r", "g", "b"];
const LED_TAIL_ORDER = ["r", "g", "b"];   // 0x3E alto, 0x3E bajo, 0x3F bajo

const hi = (v, n) => (v & 0x0f) | ((n & 0x0f) << 4);
const lo = (v, n) => (v & 0xf0) | (n & 0x0f);
const ch = v => Math.max(0, Math.min(LED_MAX, Math.round(Number(v) || 0)));

// nivel guardado <-> nivel que se ve
const lit = v => LED_MAX - v;

function ledPick(mem, at, low) {
  const out = { r: 0, g: 0, b: 0 };
  LED_ORDER.forEach((chan, k) => {
    const v = mem[at + k];
    out[chan] = lit(low ? (v & 0x0f) : (v >> 4));
  });
  return out;
}

function ledTail(mem) {
  const slots = [mem[LED.user6] >> 4, mem[LED.user6] & 0x0f, mem[LED.bright] & 0x0f];
  const out = { r: 0, g: 0, b: 0 };
  LED_TAIL_ORDER.forEach((chan, k) => { out[chan] = lit(slots[k]); });
  return out;
}

function ledPoke(img, at, c, low) {
  LED_ORDER.forEach((chan, k) => {
    const v = lit(ch(c[chan]));
    img[at + k] = low ? lo(img[at + k], v) : hi(img[at + k], v);
  });
}

export function readLed(mem) {
  const user = [], dpi = [];
  for (let i = 0; i < LED_DPI_COUNT; i++) {
    const at = LED.colours + i * 3;
    user.push(ledPick(mem, at, false));
    dpi.push(ledPick(mem, at, true));
  }
  user.push(ledTail(mem));
  const mode = mem[LED.type] >> 4;
  return {
    mode,
    modeName: LED_MODES[mode] || (LED_MODE_DARK.includes(mode)
      ? `no light (${mode})` : `unknown (${mode})`),
    raw: mem[LED.type],          // el byte tal cual: nibble alto modo, bajo tiempo de ciclo
    brightness: mem[LED.bright] >> 4,
    cycle: mem[LED.cycle] & 0x7f,          // qué colores de los 7 entran en el ciclo
    symmetry: !!(mem[LED.feats] & 0x40),
    direction: !!(mem[LED.feats] & 0x10),  // "clockwise" en la herramienta
    user, dpi,
  };
}

export function applyLed(img, led) {
  if (!led) return img;
  if (led.mode !== undefined) img[LED.type] = hi(img[LED.type], led.mode);
  if (led.cycle !== undefined) img[LED.cycle] = (img[LED.cycle] & 0x80) | (Number(led.cycle) & 0x7f);
  if (led.brightness !== undefined) img[LED.bright] = hi(img[LED.bright], led.brightness);
  if (led.symmetry !== undefined) img[LED.feats] = led.symmetry ? (img[LED.feats] | 0x40) : (img[LED.feats] & ~0x40);
  if (led.direction !== undefined) img[LED.feats] = led.direction ? (img[LED.feats] | 0x10) : (img[LED.feats] & ~0x10);
  (led.user || []).slice(0, LED_DPI_COUNT).forEach((c, i) => ledPoke(img, LED.colours + i * 3, c, false));
  if (led.user && led.user[LED_DPI_COUNT]) {
    const c = led.user[LED_DPI_COUNT];
    const slots = LED_TAIL_ORDER.map(chan => lit(ch(c[chan])));
    img[LED.user6] = hi(img[LED.user6], slots[0]);
    img[LED.user6] = lo(img[LED.user6], slots[1]);
    img[LED.bright] = lo(img[LED.bright], slots[2]);
  }
  (led.dpi || []).forEach((c, i) => {
    if (i < LED_DPI_COUNT) ledPoke(img, LED.colours + i * 3, c, true);
  });
  return img;
}

export function readConfig(mem, macros = []) {
  const profile = (mem[0x0001] >> 5) & 3;
  const buttons = BUTTONS.map(({ i, name }) => {
    const addr = buttonAddr(i, profile);
    const code = addr === undefined ? null : mem[addr];
    // las ranuras de los registros de acciones avanzadas sólo están medidas en el
    // perfil 1; en los demás perfiles se muestra el byte, sin interpretarlo
    const slot = profile === 0 ? MEDIA_SLOT[i] : undefined;
    let value = null, label = "(unknown)", media = null;
    if (addr === undefined) {
      label = "(not editable in this profile)";
    } else if (code === MEDIA_CODE) {
      media = slot === undefined ? null : readMedia(mem, i);
      if (media && media.id) { value = "m" + media.id; label = media.name; }
      else label = media ? media.name : "(media key)";
    } else if (code === MACRO_CODE) {
      // 0x2D = el botón ejecuta el flujo guardado en 0x400: una macro de la lista
      // o, si es de un paso, una tecla suelta (que es como se guardaba antes)
      const ms = slot === undefined ? null : readMacroStream(mem, i);
      const hit = ms && macros.find(m => sameBytes(macroStream(m), ms.bytes));
      if (hit) { value = macroValue(hit.id); label = "Macro: " + (hit.name || "(unnamed)"); }
      else if (ms && ms.steps.length === 1) { value = "k" + ms.steps[0].usage; label = "Key: " + keyName(ms.steps[0].usage); }
      else if (ms && ms.steps.length) label = `(macro · ${ms.steps.length} steps, not in the list)`;
      else label = "(macro · unreadable)";
    } else if (KEY_CODES.includes(code)) {
      label = "(key/shortcut · read-only)";
    } else if (code !== null && code in CODE_ACTION) {
      value = String(CODE_ACTION[code]);
      label = actionName(CODE_ACTION[code]);
    }
    return { i, name, label: BUTTON_LABEL[i], addr, slot, code, action: value, actionName: label, media, profile };
  });
  const dpiCodes = parseDpi([mem[0x15], mem[0x16], mem[0x17]]);
  const dpi = dpiCodes.map((c, i) => {
    const settings = settingsForCode(c);
    const dpis = [...new Set(settings.map(s => DPI_TABLE[s]).filter(Boolean))];
    return { stage: i + 1, code: c, settings, dpi: dpis.length === 1 ? dpis[0] : null };
  });
  return {
    profile, buttons, dpi,
    led: readLed(mem),
    ledType: mem[0x1c],
    usbRate: mem[0x1e],
    brightness: mem[0x3f] >> 4,
    fireTime: mem[0x1a],
    extra: { 0x3b: mem[0x3b], 0x3c: mem[0x3c] },
  };
}

// The device only stores 4 bits per stage, so several settings of the vendor
// config collapse onto the same code once the counter wraps past 15.
export function settingsForCode(code) {
  const out = [];
  for (const s of Object.keys(DPI_TABLE).map(Number)) if (dpiCode(s) === code) out.push(s);
  if (!out.length) for (let s = 0; s < 32; s++) if (dpiCode(s) === code) out.push(s);
  return out;
}

// Tramos del bloque 0x400 que ya usan otras macros (para no pisarlas).
function usedStream(mem, skip) {
  const used = [];
  for (const k of Object.keys(MEDIA_SLOT).map(Number)) {
    if (skip.includes(k)) continue;
    if (mem[KEY_ADDR[k]] !== MACRO_CODE) continue;
    const slot = MEDIA_SLOT[k];
    if (mem[slot] !== 0x01 || mem[slot + 1] !== 0x02 || mem[slot + 2] !== 0xff) continue;
    const off = mem[slot + 3] | (mem[slot + 4] << 8);
    const len = mem[slot + 8] | (mem[slot + 9] << 8);
    if (len) used.push([off, off + len]);
  }
  return used;
}

function freeOffset(used, len) {
  for (let off = 0; off + len <= 0xa8; off++)
    if (used.every(([a, b]) => off + len <= a || off >= b)) return off;
  return -1;
}

// Aplica las ediciones sobre una copia de la imagen del ratón: perfil, botones
// (función básica o tecla multimedia con su registro) y etapas de DPI.
export function applyEdits(mem, edits, macros = []) {
  const img = Uint8Array.from(mem);
  // el perfil al que van las ediciones: el que se acaba de elegir o, si no, el
  // que ya tiene el ratón (cada perfil guarda sus botones en su propio bloque)
  const profile = edits.profile !== undefined ? (edits.profile & 3) : (img[0x0001] >> 5) & 3;
  if (edits.profile !== undefined) img[0x0001] = 0x03 | ((edits.profile & 3) << 5);
  for (const [key, value] of Object.entries(edits.buttons || {})) {
    const k = Number(key);
    const addr = buttonAddr(k, profile);
    const slot = profile === 0 ? MEDIA_SLOT[k] : undefined;
    if (addr === undefined) continue;
    const { media, action } = parseAction(value);
    if (media !== undefined) {
      const m = MEDIA[media];
      if (!m || slot === undefined) continue;   // multimedia: sólo perfil 1
      img[addr] = MEDIA_CODE;
      img.set(mediaRecord(m.usage), slot);
    } else if (action in ACTION_CODE) {
      img[addr] = ACTION_CODE[action];
      if (slot !== undefined) img.fill(0, slot, slot + 10);  // limpia el registro
    }
  }

  // teclas de teclado y macros: un flujo de pasos en 0x400 y su registro en la
  // ranura del botón. Sólo el perfil 1, que es donde están medidas las ranuras.
  const streamEdits = profile !== 0 ? [] : Object.entries(edits.buttons || {})
    .map(([k, v]) => [Number(k), parseAction(v)])
    .filter(([k, a]) => (a.key !== undefined || a.macro !== undefined) &&
      KEY_ADDR[k] !== undefined && MEDIA_SLOT[k] !== undefined)
    .map(([k, a]) => [k, a.key !== undefined
      ? stepsStream([{ usage: a.key, delay: 0x0a }])
      : macroStream(macros.find(m => m.id === a.macro))])
    .filter(([k, bytes]) => bytes.length);
  if (streamEdits.length) {
    const used = usedStream(img, streamEdits.map(([k]) => k));
    for (const [k, bytes] of streamEdits) {
      const off = freeOffset(used, bytes.length);
      if (off < 0) continue;              // no cabe: mejor no tocar el botón
      used.push([off, off + bytes.length]);
      img[KEY_ADDR[k]] = MACRO_CODE;
      img.set(keyMacroRecord(off, bytes.length), MEDIA_SLOT[k]);
      img.set(bytes, STREAM_BASE + off);
    }
  }
  if (edits.led) applyLed(img, edits.led);
  if (edits.dpi) {
    const current = parseDpi([img[0x15], img[0x16], img[0x17]]);
    const stages = [0, 1, 2, 3, 4, 5].map(k => (edits.dpi[k] !== undefined ? edits.dpi[k] : (settingsForCode(current[k])[0] ?? 0)));
    const packed = [0, 2, 4].map(k => (dpiCode(stages[k]) << 4) | dpiCode(stages[k + 1]));
    img[0x15] = packed[0]; img[0x16] = packed[1]; img[0x17] = packed[2];
  }
  return img;
}

// Bloques que hay que enviar: los mismos que escribe el fabricante, pero sólo
// los que cambian. `mem` debe ser la imagen leída del ratón para no perder nada.
export function planImageWrites(mem, img) {
  const writes = [];
  for (const [addr, len] of WRITE_BLOCKS) {
    const a = img.subarray(addr, addr + len);
    const b = mem.subarray(addr, addr + len);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) writes.push({ addr, payload: Uint8Array.from(a) });
  }
  return writes;
}

export function planWrites(mem, edits, macros = []) {
  return planImageWrites(mem, applyEdits(mem, edits, macros));
}

// Hex dump of a memory range, 16 bytes per line, with the base address.
export function hexdump(mem, start = 0, end = mem.length, base = 0) {
  const lines = [];
  for (let a = start; a < end; a += 16) {
    const row = [];
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      const v = mem[a + i];
      if (v === undefined || a + i >= end) { row.push("  "); ascii += " "; continue; }
      row.push(v.toString(16).padStart(2, "0"));
      ascii += v >= 32 && v < 127 ? String.fromCharCode(v) : ".";
    }
    lines.push(`${(base + a).toString(16).padStart(4, "0")}  ${row.join(" ")}  |${ascii}|`);
  }
  return lines.join("\n");
}
