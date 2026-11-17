// Protocolo del ratón S700 (HXSJ).
//
// La trama son 8 bytes: report id 7 + 7 bytes de datos. El descriptor del ratón
// real declara el informe feature 7 con 56 bits (7 bytes) en su propia colección
// (usagePage 0xFF01); el programa del fabricante pasa un búfer de 65 bytes y la
// pila HID lo recorta, pero WebHID exige el tamaño exacto o rechaza la escritura.
// Los 7 bytes son suficientes: 0x18, cmd, idx, addr_lo, addr_hi, dato, len-1.

export const REPORT_ID = 0x07;
export const MAGIC = 0x18;
export const DATA_LEN = 7;             // bytes de datos del informe feature 7
export const PACKET_LEN = DATA_LEN + 1;  // trama completa: report id + 7

export const CMD = { END: 0x00, WRITE: 0x03, READ: 0x05, COMMIT: 0x09, FLUSH: 0x10 };

export const USAGE_PAGE = 0xFF00;      // colección del ratón (informe de entrada 6)
export const USAGE = 0x01;
export const CONFIG_USAGE_PAGE = 0xFF01;  // colección donde vive el informe feature 7

// cfg.ini K<n> -> device address holding that button's action code
export const KEY_ADDR = { 0: 0x08, 2: 0x09, 1: 0x0a, 4: 0x0b, 3: 0x0c, 5: 0x0d, 9: 0x0e, 8: 0x0f, 6: 0x3b, 7: 0x3c };

// Los cuatro perfiles guardan los botones en bloques distintos: 0x44, 0x50 y 0x60
// son la ranura K0 de los perfiles 1, 2 y 3 (mismo orden dentro del bloque), con
// K6/K7 en +9/+10. En los perfiles 1 y 2 la ranura de K9 guarda un registro, no un
// byte simple, así que no se toca; en el perfil 3 sí es un byte (0x66).
export const PROFILE_BASE = [0x08, 0x44, 0x50, 0x60];
const PROFILE_OFF = { 0: 0, 2: 1, 1: 2, 4: 3, 3: 4, 5: 5, 9: 6, 8: 7 };

export function buttonAddr(k, profile = 0) {
  if (profile === 0) return KEY_ADDR[k];
  const base = PROFILE_BASE[profile];
  if (base === undefined) return undefined;
  if (k === 6 || k === 7) return base + 9 + (k - 6);
  if (k === 9 && profile !== 3) return undefined;
  const off = PROFILE_OFF[k];
  return off === undefined ? undefined : base + off;
}

// action id -> byte written to the mouse (measured from the vendor tool)
export const ACTION_CODE = {
  1: 0x21, 2: 0x22, 3: 0x23, 4: 0x24, 5: 0x25, 6: 0x26, 7: 0x22, 8: 0x23,
  9: 0x24, 10: 0x25, 11: 0x26, 12: 0x27, 13: 0x28, 14: 0x29, 15: 0x35,
  16: 0x2b, 17: 0x2c, 18: 0x34, 19: 0x37, 20: 0x38, 21: 0x39, 22: 0x3a,
};
export const CODE_ACTION = {};
for (const [a, c] of Object.entries(ACTION_CODE)) if (!(c in CODE_ACTION)) CODE_ACTION[c] = Number(a);

// nombres de skins/INI_EN/skin_main_en.ini [FUN_STRING]
// Names exactly as the vendor tool's skin shows them ([FUN_STRING]).
export const ACTION_NAME = {
  1: "Left", 2: "Mid", 3: "Right", 4: "Backward", 5: "Forward",
  6: "DPI Loop", 12: "Show Desktop", 13: "Double click", 14: "Autofire",
  15: "LED Loop", 16: "DPI +", 17: "DPI −", 18: "Fn function", 19: "Profile: Office",
  20: "Profile: Game I", 21: "Profile: Game II", 22: "Profile: Game III",
};

// ---------------------------------------------------------------------------
// Teclas multimedia: el botón guarda 0x2f y un registro de 9 bytes en una ranura
// fija del área 0xA0-0x2CF. La ranura sigue el orden físico de los botones.
// Medido con el arnés para el perfil activo (Config0).
export const MEDIA_CODE = 0x2f;
export const MACRO_CODE = 0x2d;          // botón que lanza una macro
export const KEY_CODES = [0x3e, 0x3f];   // atajos/teclas personalizadas (sin descifrar)
export const MEDIA_SLOT = {
  0: 0x0a0, 2: 0x0aa, 1: 0x0b4, 4: 0x0be, 3: 0x0c8,
  5: 0x0d2, 9: 0x0dc, 8: 0x0e6, 6: 0x0fa, 7: 0x104,
};

// id de acción (el del menú del fabricante) -> nombre y usage HID de consumidor
export const MEDIA = {
  23: { name: "Browser", usage: 0x0223 },
  24: { name: "Player", usage: 0x0183 },
  25: { name: "Mail", usage: 0x018a },
  26: { name: "Vol +", usage: 0x00e9 },
  27: { name: "Vol −", usage: 0x00ea },
  28: { name: "Previous", usage: 0x00b6 },
  29: { name: "Next", usage: 0x00b5 },
  30: { name: "Mute", usage: 0x00e2 },
  31: { name: "Play/Pause", usage: 0x00cd },
  32: { name: "Calculator", usage: 0x0192 },
};

export const USAGE_MEDIA = {};
for (const [id, m] of Object.entries(MEDIA)) USAGE_MEDIA[m.usage] = Number(id);

// registro que escribe el fabricante: 01 00 ff <usage_lo> <usage_hi> 00 04 00 00
export function mediaRecord(usage) {
  return Uint8Array.from([0x01, 0x00, 0xff, usage & 0xff, (usage >> 8) & 0xff, 0x00, 0x04, 0x00, 0x00]);
}

export function readMedia(mem, k) {
  const slot = MEDIA_SLOT[k];
  if (slot === undefined) return null;
  const b = mem.subarray(slot, slot + 9);
  if (b[0] !== 0x01 || b[1] !== 0x00 || b[2] !== 0xff) return null;
  const usage = b[3] | (b[4] << 8);
  const id = USAGE_MEDIA[usage] ?? null;
  return { usage, id, name: id ? MEDIA[id].name : "(multimedia " + usage.toString(16) + ")" };
}

// Blocks the vendor tool always writes: [addr, length]
export const WRITE_BLOCKS = (() => {
  const b = [[0x0001, 1], [0x006e, 2]];
  for (let a = 0x0008; a < 0x0080; a += 8) b.push([a, 8]);
  for (let a = 0x00a0; a < 0x02d0; a += 8) b.push([a, 8]);
  for (let a = 0x0400; a < 0x04a8; a += 8) b.push([a, 8]);
  return b;
})();

export function frame(cmd, index = 0, addr = 0, data = 0, length = 0) {
  const out = new Uint8Array(PACKET_LEN);
  out[0] = REPORT_ID;
  out[1] = MAGIC;
  out[2] = cmd & 0xff;
  out[3] = index & 0xff;
  out[4] = addr & 0xff;
  out[5] = (addr >> 8) & 0xff;
  out[6] = data & 0xff;
  out[7] = length ? (length - 1) & 0xff : 0;
  return out;
}

export function decode(report) {
  const r = Uint8Array.from(report);
  if (r.length < 8 || r[0] !== REPORT_ID) return null;
  return { cmd: r[2], index: r[3], addr: r[4] | (r[5] << 8), data: r[6], length: r[7] + 1 };
}

export function writeBlock(addr, payload) {
  const n = payload.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(frame(CMD.WRITE, i, addr, payload[i], n));
  out.push(frame(CMD.COMMIT, 0, addr, 0, n));
  out.push(frame(CMD.END, 0, addr, 0, 0));
  return out;
}

export function readRequests(addr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(frame(CMD.READ, i, addr, 0, n));
  return out;
}

export function profilePayload(p) { return new Uint8Array([0x03 | ((p & 3) << 5)]); }

// DPI: 6 stages, two 4-bit codes per byte, high nibble = even stage
export function dpiCode(s) { return s <= 9 ? (s + 1) & 0x0f : (s + 2) & 0x0f; }
export function dpiBytes(stages) {
  const out = new Uint8Array(3);
  for (let i = 0; i < 6; i += 2) out[i / 2] = (dpiCode(stages[i]) << 4) | dpiCode(stages[i + 1]);
  return out;
}
export function parseDpi(b) {
  const out = [];
  for (const x of b) out.push(x >> 4, x & 0x0f);
  return out;
}
// cfg value -> dpi as displayed by the vendor tool (measured from the UI)
export const DPI_TABLE = { 5: 1200, 7: 1600, 10: 2400, 15: 6400, 16: 7200, 22: 12800 };
export function dpiLabel(s) { return DPI_TABLE[s] ? DPI_TABLE[s] + " dpi" : "index " + s; }

// Pausa entre tramas. Con setTimeout, Chrome la alarga a 1 s cuando la pestaña
// no está en primer plano y un volcado de 1280 bytes tardaría 20 minutos, así que
// se cuenta con un canal de mensajes (no son temporizadores y no se limitan).
const waiters = new Map();
let pumping = false;
const sleepChannel = typeof window !== "undefined" && typeof MessageChannel === "function" ? new MessageChannel() : null;
if (sleepChannel) {
  sleepChannel.port1.onmessage = () => {
    const now = performance.now();
    for (const [resolve, deadline] of [...waiters]) {
      if (now >= deadline) { waiters.delete(resolve); resolve(); }
    }
    if (waiters.size) sleepChannel.port2.postMessage(0);
    else pumping = false;
  };
}
export const sleep = ms => {
  if (!(ms > 0)) return Promise.resolve();
  if (!sleepChannel) return new Promise(r => setTimeout(r, ms));
  return new Promise(resolve => {
    waiters.set(resolve, performance.now() + ms);
    if (!pumping) { pumping = true; sleepChannel.port2.postMessage(0); }
  });
};

// El fabricante espera 2 ms entre tramas. Cada sendFeatureReport ya es una
// transferencia bloqueante, así que no hace falta esperar más: con temporizadores
// la pestaña en segundo plano los limita a 1/s y el volcado se eterniza.
export const PAUSE_WRITE = 0;
export const PAUSE_READ = 0;

// bytes = tamaño que declara el descriptor del informe (7 en el S700). Se toma del
// dispositivo para que otras unidades con informes más grandes sigan funcionando.
export function reportBytes(device) {
  for (const c of (device && device.collections) || []) {
    for (const r of c.featureReports || []) {
      if (r.reportId !== REPORT_ID) continue;
      const bits = (r.items || []).reduce((a, it) => a + (it.reportSize || 8) * (it.reportCount || 0), 0);
      const bytes = Math.ceil(bits / 8);
      if (bytes > 0) return bytes;
    }
  }
  return DATA_LEN;
}

export async function send(device, report, opts = {}) {
  const size = opts.bytes || DATA_LEN;
  const buf = new Uint8Array(size);
  const n = Math.min(size, report.length - 1);
  for (let i = 0; i < n; i++) buf[i] = report[i + 1];   // sin el report id
  await device.sendFeatureReport(REPORT_ID, buf);
  if (opts.pause) await sleep(opts.pause);
}

export async function recv(device, opts = {}) {
  const size = opts.bytes || DATA_LEN;
  const dv = await device.receiveFeatureReport(REPORT_ID);
  const src = new Uint8Array(dv.buffer || dv, dv.byteOffset || 0, dv.byteLength);
  const out = new Uint8Array(PACKET_LEN);
  out[0] = REPORT_ID;
  for (let i = 0; i < Math.min(size, src.length, DATA_LEN); i++) out[i + 1] = src[i];
  if (opts.pause) await sleep(opts.pause);
  return out;
}

export async function writeMemory(device, addr, payload, log = () => {}, opts = {}) {
  const pause = opts.pause ?? 0;
  for (const f of writeBlock(addr, payload)) {
    log(f, "out");
    await send(device, f, opts);
    if (pause) await sleep(pause);
  }
}

// Librería del protocolo, NO la usa el configurador: el firmware del S700 escribe
// pero no contesta a GetFeature (docs/PROTOCOL.md §4), así que se queda sólo como
// documentación y para volver a probar si aparece otra unidad que sí responda.
//
// The vendor tool reads one byte per request (index 0, length 1), which is the
// only variant we have seen on real traffic, so it is the default here.
export async function readMemory(device, addr, n, { log = () => {}, onProgress, bytes, pause = 2 } = {}) {
  const out = new Uint8Array(n);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const a = addr + i;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const req = frame(CMD.READ, 0, a, 0, 1);
      if (!attempt) log(req, "out");
      await send(device, req, { bytes });
      // el ratón necesita un respiro para preparar la respuesta; sin esto
      // Get_Report devuelve ceros y el volcado entero sale a 0x00
      await sleep(pause + attempt * 3);
      const rep = await recv(device, { bytes });
      const d = decode(rep);
      if (!attempt) log(rep, "in");
      // La respuesta debe repetir el comando y la dirección: si no, es la de la
      // petición anterior (el ratón no ha contestado a tiempo) y no vale.
      if (d && d.cmd === CMD.READ && d.addr === a) { out[i] = d.data; ok = true; }
    }
    if (!ok) bad++;
    if (onProgress && (i % 32 === 0 || i === n - 1)) onProgress(i + 1, n);
  }
  out.badReplies = bad;
  return out;
}

export async function readBlock(device, addr, n, { log = () => {}, bytes } = {}) {
  // ráfaga de varios bytes: misma dirección en cada trama, índice incremental (sin confirmar)
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const req = frame(CMD.READ, i, addr, 0, n);
    log(req, "out");
    await send(device, req, { bytes });
    out[i] = decode(await recv(device, { bytes })).data;
  }
  return out;
}

export async function flush(device, opts = {}) {
  for (const cmd of [CMD.FLUSH, CMD.END]) { await send(device, frame(cmd), opts); await sleep(5); }
}

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- teclas
// Una tecla asignada a un botón es una macro de un paso. Medido del fabricante
// (macro «map» = tecla Q, asignada al botón 10):
//   botón   0x2d
//   registro 01 02 ff 00 00 <off> 04 00 <len_lo> <len_hi> (off = desplazamiento)
//   flujo    01 00 83 <usage> 0a <usage> 00 00
// Un paso de tecla ocupa **8 bytes** en el bloque 0x400: pulsar `usage`, esperar
// `delay` ms, soltar. Medido del fabricante (macro «map», tecla Q):
// 01 00 83 14 0a 14 00 00 — y el registro siguiente empieza justo detrás, en
// 0x408. El byte 0x83 es el mismo que escribe la herramienta para una macro de
// un paso; en otra captura («first aid») puso 0x85, así que ese byte no está
// cerrado (§5-ter).
export const STEP_LEN = 8;
export const KEY_MACRO_LEN = STEP_LEN;
export const STREAM_BASE = 0x400;
export const STREAM_SIZE = 0xa8;          // 0x400–0x4A7, lo que cabe en el bloque

export function stepStream(usage, delay = 0x0a) {
  return Uint8Array.from([0x01, 0x00, 0x83, usage & 0xff, delay & 0xff, usage & 0xff, 0x00, 0x00]);
}

export function keyMacroStream(usage) { return stepStream(usage); }

// ------------------------------------------------------------------- LED
// Verificado con el arnés de Wine comparando lo que escribe la herramienta del
// fabricante (docs/PROTOCOL.md §5-quater). Cada byte de 0x20–0x31 mete DOS
// canales de 4 bits (color de usuario arriba, etapa de DPI abajo).
// 0x1C nibble alto = efecto, bajo = tiempo de ciclo; 0x33 bit 7 = la segunda
// tanda de nombres del fabricante; 0x1D = 0x80 | colores que entran en el ciclo;
// 0x20–0x31 = seis pares (color de usuario arriba, etapa de DPI abajo);
// 0x3A bit 0x40 = simetría y bits 4–5 = dirección; 0x3E/0x3F = séptimo color y
// brillo. Todo medido contra lo que escribe la herramienta (PROTOCOL §5-quater).
export const LED = { type: 0x1c, flags: 0x33, cycle: 0x1d, colours: 0x20, feats: 0x3a, user6: 0x3e, bright: 0x3f };
export const LED_USER_COUNT = 7;      // 6 pareados con las etapas de DPI + el 7º en 0x3E/0x3F
export const LED_DPI_COUNT = 6;
export const LED_MAX = 0x0f;          // canales y brillo: 0..15

// Los catorce efectos del desplegable del fabricante y lo que deja cada uno en
// la imagen al pulsar Apply (medido efecto por efecto con el arnés, §5-quater):
//   ini   valor de LED_TYPE en el config.ini (= índice del desplegable)
//   mode  nibble alto de 0x1C
//   bank  bit 7 de 0x33: el fabricante lo pone en su segunda tanda de nombres
//   cyc   nibble bajo de 0x1C cuando es fijo (Button response y Mute)
//   opts  controles que el fabricante muestra para ese efecto
// opts: "speed" = 0x1C bajo (0–7), "bright" = 0x3F alto, "colours" = los siete
// colores y la máscara de 0x1D, "symmetry" = 0x3A bit 6, "dir2/3/4" = 0x3A
// bits 4–5 con dos, tres o cuatro opciones, "react" = animación por botón.
export const LED_EFFECTS = [
  { ini: 0,  name: "Breathing",       mode: 8,  bank: 0, opts: ["speed"] },
  { ini: 1,  name: "Cycle breath",    mode: 9,  bank: 0, opts: ["speed", "colours"] },
  { ini: 2,  name: "Constantly",      mode: 10, bank: 0, opts: ["bright"] },
  { ini: 3,  name: "Flow water",      mode: 11, bank: 0, opts: ["speed", "bright", "colours", "symmetry", "dir4"] },
  { ini: 4,  name: "Single water",    mode: 12, bank: 0, opts: ["speed", "bright", "colours", "symmetry", "dir3"] },
  { ini: 5,  name: "Comet tail",      mode: 13, bank: 0, opts: ["speed", "bright", "colours", "symmetry", "dir3"] },
  { ini: 6,  name: "Neon",            mode: 14, bank: 0, opts: ["speed"] },
  { ini: 7,  name: "Ambilight",       mode: 15, bank: 0, opts: ["speed", "symmetry", "dir2"] },
  { ini: 8,  name: "Flicker",         mode: 8,  bank: 1, opts: ["speed"] },
  { ini: 9,  name: "Star Trek",       mode: 9,  bank: 1, opts: [] },
  { ini: 10, name: "Water",           mode: 10, bank: 1, opts: ["speed", "dir2"] },
  { ini: 11, name: "enraptured",      mode: 11, bank: 1, opts: ["speed"] },
  { ini: 12, name: "Button response", mode: 9,  bank: 0, cyc: 0x0c, opts: ["react"] },
  { ini: 13, name: "Mute",            mode: 9,  bank: 0, cyc: 0x07, opts: [] },
];

// 0x3A bits 4–5: la herramienta ofrece dos, tres o cuatro según el efecto
export const LED_DIRECTIONS = ["clockwise", "inverse", "two way", "magicalady"];

// "Button response": la animación de cada botón va en los bits 7–6 de su byte de
// acción (0x08–0x0F y 0x3B–0x3C) y el bit 5 es el "enabled" del fabricante
// (LED_REACT_EN en su config.ini). La lista es la del propio .exe, en su orden.
export const LED_REACT_NAMES = ["Cycle breath", "Flow water", "Comet tail", "Single water"];
export const LED_REACT_SHIFT = 6;
export const LED_REACT_ON = 0x20;     // bit 5 del byte de acción: react activado
export const LED_REACT_MASK = 0xc0;   // bits 7–6: animación
export const LED_ACTION_MASK = 0x1f;  // bits 4–0: id de la acción

export function keyMacroRecord(offset, len = KEY_MACRO_LEN) {
  return Uint8Array.from([0x01, 0x02, 0xff, 0x00, 0x00, offset & 0xff,
                          0x04, 0x00, len & 0xff, (len >> 8) & 0xff]);
}

// Desplazamiento del flujo dentro del bloque 0x400. Va en el byte 5 del registro
// (medido de lo que escribe el fabricante: al asignar su segunda macro deja
// `... 00 00 08 04 00 ...`, y sus registros de multimedia llevan ese mismo byte
// con el desplazamiento), no en los bytes 3-4, que en las macros van a cero.
// Las imágenes de versiones anteriores del configurador lo llevaban en 3-4 y se
// siguen leyendo.
export function macroOffset(mem, slot) {
  return mem[slot + 5] || (mem[slot + 3] | (mem[slot + 4] << 8));
}

// Lee la tecla de un botón con macro. Devuelve { usage, offset, len } o null.
export function readKeyMacro(mem, k) {
  const slot = MEDIA_SLOT[k];
  if (slot === undefined) return null;
  if (mem[slot] !== 0x01 || mem[slot + 1] !== 0x02 || mem[slot + 2] !== 0xff) return null;
  const offset = macroOffset(mem, slot);
  const len = mem[slot + 8] | (mem[slot + 9] << 8);
  if (!len || offset + len > 0xa8) return null;
  const base = 0x400 + offset;
  if (mem[base] !== 0x01 || (mem[base + 2] & 0x80) === 0) return null;
  return { usage: mem[base + 3], offset, len };
}

// nombres de tecla para la interfaz
export const KEY_NAME = (() => {
  const n = {};
  for (let i = 0; i < 26; i++) n[0x04 + i] = String.fromCharCode(65 + i);
  for (let i = 0; i < 9; i++) n[0x1e + i] = String(i + 1);
  Object.assign(n, {
    0x27: "0", 0x28: "Enter", 0x29: "Esc", 0x2a: "Backspace", 0x2b: "Tab", 0x2c: "Space",
    0x2d: "-", 0x2e: "=", 0x2f: "[", 0x30: "]", 0x31: "\\", 0x33: ";", 0x34: "'", 0x35: "`",
    0x36: ",", 0x37: ".", 0x38: "/", 0x39: "CapsLock",
    0x49: "Insert", 0x4a: "Home", 0x4b: "PageUp", 0x4c: "Del", 0x4d: "End", 0x4e: "PageDown",
    0x4f: "Right", 0x50: "Left", 0x51: "Down", 0x52: "Up",
    0x53: "NumLock", 0x62: "Num0", 0x63: "Num.",
    0xe0: "LCtrl", 0xe1: "LShift", 0xe2: "LAlt", 0xe3: "LWin",
    0xe4: "RCtrl", 0xe5: "RShift", 0xe6: "RAlt", 0xe7: "RWin",
  });
  for (let i = 0; i < 12; i++) n[0x3a + i] = "F" + (i + 1);
  return n;
})();

export const keyName = usage => KEY_NAME[usage] || ("0x" + usage.toString(16));

// event.code del navegador -> usage HID de teclado (página 0x07)
const CODE_TO_USAGE = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m["Key" + String.fromCharCode(65 + i)] = 0x04 + i;
  for (let i = 1; i <= 9; i++) m["Digit" + i] = 0x1e + i - 1;
  m.Digit0 = 0x27;
  Object.assign(m, {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d,
    Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33,
    Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a,
    PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, NumLock: 0x53,
    NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
    NumpadEnter: 0x58, NumpadDecimal: 0x63,
    ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
    ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
  });
  for (let i = 1; i <= 12; i++) m["F" + i] = 0x3a + i - 1;
  for (let i = 1; i <= 9; i++) m["Numpad" + i] = 0x59 + i - 1;
  m.Numpad0 = 0x62;
  return m;
})();

export const usageFromEventCode = code => CODE_TO_USAGE[code];
