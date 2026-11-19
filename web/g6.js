// S700 (HXSJ) mouse protocol.
//
// A frame is 8 bytes: report id 7 + 7 data bytes. The real mouse descriptor
// declares feature report 7 with 56 bits (7 bytes) in its own collection
// (usagePage 0xFF01); the vendor program passes a 65-byte buffer and the HID
// stack trims it, but WebHID demands the exact size or rejects the write.
// The 7 bytes are enough: 0x18, cmd, idx, addr_lo, addr_hi, data, len-1.

export const REPORT_ID = 0x07;
export const MAGIC = 0x18;
export const DATA_LEN = 7;             // data bytes of feature report 7
export const PACKET_LEN = DATA_LEN + 1;  // whole frame: report id + 7

export const CMD = { END: 0x00, WRITE: 0x03, READ: 0x05, COMMIT: 0x09, FLUSH: 0x10 };

export const USAGE_PAGE = 0xFF00;      // mouse collection (input report 6)
export const USAGE = 0x01;
export const CONFIG_USAGE_PAGE = 0xFF01;  // collection that holds feature report 7

// cfg.ini K<n> -> device address holding that button's action code
export const KEY_ADDR = { 0: 0x08, 2: 0x09, 1: 0x0a, 4: 0x0b, 3: 0x0c, 5: 0x0d, 9: 0x0e, 8: 0x0f, 6: 0x3b, 7: 0x3c };

// The four profiles keep buttons in different blocks: 0x44, 0x50 and 0x60
// are the K0 slot of profiles 1, 2 and 3 (same order inside the block), with
// K6/K7 at +9/+10. In profiles 1 and 2 the K9 slot holds a record, not a plain
// byte, so it is left alone; in profile 3 it is a byte (0x66).
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

// names from skins/INI_EN/skin_main_en.ini [FUN_STRING]
// Names exactly as the vendor tool's skin shows them ([FUN_STRING]).
export const ACTION_NAME = {
  1: "Left", 2: "Mid", 3: "Right", 4: "Backward", 5: "Forward",
  6: "DPI Loop", 12: "Show Desktop", 13: "Double click", 14: "Autofire",
  15: "LED Loop", 16: "DPI +", 17: "DPI −", 18: "Fn function", 19: "Profile: Office",
  20: "Profile: Game I", 21: "Profile: Game II", 22: "Profile: Game III",
};

// ---------------------------------------------------------------------------
// Media keys: the button stores 0x2f plus a 9-byte record in a fixed slot of
// the 0xA0-0x2CF area. The slot follows the physical order of the buttons.
// Measured with the harness for the active profile (Config0).
export const MEDIA_CODE = 0x2f;
export const MACRO_CODE = 0x2d;          // «Repeat On» macro (repeats while the button is held)
export const MACRO_RELEASE_CODE = 0x2e;  // «Run until release» macro (stops when the button is released)
export const MACRO_CODES = [0x2d, 0x2e];

// Hardware probe: the same key in the four candidate shapes, one per button,
// to try them in a single pass. Names for the Debug UI.
export const KEY_PROBE_SHAPES = [
  { name: "0x2d · 20× down", action: MACRO_CODE, copies: 20, tap: false },
  { name: "0x2e · 20× down", action: MACRO_RELEASE_CODE, copies: 20, tap: false },
  { name: "0x2d · tap step", action: MACRO_CODE, copies: 1, tap: true },
  { name: "0x2e · tap step", action: MACRO_RELEASE_CODE, copies: 1, tap: true },
];
export const KEY_CODES = [0x3e, 0x3f];   // shortcuts/custom keys (not decoded)
export const MEDIA_SLOT = {
  0: 0x0a0, 2: 0x0aa, 1: 0x0b4, 4: 0x0be, 3: 0x0c8,
  5: 0x0d2, 9: 0x0dc, 8: 0x0e6, 6: 0x0fa, 7: 0x104,
};

// action id (the vendor menu's) -> name and consumer HID usage
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

// record the vendor writes: 01 00 ff <usage_lo> <usage_hi> 00 04 00 00
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
  for (let a = 0x0400; a < 0x0568; a += 8) b.push([a, 8]);
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

// Pause between frames. With setTimeout, Chrome stretches it to 1 s when the tab
// is not in the foreground and a 1280-byte dump would take 20 minutes, so we
// count on a message channel (they are not timers, so they are not throttled).
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

// The vendor waits 2 ms between frames. Each sendFeatureReport is already a
// blocking transfer, so there is no need to wait longer: with timers a
// background tab throttles them to 1/s and the dump drags on forever.
export const PAUSE_WRITE = 0;
export const PAUSE_READ = 0;

// bytes = size declared by the report descriptor (7 on the S700). It is taken from
// the device so other units with bigger reports keep working.
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
  for (let i = 0; i < n; i++) buf[i] = report[i + 1];   // without the report id
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

// Protocol library, the configurator does NOT use it: the S700 firmware writes
// but does not answer GetFeature (docs/PROTOCOL.md §4), so it stays only as
// documentation and to retry should a unit that does answer show up.
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
      // the mouse needs a breather to prepare the reply; without this
      // Get_Report returns zeros and the whole dump comes out as 0x00
      await sleep(pause + attempt * 3);
      const rep = await recv(device, { bytes });
      const d = decode(rep);
      if (!attempt) log(rep, "in");
      // The reply must echo the command and the address: otherwise it is the
      // previous request's (the mouse did not answer in time) and it is no good.
      if (d && d.cmd === CMD.READ && d.addr === a) { out[i] = d.data; ok = true; }
    }
    if (!ok) bad++;
    if (onProgress && (i % 32 === 0 || i === n - 1)) onProgress(i + 1, n);
  }
  out.badReplies = bad;
  return out;
}

export async function readBlock(device, addr, n, { log = () => {}, bytes } = {}) {
  // multi-byte burst: same address in every frame, incrementing index (unconfirmed)
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

// ----------------------------------------------------------------- keys
// A key assigned to a button can be a one-step macro (press and release) or a
// **held** key (press only). Measured from the vendor:
//
//   held key (Q, Shift; «Run until release», captured with the harness):
//     record 01 94 ff 00 00 <off> 04 00 0a 00
//     stream 01 00 + 81 <usage> × 20  → 42 bytes
//
//   tap key («map» macro, Q, button 10):
//     record 01 02 ff 00 00 <off> 04 00 0a 00
//     stream 01 00 83 <usage> 0a <usage> 00 00  → 8 bytes
//
// `81` = key down, `01` = key up in the variable stream. The record's type byte
// carries the mode in bit 7 and, in the seven low bits, **the number of 2-byte
// words in the stream**: 20 presses → 0x94, 26 (13 down/up pairs) → 0x9a, the
// 54 B of a nine-tap macro → 0x9b. Twelve captures with 20, 26, 30, 32, 35 and
// 36 words confirm it. With that count wrong —0x94 declaring twenty words over
// a one-word stream— the firmware never gets to release the key when the button
// is lifted: it stays pressed until the next press. That is why the held key is
// written with the vendor's twenty copies and not with one.
//
// The held key does not carry the "release" inside: the firmware emits it when
// the button is released because the macro is in «Run until release».
export const STEP_LEN = 8;
export const KEY_MACRO_LEN = STEP_LEN;
export const STREAM_BASE = 0x400;
// 0x400–0x4BF: 192 B for the button key and macro streams. The vendor places
// four 20-copy keys at 0x00/0x30/0x60/0x90 (the last one ends at 0x4BA) and
// from 0x4C0 on it stores the macro library.
export const STREAM_SIZE = 0xc0;

// The macro library (the streams that belong to no button) lives **above**
// the button block: 0x4C0–0x567, 168 B. The factory image has it at 0x400,
// and that is the problem: writing a key at 0x400 leaves the stream on top
// of the library, but its five records (0x14A, 0x154, 0x168, 0x172, 0x186)
// and the "next free" pointers still point there, so the firmware reads a
// stream that is not the key's. It is the difference between an image that
// holds the key and one that taps it for 1 ms: the vendor capture that does
// hold it has the library already lifted (records at 0x4C0/0x4E0/0x510/0x540/
// 0x550). `liftLibrary()` in core.js does the move (+0xC0, the same one the
// vendor tool does when assigning the first macro) before writing streams.
export const LIB_BASE = 0x4c0;
export const LIB_SIZE = 0xa8;                       // 0x4C0–0x567
export const LIB_SHIFT = LIB_BASE - STREAM_BASE;    // 0xc0
export const LIB_RECORDS = [0x14a, 0x154, 0x168, 0x172, 0x186];   // 10 B each
// The library's "next free" pointers: four in a row at 0x006E and four more
// loose (two straddling 0x0079/0x007B, and the copy each media record carries
// inside at 0x0203 and 0x028F). They move with the library.
export const LIB_FREE = [0x006e, 0x0070, 0x0072, 0x0074, 0x0079, 0x007b, 0x0203, 0x028f];

export const HOLD_COPIES = 20;            // the vendor's: 42 B, three keys
export const HOLD_STREAM_LEN = 2 + HOLD_COPIES * 2;

export function stepStream(usage, delay = 0x0a) {
  return Uint8Array.from([0x01, 0x00, 0x83, usage & 0xff, delay & 0xff, usage & 0xff, 0x00, 0x00]);
}

export function keyMacroStream(usage) { return stepStream(usage); }

// **Held** key: `01 00` + N `81 <usage>` pairs, with the same N in the record
// type (`0x80 | N`). N = 20 is what the vendor writes.
//
// WARNING — measured on hardware: this shape leaves the key STUCK. The stream
// carries no release and the firmware, in «Run until release», does not emit one
// when the button is lifted; with one copy it stayed until the next press and
// with the vendor's twenty it re-asserts on every loop iteration and there is
// no way to stop it. That is why it is NOT used to assign a key: see
// `tapStream()`. It is kept to read old images and to test it in the future.
// Held key as the vendor writes it: a one-step macro,
// `01 00 83 <usage>` (4 B). With action `0x2e` («Run until release») the key
// stays down while the button is held.
export function holdMacroStream(usage) {
  return Uint8Array.from([0x01, 0x00, 0x83, clamp(usage, 0, 255)]);
}

export function holdStream(usage, copies = HOLD_COPIES) {
  const out = new Uint8Array(2 + copies * 2);
  out[0] = 0x01;
  out[1] = 0x00;
  for (let i = 0; i < copies; i++) {
    out[2 + i * 2] = 0x81;
    out[3 + i * 2] = usage & 0xff;
  }
  return out;
}

// Tap key: the step `83 <usage> <delay> <usage> 00 00` carries the release
// INSIDE, so the key cannot get stuck. It is the shape the vendor writes for a
// one-key macro («map» capture).
export function tapStream(usage, delay = 0x0a) { return stepStream(usage, delay); }

// Repeated tap while the button is held: the vendor stream for a tap in
// «Run until release» is `81 <usage> 01 <usage>` pairs (`tap_q` capture, 13
// pairs). Each pair releases the key before the next one, so it cannot get
// stuck either. `pairs` and the type go together (`0x80 | 2·pairs`).
export const REPEAT_PAIRS = 4;
export function repeatStream(usage, pairs = REPEAT_PAIRS) {
  const out = new Uint8Array(2 + pairs * 4);
  out[0] = 0x01;
  out[1] = 0x00;
  for (let i = 0; i < pairs; i++) {
    out[2 + i * 4] = 0x81;
    out[3 + i * 4] = usage & 0xff;
    out[4 + i * 4] = 0x01;
    out[5 + i * 4] = usage & 0xff;
  }
  return out;
}

// ------------------------------------------------------------------- LED
// Verified with the Wine harness by comparing what the vendor tool writes
// (docs/PROTOCOL.md §5-quater). Each byte of 0x20–0x31 packs TWO 4-bit channels
// (user colour on top, DPI stage below).
// 0x1C high nibble = effect, low = cycle time; 0x33 bit 7 = the vendor's second
// batch of names; 0x1D = 0x80 | colours that take part in the cycle;
// 0x20–0x31 = six pairs (user colour on top, DPI stage below);
// 0x3A bit 0x40 = symmetry and bits 4–5 = direction; 0x3E/0x3F = seventh colour
// and brightness. All measured against what the tool writes (PROTOCOL §5-quater).
export const LED = { type: 0x1c, flags: 0x33, cycle: 0x1d, colours: 0x20, feats: 0x3a, user6: 0x3e, bright: 0x3f };
export const LED_USER_COUNT = 7;      // 6 paired with the DPI stages + the 7th in 0x3E/0x3F
export const LED_DPI_COUNT = 6;
export const LED_MAX = 0x0f;          // channels and brightness: 0..15

// The vendor drop-down's fourteen effects and what each one leaves in the image
// on Apply (measured effect by effect with the harness, §5-quater):
//   ini   LED_TYPE value in config.ini (= drop-down index)
//   mode  high nibble of 0x1C
//   bank  bit 7 of 0x33: the vendor sets it in its second batch of names
//   cyc   low nibble of 0x1C when fixed (Button response and Mute)
//   opts  controls the vendor shows for that effect
// opts: "speed" = 0x1C low (0–7), "bright" = 0x3F high, "colours" = the seven
// colours and the 0x1D mask, "symmetry" = 0x3A bit 6, "dir2/3/4" = 0x3A
// bits 4–5 with two, three or four options, "react" = per-button animation.
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

// 0x3A bits 4–5: the tool offers two, three or four depending on the effect
export const LED_DIRECTIONS = ["clockwise", "inverse", "two way", "magicalady"];

// "Button response": each button's animation goes in bits 7–6 of its action byte
// (0x08–0x0F and 0x3B–0x3C) and bit 5 is the vendor's "enabled" flag
// (LED_REACT_EN in its config.ini). The list is the .exe's own, in its order.
export const LED_REACT_NAMES = ["Cycle breath", "Flow water", "Comet tail", "Single water"];
export const LED_REACT_SHIFT = 6;
export const LED_REACT_ON = 0x20;     // bit 5 of the action byte: react enabled
export const LED_REACT_MASK = 0xc0;   // bits 7–6: animation
export const LED_ACTION_MASK = 0x1f;  // bits 4–0: action id

// Slot record byte 6 = mode. `0x04` is what the vendor writes for a «Repeat On»
// key/macro; `0x84` is what the doc labels «Run until Click». The «Run until
// release» mode is not confirmed on hardware, so both records take the byte as
// a parameter (Debug → slot mode).
export function keyMacroRecord(offset, len = KEY_MACRO_LEN, modeByte = 0x04) {
  return Uint8Array.from([0x01, 0x02, 0xff, 0x00, 0x00, offset & 0xff,
                          modeByte & 0xff, 0x00, len & 0xff, (len >> 8) & 0xff]);
}

// Held key record: type `0x80 | N`, with N = copies of the stream
// (20 = 0x94, what the vendor writes for a held key).
export function holdMacroRecord(offset, copies = HOLD_COPIES, modeByte = 0x04) {
  return Uint8Array.from([0x01, 0x80 | (copies & 0x7f), 0xff, 0x00, 0x00, offset & 0xff,
                          modeByte & 0xff, 0x00, 0x0a, 0x00]);
}

// Repeated tap record: same bit 7, with the stream words (2 per pair) and the
// «Run until release» mode (byte 6 = 0x04).
export function repeatMacroRecord(offset, pairs = REPEAT_PAIRS, modeByte = 0x04) {
  return holdMacroRecord(offset, pairs * 2, modeByte);
}

// --------------------------------------------------------------- macros
// Variable stream the vendor writes (captured with macro.dat):
//   2 counter bytes (uint16 LE) + steps
//   83 <usage> <delay> <usage> 00 00     tap key
//   81/01 f1|f2|f3                       left/middle/right button down/up
//   01 f6 <x16> <y16>                    move (signed int16)
//   81/01 f8 <dpi/200>                   set / restore DPI
//   01 f9 <...>                          LED (pending)
//   00 <ms/2> 00                         delay
// The counter is only used with «Repeat On»; the other modes write 1.
export const MACRO_KINDS = ["key", "mouse", "move", "dpi", "delay"];
export const MOUSE_CODE = { left: 0xf1, middle: 0xf2, right: 0xf3 };
export const MOUSE_NAME = { left: "Left", middle: "Middle", right: "Right" };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

export function wireStep(st) {
  const kind = st.kind || "key";
  if (kind === "key") {
    const u = clamp(st.usage, 0, 255);
    // the vendor writes 2 bytes per step: `83 <usage>` key down and
    // `82 <usage>` key up (measured in a «Run Until release» macro:
    // stream `01 00`, type = number of steps, 0x83/0x82 alternating). Without
    // `dir` it keeps the usual 6-byte tap.
    if (st.dir === "down") return [0x83, u];
    if (st.dir === "up") return [0x82, u];
    const d = clamp(st.delay ?? 10, 0, 255);
    return [0x83, u, d, u, 0x00, 0x00];
  }
  if (kind === "mouse") {
    const code = MOUSE_CODE[st.button] ?? MOUSE_CODE.left;
    return [st.dir === "up" ? 0x01 : 0x81, code];
  }
  if (kind === "move") {
    const x = clamp(st.x, -32768, 32767) & 0xffff, y = clamp(st.y, -32768, 32767) & 0xffff;
    return [0x01, 0xf6, x & 0xff, x >> 8, y & 0xff, y >> 8];
  }
  if (kind === "dpi") {
    const v = clamp((Number(st.dpi) || 800) / 200, 1, 255);
    return [st.reset ? 0x01 : 0x81, 0xf8, v];
  }
  if (kind === "delay") return [0x00, clamp((Number(st.ms) || 0) / 2, 0, 255), 0x00];
  return [];
}

export function macroFlow(m) {
  const steps = (m && Array.isArray(m.steps) ? m.steps : []).flatMap(wireStep);
  if (!steps.length) return new Uint8Array(0);
  const count = m.repeat === "on" ? clamp(m.count ?? 1, 1, 0xffff) : 1;
  return Uint8Array.from([count & 0xff, (count >> 8) & 0xff, ...steps]);
}

// Macro record: byte 6 bit 7 = «Run until Click»; in «Run until Release» the
// type carries bit 7 and, in the seven low bits, the number of 2-byte words in
// the stream (measured: 20 presses → 0x94, nine taps → 0x9b). For the other
// modes the type is the number of steps, like the vendor.
export function macroRecord(offset, mode, stepCount, bodyLen = 0) {
  const words = Math.ceil(bodyLen / 2);
  const type = mode === "release" ? (0x80 | clamp(words, 1, 0x7f)) : clamp(stepCount, 1, 0x7f);
  return Uint8Array.from([0x01, type, 0xff, 0x00, 0x00, offset & 0xff,
                          0x04 | (mode === "click" ? 0x80 : 0x00), 0x00, 0x0a, 0x00]);
}

// Stream offset inside the 0x400 block. It goes in byte 5 of the record
// (measured from what the vendor writes: when assigning its second macro it
// leaves `... 00 00 08 04 00 ...`, and its media records carry that same
// byte with the offset), not in bytes 3-4, which are zero in macros. Images
// from earlier versions of the configurator carried it in 3-4 and are still
// read back.
export function macroOffset(mem, slot) {
  return mem[slot + 5] || (mem[slot + 3] | (mem[slot + 4] << 8));
}

// Reads the key of a macro button. Returns { usage, offset, len } or null.
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

// key names for the interface
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

// browser event.code -> keyboard HID usage (page 0x07)
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
