// Pure logic for the S700 configurator: decode a device memory image into a
// readable config view and turn user edits back into memory writes.
// No DOM, no WebHID here so it can be tested in node.

import {
  KEY_ADDR, buttonAddr, ACTION_CODE, CODE_ACTION, ACTION_NAME, dpiCode, parseDpi, DPI_TABLE,
  WRITE_BLOCKS, MEDIA, MEDIA_CODE, MEDIA_SLOT, USAGE_MEDIA, mediaRecord, readMedia, MACRO_CODE, MACRO_RELEASE_CODE, MACRO_CODES, KEY_CODES, HOLD_COPIES, KEY_PROBE_SHAPES, holdMacroStream,
  KEY_MACRO_LEN, STEP_LEN, STREAM_BASE, STREAM_SIZE, stepStream, keyMacroRecord, macroOffset, keyName,
  holdStream, holdMacroRecord, tapStream, repeatStream, REPEAT_PAIRS,
  LIB_BASE, LIB_SIZE, LIB_SHIFT, LIB_RECORDS, LIB_FREE,
  macroFlow, macroRecord, repeatMacroRecord, MOUSE_CODE, MOUSE_NAME,
  LED, LED_DPI_COUNT, LED_MAX, LED_EFFECTS, LED_REACT_SHIFT, LED_REACT_ON, LED_REACT_MASK,
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

// "12" -> basic action ; "m26" -> media key ; "k20" -> keyboard key
// (HID usage) ; "xab12" -> stored macro (id from the macro list)
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
// A macro is a list of heterogeneous steps (key, button, move, DPI, delay)
// that the mouse runs on its own. The flow goes to block 0x400 and its
// definition is kept in the browser (see docs/PROTOCOL.md §5-ter).
export const MAX_STEPS = 21;

// Compatibility: old macros only had { usage, delay } and were a single key
// tap. Anything without `kind` is treated as a key.
export const stepKind = st => (st && st.kind) || "key";

const normStep = st => {
  const kind = stepKind(st);
  if (kind === "key") return { kind, usage: Number(st.usage) || 0, delay: Number(st.delay ?? 10) || 0 };
  if (kind === "mouse") return { kind, button: st.button || "left", dir: st.dir === "up" ? "up" : "down" };
  if (kind === "move") return { kind, x: Number(st.x) || 0, y: Number(st.y) || 0 };
  if (kind === "dpi") return { kind, dpi: Number(st.dpi) || 800, reset: !!st.reset };
  if (kind === "delay") return { kind, ms: Number(st.ms) || 0 };
  return null;
};

const normSteps = steps => (steps || []).map(normStep).filter(Boolean);

// New flow (counter + variable steps), the one the vendor writes.
export function macroStream(macro) { return macroFlow(macro); }

// Byte length of the flow that would be written, so other macros are not clobbered.
export function macroFlowLen(macro) { return macroFlow(macro).length; }

const sameSteps = (a, b) => {
  const x = normSteps(a), y = normSteps(b);
  if (x.length !== y.length) return false;
  return x.every((s, i) => JSON.stringify(s) === JSON.stringify(y[i]));
};

// Flow in the image: counter + steps. Also accepts the old format, which
// repeated `01 00` before every `83` step.
export function parseMacroFlow(mem, slot) {
  if (mem[slot] !== 0x01 || mem[slot + 2] !== 0xff) return null;
  const offset = macroOffset(mem, slot);
  const base = STREAM_BASE + offset;
  const count = mem[base] | (mem[base + 1] << 8);
  let p = base + 2;
  const end = Math.min(base + 0x80, STREAM_BASE + STREAM_SIZE);
  const steps = [];
  while (p + 1 < end) {
    const t = mem[p], u = mem[p + 1];
    // `00 00` is padding: a delay step carries its value in between, and the
    // block is zero-padded up to the next multiple of 8
    if (t === 0x00 && u === 0x00) break;
    // `01 00` after a step is the header of the next record, not part of this
    // flow: without this an 8 B tap swallowed the neighbouring flows
    if (t === 0x01 && u === 0x00 && (mem[p + 2] === 0x83 || mem[p + 2] === 0x85)) {
      if (steps.length) break;
      p += 2; continue;
    }
    if (t === 0x83 || t === 0x85) {
      // `83 u d u` is a tap (the fourth byte repeats the key); a bare `83 u`
      // is only the key down, the shape that leaves the key held
      if (mem[p + 3] !== mem[p + 1]) {
        steps.push({ kind: "key", usage: mem[p + 1], dir: "down" });
        p += 2;
      } else {
        steps.push({ kind: "key", usage: mem[p + 1], delay: mem[p + 2] });
        p += 6;
      }
      continue;
    }
    if (t === 0x82) {
      steps.push({ kind: "key", usage: mem[p + 1], dir: "up" });
      p += 2;
      continue;
    }
    if ((t === 0x81 || t === 0x01) && (u === 0xf1 || u === 0xf2 || u === 0xf3)) {
      const button = u === 0xf1 ? "left" : u === 0xf2 ? "middle" : "right";
      steps.push({ kind: "mouse", button, dir: t === 0x81 ? "down" : "up" });
      p += 2;
    } else if ((t === 0x81 || t === 0x01) && u === 0xf8) {
      steps.push({ kind: "dpi", dpi: mem[p + 2] * 200, reset: t === 0x01 });
      p += 3;
    } else if (t === 0x01 && u === 0xf6) {
      const x = mem[p + 2] | (mem[p + 3] << 8), y = mem[p + 4] | (mem[p + 5] << 8);
      steps.push({ kind: "move", x: x << 16 >> 16, y: y << 16 >> 16 });
      p += 6;
    } else if (t === 0x01 && u === 0xf9) {
      steps.push({ kind: "led" });
      p += 4;
    } else if (t === 0x00) {
      steps.push({ kind: "delay", ms: mem[p + 1] * 2 });
      p += 3;
    } else break;
  }
  const mode = (mem[slot + 6] & 0x80) ? "click" : ((mem[slot + 1] & 0x80) ? "release" : "on");
  return { count, steps, mode, offset, bytes: mem.slice(base, p) };
}

// Record 01 <type> ff … + flow, exactly as the vendor writes it.
// Held key: flow `01 00` + N pairs `81 <usage>` and type `0x80 | N`
// (N = 20 in the vendor captures → 0x94). The flow cannot carry the "release"
// inside or the firmware runs it as a tap, so consecutive presses of the SAME
// key are counted and it is rejected when its release comes right behind.
//
// Fewer copies than the type declares are accepted on purpose: the images left
// by the single-copy build (`0x94` with a single `81 <usage>`) must still read
// back, and with the real size (4 B) or `usedStream()` reserves them as 56 B
// and fills block 0x400 so nothing else fits.
export function readHoldKey(mem, slot) {
  if (mem[slot] !== 0x01 || !(mem[slot + 1] & 0x80) || mem[slot + 2] !== 0xff) return null;
  if (mem[slot + 6] & 0x80) return null;              // "Run until click": not this one
  const offset = macroOffset(mem, slot);
  const base = STREAM_BASE + offset;
  if (mem[base] !== 0x01 || mem[base + 1] !== 0x00) return null;
  const usage = mem[base + 3];
  if (usage >= 0xf0) return null;                            // f1/f2/f3 = buttons
  // vendor shape for a one-step macro: `01 00 83 <usage>` (4 B).
  // `83 <usage>` with padding behind is key down without release; `83 u d u` is
  // a tap and is read by parseMacroFlow().
  // the type is the step count: `0x81` = a single order in the flow
  if (mem[base + 2] === 0x83 && (mem[slot + 1] & 0x7f) === 1) {
    // a single `83 <usage>` order (one-step macro)
    return { usage, offset, len: 4, copies: 1, declared: mem[slot + 1] & 0x7f, macro: true };
  }
  if (mem[base + 2] !== 0x81) return null;
  let copies = 0;
  while (mem[base + 2 + copies * 2] === 0x81 && mem[base + 3 + copies * 2] === usage) copies++;
  if (mem[base + 2 + copies * 2] === 0x01 && mem[base + 3 + copies * 2] === usage) return null;
  return { usage, offset, len: 2 + copies * 2, copies, declared: mem[slot + 1] & 0x7f };
}

// Taps while held: pairs `81 <u> 01 <u>` of the same key with bit 7 of the
// type (the vendor flow in `tap_q`, 13 pairs). Each pair releases before the
// next, so the key cannot stay stuck.
export function readRepeatKey(mem, slot) {
  if (mem[slot] !== 0x01 || !(mem[slot + 1] & 0x80) || mem[slot + 2] !== 0xff) return null;
  if (mem[slot + 6] & 0x80) return null;
  const offset = macroOffset(mem, slot);
  const base = STREAM_BASE + offset;
  if (mem[base] !== 0x01 || mem[base + 1] !== 0x00) return null;
  const usage = mem[base + 3];
  if (mem[base + 2] !== 0x81 || usage >= 0xf0) return null;
  if (mem[base + 4] !== 0x01 || mem[base + 5] !== usage) return null;   // 81 u 01 u
  let pairs = 0;
  while (mem[base + 2 + pairs * 4] === 0x81 && mem[base + 3 + pairs * 4] === usage &&
         mem[base + 4 + pairs * 4] === 0x01 && mem[base + 5 + pairs * 4] === usage) pairs++;
  return { usage, offset, len: 2 + pairs * 4, pairs };
}

export function readMacroStream(mem, k) {
  const slot = MEDIA_SLOT[k];
  if (slot === undefined) return null;
  return parseMacroFlow(mem, slot);
}

// DPI settings the vendor tool lets you pick, with the value it displays
export const DPI_CHOICES = Object.entries(DPI_TABLE).map(([k, v]) => ({ setting: Number(k), dpi: v }))
  .sort((a, b) => a.dpi - b.dpi);

// ------------------------------------------------------------------- LED
// Colours live in nibbles: 0x20–0x31 hold 6 pairs (user colour in the high
// nibble, DPI stage colour in the low) and the 7th user colour takes 0x3E
// (two channels) plus the low nibble of 0x3F, which shares a byte with the
// brightness.
//
// INVERTED LEVEL: the LED is active low, so the byte stores the channel's
// "darkness": it lights up with 15 - value. Checked on hardware — asking for
// (15,0,0) yields (0,255,255), asking for (0,15,15) yields pure red and asking
// for magenta yields green. The channel itself is in place (0x20 R, 0x21 G,
// 0x22 B); what runs backwards is the level, so it is inverted here and the
// rest of the code keeps talking about normal {r,g,b}.
export const LED_ORDER = ["r", "g", "b"];
const LED_TAIL_ORDER = ["r", "g", "b"];   // 0x3E high, 0x3E low, 0x3F low

const hi = (v, n) => (v & 0x0f) | ((n & 0x0f) << 4);
const lo = (v, n) => (v & 0xf0) | (n & 0x0f);
const ch = v => Math.max(0, Math.min(LED_MAX, Math.round(Number(v) || 0)));

// stored level <-> visible level
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

// stored effect: the ones with a fixed cycle nibble first (Button response
// = 0xC, Mute = 0x7), which share id 9 with Cycle breath and Star Trek
function effectOf(mode, bank, cyc) {
  return LED_EFFECTS.find(e => e.mode === mode && e.bank === bank && e.cyc !== undefined && e.cyc === cyc)
    || LED_EFFECTS.find(e => e.mode === mode && e.bank === bank && e.cyc === undefined)
    || null;
}

export function readLed(mem) {
  const profile = (mem[0x0001] >> 5) & 3;
  const user = [], dpi = [];
  for (let i = 0; i < LED_DPI_COUNT; i++) {
    const at = LED.colours + i * 3;
    user.push(ledPick(mem, at, false));
    dpi.push(ledPick(mem, at, true));
  }
  user.push(ledTail(mem));
  const mode = mem[LED.type] >> 4;
  const cyc = mem[LED.type] & 0x0f;
  const bank = (mem[LED.flags] & 0x80) ? 1 : 0;
  const eff = effectOf(mode, bank, cyc);
  // "button response" animation: bits 7–6 of each button action byte
  const react = BUTTONS.map(({ i }) => {
    const addr = buttonAddr(i, profile);
    const byte = addr === undefined ? null : mem[addr];
    return {
      i, addr,
      on: byte === null ? false : (byte & LED_REACT_ON) !== 0,
      type: byte === null ? 0 : (byte & LED_REACT_MASK) >> LED_REACT_SHIFT,
    };
  });
  return {
    effect: eff ? eff.ini : null,
    effectName: eff ? eff.name : `unknown (id ${mode}${bank ? ", bank 2" : ""})`,
    opts: eff ? eff.opts : [],
    mode, bank, cyc,
    raw: mem[LED.type],                    // the byte as-is: high nibble mode, low nibble cycle
    brightness: mem[LED.bright] >> 4,
    speed: cyc,                            // 0x1C low: cycle speed
    mask: mem[LED.cycle] & 0x7f,           // which of the 7 colours join the cycle
    symmetry: !!(mem[LED.feats] & 0x40),
    direction: (mem[LED.feats] & 0x30) >> 4,   // 0 clockwise … 3 magicalady
    user, dpi, react, profile,
  };
}

export function applyLed(img, led) {
  if (!led) return img;
  // the effect wins: it sets the mode nibble, the 0x33 bank and, in Button
  // response and Mute, the cycle nibble the vendor keeps fixed
  if (led.effect !== undefined && led.effect !== null) {
    const e = LED_EFFECTS.find(x => x.ini === Number(led.effect));
    if (e) {
      const speed = e.cyc !== undefined ? e.cyc
        : Number(led.speed !== undefined ? led.speed : img[LED.type] & 0x0f) & 0x0f;
      img[LED.type] = ((e.mode & 0x0f) << 4) | (speed & 0x0f);
      img[LED.flags] = e.bank ? (img[LED.flags] | 0x80) : (img[LED.flags] & ~0x80);
    }
  } else {
    if (led.mode !== undefined) img[LED.type] = hi(img[LED.type], led.mode);
    if (led.bank !== undefined) img[LED.flags] = led.bank ? (img[LED.flags] | 0x80) : (img[LED.flags] & ~0x80);
    if (led.speed !== undefined) img[LED.type] = lo(img[LED.type], led.speed);
  }
  if (led.mask !== undefined) img[LED.cycle] = (img[LED.cycle] & 0x80) | (Number(led.mask) & 0x7f);
  if (led.brightness !== undefined) img[LED.bright] = hi(img[LED.bright], led.brightness);
  if (led.symmetry !== undefined) img[LED.feats] = led.symmetry ? (img[LED.feats] | 0x40) : (img[LED.feats] & ~0x40);
  if (led.direction !== undefined) {
    img[LED.feats] = (img[LED.feats] & ~0x30) | ((Number(led.direction) & 0x03) << 4);
  }
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
  // per-button animation: bits 7–6 of its action byte + the enable bit
  const profile = (img[0x0001] >> 5) & 3;
  for (const r of led.react || []) {
    const addr = buttonAddr(r.i, profile) ?? r.addr;
    if (addr === undefined || addr === null) continue;
    let byte = img[addr] & ~(LED_REACT_MASK | LED_REACT_ON);
    if (r.on) byte |= LED_REACT_ON | ((Number(r.type) & 0x03) << LED_REACT_SHIFT);
    img[addr] = byte;
  }
  return img;
}

export function readConfig(mem, macros = []) {
  const profile = (mem[0x0001] >> 5) & 3;
  const buttons = BUTTONS.map(({ i, name }) => {
    const addr = buttonAddr(i, profile);
    const code = addr === undefined ? null : mem[addr];
    // the advanced action record slots are only measured in profile 1; in the
    // other profiles the byte is shown without interpreting it
    const slot = profile === 0 ? MEDIA_SLOT[i] : undefined;
    let value = null, label = "(unknown)", media = null;
    if (addr === undefined) {
      label = "(not editable in this profile)";
    } else if (code === MEDIA_CODE) {
      media = slot === undefined ? null : readMedia(mem, i);
      if (media && media.id) { value = "m" + media.id; label = media.name; }
      else label = media ? media.name : "(media key)";
    } else if (MACRO_CODES.includes(code)) {
      // 0x2D = the button runs the flow stored at 0x400: a held key, a macro
      // from the list or, if it is a single step, a plain key press
      const hold = slot === undefined ? null : readHoldKey(mem, slot);
      const rep = slot === undefined || hold ? null : readRepeatKey(mem, slot);
      const ms = slot === undefined ? null : readMacroStream(mem, i);
      const hit = ms && macros.find(m => sameSteps(m.steps, ms.steps));
      if (hold) { value = "k" + hold.usage; label = "Key: " + keyName(hold.usage) + " (hold)"; }
      else if (rep) { value = "k" + rep.usage; label = "Key: " + keyName(rep.usage) + " (repeat)"; }
      else if (hit) { value = macroValue(hit.id); label = "Macro: " + (hit.name || "(unnamed)"); }
      else if (ms && ms.steps.length === 1 && ms.steps[0].kind === "key") { value = "k" + ms.steps[0].usage; label = "Key: " + keyName(ms.steps[0].usage); }
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

// Ranges of block 0x400 already used by other macros (so they are not clobbered).
function usedStream(mem, skip) {
  const used = [];
  for (const k of Object.keys(MEDIA_SLOT).map(Number)) {
    if (skip.includes(k)) continue;
    if (!MACRO_CODES.includes(mem[KEY_ADDR[k]])) continue;
    const slot = MEDIA_SLOT[k];
    if (mem[slot] !== 0x01 || mem[slot + 2] !== 0xff) continue;   // type 0x02/0x94/0x9a/0x9b
    const off = macroOffset(mem, slot);
    const len = mem[slot + 8] | (mem[slot + 9] << 8);
    if (len) {
      // the record declares 0x0A but a held-key flow takes 2 + 2·N
      // (42 B with the twenty of the vendor); its pre-expanded flows
      // (type ≥ 0x80) reach 0x38
      const type = mem[slot + 1];
      const hold = readHoldKey(mem, slot);
      const flow = parseMacroFlow(mem, slot);
      const rep = hold ? null : readRepeatKey(mem, slot);
      const size = hold ? hold.len : rep ? rep.len
        : (flow && flow.steps.length ? flow.bytes.length
          : Math.max(len, (type & 0x80) ? 0x38 : len));
      used.push([off, off + size]);
    }
  }
  return used;
}

// Lifts the macro library above the button flow block (0x400–0x4BF). The
// factory image has it at 0x400, right where the button keys and macros go: its
// five records and the "next free" pointers would still point at the new flow
// and the firmware would run another one (measured: a 1 ms tap instead of
// holding the key). The vendor tool does this same move (+0xC0) when the first
// macro is assigned, and its key-holding image already has it up there.
// Idempotent: if the library is already at 0x4C0 nothing is touched.
export function liftLibrary(img) {
  if (img.length < LIB_BASE + LIB_SIZE) return false;   // short image: does not fit
  const addrs = LIB_RECORDS.map(r => img[r + 5] | (img[r + 6] << 8));
  if (!addrs.some(a => a >= STREAM_BASE && a < LIB_BASE)) return false;   // already up
  const blob = Uint8Array.from(img.subarray(STREAM_BASE, STREAM_BASE + LIB_SIZE));
  img.fill(0, STREAM_BASE, STREAM_BASE + LIB_SIZE);
  img.set(blob, LIB_BASE);
  for (const r of LIB_RECORDS) {
    const a = (img[r + 5] | (img[r + 6] << 8)) + LIB_SHIFT;
    img[r + 5] = a & 0xff; img[r + 6] = (a >> 8) & 0xff;
  }
  for (const p of LIB_FREE) {
    const v = img[p] | (img[p + 1] << 8);
    if (v < STREAM_BASE || v >= LIB_BASE + LIB_SHIFT) continue;   // not a pointer into the zone
    const w = v + LIB_SHIFT;
    img[p] = w & 0xff; img[p + 1] = (w >> 8) & 0xff;
  }
  return true;
}

function freeOffset(used, len) {
  // step of 8: block 0x400 is a list of 8-byte records and the mouse resolved
  // a flow starting mid-record wrongly.
  for (let off = 0; off + len <= STREAM_SIZE; off += STEP_LEN)
    if (used.every(([a, b]) => off + len <= a || off >= b)) return off;
  return -1;
}

// How much of the flow arena (0x400–0x4BF, 192 B) is taken by the given edits
// and macros. This is the real limit of the mouse: a held key is 42 B and a
// macro up to 128, and both share the same block, so the step count alone does
// not say whether something fits.
export function arenaUsage(mem, edits = {}, macros = []) {
  const used = usedStream(applyEdits(mem, edits, macros), []);
  const bytes = used.reduce((n, [a, b]) => n + (b - a), 0);
  // what was meant to be written, even if it does not fit: that way the UI can
  // warn that it will not go in instead of showing only what did fit
  const keyMode = edits.keyMode === "tap" ? "tap" : edits.keyMode === "repeat" ? "repeat" : "hold";
  const pairs = Math.min(0x3f, Math.max(1, Math.round(Number(edits.repeatPairs ?? REPEAT_PAIRS) || REPEAT_PAIRS)));
  let wanted = 0;
  for (const value of Object.values(edits.buttons || {})) {
    const a = parseAction(value);
    if (a.key !== undefined) {
      wanted += keyMode === "tap" ? tapStream(a.key).length
        : keyMode === "repeat" ? repeatStream(a.key, pairs).length
        : holdStream(a.key).length;
    } else if (a.macro !== undefined) {
      const m = macros.find(x => x.id === a.macro);
      if (m) wanted += macroFlow(m).length;
    }
  }
  return {
    bytes,
    wanted: Math.ceil(wanted / STEP_LEN) * STEP_LEN,
    size: STREAM_SIZE,
    flows: used.length,
  };
}

// Applies the edits onto a copy of the mouse image: profile, buttons (basic
// function or media key with its record) and DPI stages.
export function applyEdits(mem, edits, macros = []) {
  const img = Uint8Array.from(mem);
  // the macro library, out of the block where the button flows go (see
  // liftLibrary); without this the mouse runs the wrong flow
  liftLibrary(img);
  // the profile the edits go to: the one just picked or, failing that, the one
  // the mouse already has (each profile keeps its buttons in its own block)
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
      if (!m || slot === undefined) continue;   // media: profile 1 only
      img[addr] = (img[addr] & LED_REACT_MASK) | MEDIA_CODE;   // does not clobber the animation
      img.set(mediaRecord(m.usage), slot);
    } else if (action in ACTION_CODE) {
      img[addr] = (img[addr] & LED_REACT_MASK) | ACTION_CODE[action];   // keeps the animation
      if (slot !== undefined) img.fill(0, slot, slot + 10);  // clears the record
    }
  }

  // How a keyboard key assigned to a button gets written. The mode does NOT
  // travel in the action byte (0x2e = library macro, 0x2d = inline): what holds
  // the key is the shape of the flow, with no release inside, plus the macro
  // library not sitting in the block where that flow goes (liftLibrary).
  //   hold   → `81 <usage>` ×20 (42 B, type `0x94`) with action `0x2e`: the
  //            shape of the `kd_shift`/`kd_q` captures, confirmed on hardware —
  //            holding the button holds the key and releasing it releases it.
  //   tap    → `83 <usage> <delay> <usage> 00 00` (8 B): one tap on press.
  //   repeat → pairs `81 <usage> 01 <usage>` (2 B per pair): taps while held,
  //            each pair releases before the next.
  const keyMode = edits.keyMode === "tap" ? "tap" : edits.keyMode === "repeat" ? "repeat" : "hold";
  // Byte 6 of the slot record (the mode). `0x04` = the one the vendor writes;
  // `0x84` is the "Run until Click" label from the docs. Adjustable from Debug
  // until hardware confirms which one is "Run until release".
  const askedMode = edits.slotMode === undefined ? 0x04 : Number(edits.slotMode);
  const modeByte = Number.isFinite(askedMode) ? askedMode & 0xff : 0x04;
  const askedPairs = edits.repeatPairs === undefined ? REPEAT_PAIRS : Number(edits.repeatPairs);
  const pairs = Math.min(0x3f, Math.max(1, Math.round(Number.isFinite(askedPairs) ? askedPairs : REPEAT_PAIRS)));

  // Hardware probe: the same key on buttons 4–7 with the four candidate shapes
  // (see KEY_PROBE_SHAPES), to find out which one really holds.
  if (edits.keyProbe !== undefined && profile === 0) {
    const usage = Number(edits.keyProbe) & 0xff;
    const used = usedStream(img, [4, 5, 6, 7]);
    KEY_PROBE_SHAPES.forEach((sh, i) => {
      const k = 4 + i;
      if (KEY_ADDR[k] === undefined || MEDIA_SLOT[k] === undefined) return;
      const bytes = sh.tap ? tapStream(usage) : holdStream(usage, sh.copies);
      const off = freeOffset(used, bytes.length);
      if (off < 0) return;
      used.push([off, off + bytes.length]);
      img[KEY_ADDR[k]] = (img[KEY_ADDR[k]] & LED_REACT_MASK) | sh.action;
      img.set(sh.tap ? keyMacroRecord(off, 0x0a, modeByte)
        : holdMacroRecord(off, sh.copies, modeByte), MEDIA_SLOT[k]);
      img.set(bytes, STREAM_BASE + off);
    });
  }

  // keyboard keys and macros: a step flow at 0x400 and its record in the button
  // slot. Profile 1 only, which is where the slots are measured.
  const streamEdits = profile !== 0 ? [] : Object.entries(edits.buttons || {})
    .map(([k, v]) => [Number(k), parseAction(v)])
    .filter(([k, a]) => (a.key !== undefined || a.macro !== undefined) &&
      KEY_ADDR[k] !== undefined && MEDIA_SLOT[k] !== undefined)
    .map(([k, a]) => {
      if (a.key !== undefined) return keyMode === "repeat"
        ? [k, repeatStream(a.key, pairs), "repeat", null]
        : keyMode === "hold"
          ? [k, holdStream(a.key), "hold", null]
          : [k, tapStream(a.key), "tap", null];
      const m = macros.find(x => x.id === a.macro);
      return [k, m ? macroStream(m) : new Uint8Array(0), false, m];
    })
    .filter(([, bytes]) => bytes.length);
  if (streamEdits.length) {
    const used = usedStream(img, streamEdits.map(([k]) => k));
    for (const [k, bytes, hold, m] of streamEdits) {
      const off = freeOffset(used, bytes.length);
      if (off < 0) continue;              // does not fit: better leave the button alone
      used.push([off, off + bytes.length]);
      // The mode goes in the action byte: 0x2e = "Run until release"
      // (0x2d = "Repeat On"). Applies to a key just as to a macro.
      const releaseMode = hold === "hold" || (m && m.repeat === "release");
      img[KEY_ADDR[k]] = (img[KEY_ADDR[k]] & LED_REACT_MASK) |
        (releaseMode ? MACRO_RELEASE_CODE : MACRO_CODE);
      img.set(hold === "hold" ? holdMacroRecord(off, HOLD_COPIES, modeByte)
        : hold === "tap" ? keyMacroRecord(off, 0x0a, modeByte)
        : hold === "repeat" ? repeatMacroRecord(off, pairs, modeByte)
        : macroRecord(off, m.repeat || "on", (m.steps || []).length, bytes.length - 2), MEDIA_SLOT[k]);
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

// Blocks to send: the same ones the vendor writes, but only those that change.
// `mem` must be the image read from the mouse so nothing is lost.
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
