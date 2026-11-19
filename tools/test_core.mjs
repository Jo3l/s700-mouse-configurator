// Decode the memory image the vendor tool wrote and check the config view.
import { readFileSync } from "node:fs";
import * as g6 from "../web/g6.js";
import { readConfig, readLed, planWrites, applyEdits, applyLed, settingsForCode, DPI_CHOICES, MEDIA_CHOICES, arenaUsage } from "../web/core.js";
import { LED_EFFECTS, LED_DIRECTIONS, LED_REACT_NAMES } from "../web/g6.js";
import { MEDIA_SLOT, MEDIA } from "../web/g6.js";

const frames = [];
for (const line of readFileSync(new URL("../tools/probe/baseline.log", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^(SET|GET) ([0-9a-f]+)$/.exec(line.trim());
  if (m) frames.push([m[1], Uint8Array.from(Buffer.from(m[2], "hex"))]);
}
const mem = new Uint8Array(0x500);
const stage = {};
for (const [k, r] of frames) {
  if (k !== "SET") continue;
  const f = g6.decode(r);
  if (f.cmd === g6.CMD.WRITE) stage[f.index] = f.data;
  else if (f.cmd === g6.CMD.COMMIT) for (let n = 0; n < f.length; n++) mem[f.addr + n] = stage[n] ?? 0;
}

let ok = 0, bad = 0;
const check = (name, cond, extra = "") => {
  if (cond) { ok++; console.log("ok   " + name); }
  else { bad++; console.error("FAIL " + name + " " + extra); }
};

const cfg = readConfig(mem);
check("profile 0", cfg.profile === 0);
const got = cfg.buttons.map(b => b.action);
const want = [1, 3, 2, 5, 4, 6, 14, 12, 14, 15];   // [Config0] K0..K9 of the stock config.ini
check("button actions match config.ini", got.join(",") === want.join(","), got.join(","));
check("button names resolved", cfg.buttons.every(b => b.actionName !== "(unknown)"));
check("dpi codes", cfg.dpi.map(d => d.code).join(",") === "6,8,12,1,2,8");
check("dpi codes map back to known settings",
  cfg.dpi[0].settings.includes(5) && cfg.dpi[2].settings.includes(10) && cfg.dpi[3].settings.includes(15));
check("dpi display resolved where the code is unique",
  [0, 2, 3, 4].map(i => cfg.dpi[i].dpi).join(",") === "1200,2400,6400,7200",
  JSON.stringify(cfg.dpi.map(d => d.dpi)));
check("code 8 is ambiguous (settings 7 and 22 collapse)",
  cfg.dpi[1].settings.length > 1 && cfg.dpi[5].settings.length > 1,
  JSON.stringify(cfg.dpi[1].settings));
check("usb rate", cfg.usbRate === 1);
check("brightness", cfg.brightness === 0);

// with no changes nothing is written
const plan = planWrites(mem, {});
check("no edits, no writes", plan.length === 0, JSON.stringify(plan.map(w => w.addr)));

// one edit writes only the affected blocks
const one = planWrites(mem, { buttons: { 0: "20" } });
check("one button touched = one block", one.length === 1 && one[0].addr === 0x08, JSON.stringify(one.map(w => w.addr)));
check("the block carries the new byte", one[0].payload[0] === 0x38);

// edits land where they should (UI profile 3 = profile 2 = block 0x50)
const edited = planWrites(mem, { profile: 2, buttons: { 0: 20, 6: 1 }, dpi: { 0: 22, 1: 5 } });
const img = Uint8Array.from(mem);
for (const w of edited) img.set(w.payload, w.addr);
check("profile byte written", img[0x0001] === 0x43);
check("button 1 -> 0x50 (profile block)", img[0x50] === 0x38);
check("button 7 -> 0x59 (profile block)", img[0x59] === 0x21);
check("it does not touch the profile 1 slots", img[0x08] === mem[0x08] && img[0x3b] === mem[0x3b]);
check("dpi stage 1/2 repacked", img[0x15] === ((g6.dpiCode(22) << 4) | g6.dpiCode(5)),
  "0x" + img[0x15].toString(16));
check("dpi choices sorted", DPI_CHOICES[0].dpi === 1200 && DPI_CHOICES.at(-1).dpi === 12800);
check("settingsForCode(6) includes 5", settingsForCode(6).includes(5));

// --- media keys ---------------------------------------------------------------
const mute = planWrites(mem, { buttons: { 0: "m30" } });
check("media key = button block + record block", mute.length === 2,
  JSON.stringify(mute.map(w => [w.addr, w.len])));
const mid = applyEdits(mem, { buttons: { 0: "m30" } });
check("media button stores 0x2f", mid[0x08] === 0x2f, "0x" + mid[0x08].toString(16));
const slot0 = MEDIA_SLOT[0];
check("record in slot 0xA0", mid[slot0] === 0x01 && mid[slot0 + 2] === 0xff);
check("record carries the Mute usage (0x00e2)",
  (mid[slot0 + 3] | (mid[slot0 + 4] << 8)) === 0x00e2,
  "0x" + ((mid[slot0 + 3] | (mid[slot0 + 4] << 8)).toString(16)));
check("the rest of the record is 00 04 00 00",
  mid[slot0 + 5] === 0 && mid[slot0 + 6] === 4 && mid[slot0 + 7] === 0 && mid[slot0 + 8] === 0);
check("reads back as the media key",
  readConfig(applyEdits(mem, { buttons: { 0: "m30" } })).buttons[0].action === "m30");

// going back to a normal function clears the record
const back = applyEdits(mid, { buttons: { 0: "1" } });
check("back to a basic function clears the record",
  back[0x08] === 0x21 && back.subarray(slot0, slot0 + 9).every(b => b === 0));

// every slot is distinct and none overlap
const slots = Object.values(MEDIA_SLOT).sort((a, b) => a - b);
check("10 distinct media slots", new Set(slots).size === 10, slots.map(s => s.toString(16)).join(","));
check("no slot overlaps", slots.every((s, i) => i === 0 || s - slots[i - 1] >= 9),
  slots.map(s => s.toString(16)).join(","));
check("10 media keys offered", MEDIA_CHOICES.length === 10 && Object.keys(MEDIA).length === 10);

// an assigned macro (0x2d, captured from the vendor) is recognised but not editable
const withMacro = Uint8Array.from(mem); withMacro[0x0e] = 0x2d;
const mb = readConfig(withMacro).buttons[9];
check("assigned macro is shown as such", mb.actionName.includes("macro"), mb.actionName);
check("macro is not offered as an editable option", mb.action === null);

// the view must reflect pending changes, not just what the mouse holds
{
  const pend = applyEdits(Uint8Array.from(mem), { buttons: { 3: "m26" }, dpi: { 0: 5 } });
  const view = readConfig(pend);
  check("button change visible before applying", view.buttons[3].action === "m26", String(view.buttons[3].action));
  check("dpi change visible before applying", view.dpi[0].settings.includes(5), JSON.stringify(view.dpi[0].settings));
}
{
  const pend = applyEdits(Uint8Array.from(mem), { profile: 2 });
  check("profile change visible before applying", readConfig(pend).profile === 2, String(readConfig(pend).profile));
  check("the buttons shown are the active profile's", readConfig(pend).buttons[0].addr === 0x50,
    String(readConfig(pend).buttons[0].addr));
}

// --- profiles: each one keeps its buttons in its own block --------------------
{
  const p1 = applyEdits(Uint8Array.from(mem), { profile: 1, buttons: { 0: "20", 6: "1" } });
  check("profile 2: K0 at 0x44", p1[0x44] === 0x38, "0x" + p1[0x44].toString(16));
  check("profile 2: K6 at 0x4D", p1[0x4d] === 0x21, "0x" + p1[0x4d].toString(16));
  const p3 = applyEdits(Uint8Array.from(mem), { profile: 3, buttons: { 9: "14" } });
  check("profile 4: K9 at 0x66", p3[0x66] === 0x29, "0x" + p3[0x66].toString(16));
  const p2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 9: "14" } });
  check("profile 3: K9 is left alone (it holds a record)", p2[0x56] === mem[0x56]);
  const media2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 0: "m30" } });
  check("media keys are not written outside profile 1", media2[0x50] === mem[0x50], "0x" + media2[0x50].toString(16));
  const key2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 0: "k20" } });
  check("keyboard key is not written outside profile 1", key2[0x50] === mem[0x50], "0x" + key2[0x50].toString(16));
  check("profile 3: K9 shows as not editable",
    readConfig(applyEdits(Uint8Array.from(mem), { profile: 2 })).buttons[9].actionName === "(not editable in this profile)",
    readConfig(applyEdits(Uint8Array.from(mem), { profile: 2 })).buttons[9].actionName);
}




// keyboard key assigned to a button: TAP, not a held key. The firmware does
// not emit the "release" on "Run until release" (measured on hardware: the
// key stays stuck with the vendor's 20 copies and with a single one), so the
// flow carries the release inside (`83 <usage> <delay> <usage> 00 00`, the
// shape of the vendor's "map" capture).
{
  const hex = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const img = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "tap" });
  check("key: button marked as macro", img[0x0e] === 0x2d);
  check("key: tap record (type 0x02, length 0x0a)",
    hex(img, 0xdc, 10) === "01 02 ff 00 00 00 04 00 0a 00", hex(img, 0xdc, 10));
  check("key: the flow is the vendor's tap step, with its release",
    hex(img, 0x400, 8) === "01 00 83 14 0a 14 00 00", hex(img, 0x400, 8));
  check("key: reads back", readConfig(img).buttons[9].action === "k20");
  check("key: name in the view without «hold»",
    readConfig(img).buttons[9].actionName === "Key: Q", readConfig(img).buttons[9].actionName);

  const two = applyEdits(img, { buttons: { 3: "k225" }, keyMode: "tap" });   // LShift on button 4
  check("two keys do not overwrite each other",
    readConfig(two).buttons[3].action === "k225" && readConfig(two).buttons[9].action === "k20");
  check("the second key carries its offset in byte 5 of the record",
    hex(two, 0xc8, 10) === "01 02 ff 00 00 08 04 00 0a 00", hex(two, 0xc8, 10));
  check("its flow sits at 0x400 + that offset, aligned to 8",
    hex(two, 0x408, 8) === "01 00 83 e1 0a e1 00 00", hex(two, 0x408, 8));

  // 8 B per key: twenty fit easily in the block's 192 B
  const keys = {}; for (let i = 0; i < 10; i++) keys[i] = "k" + (4 + i);
  const ten = readConfig(applyEdits(Uint8Array.from(mem), { buttons: keys, keyMode: "tap" }));
  check("ten keys fit and read back",
    ten.buttons.slice(0, 10).every((b, i) => b.action === "k" + (4 + i)),
    ten.buttons.slice(0, 10).map(b => b.action).join(","));

  // "taps while held" mode: 81/01 pairs and type 0x80 | 2*pairs
  const rep = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "repeat" });
  check("taps: flow of down/up pairs", hex(rep, 0x400, 10) === "01 00 81 14 01 14 81 14 01 14",
    hex(rep, 0x400, 10));
  check("taps: type = 0x80 | 2·pairs (4 pairs → 0x88)",
    hex(rep, 0xdc, 10) === "01 88 ff 00 00 00 04 00 0a 00", hex(rep, 0xdc, 10));
  check("taps: reads back", readConfig(rep).buttons[9].action === "k20");

  // "hold" mode, the default for a key: the vendor's shape of 20 copies,
  // confirmed on the mouse (holds while the button is pressed)
  const hold = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "hold" });
  // exact vendor shape (`usercfg` capture): 20 copies of `81 <usage>`
  check("hold: 20 copies of the step (42 B)",
    hex(hold, 0x400, 6) === "01 00 81 14 81 14" && hex(hold, 0x400 + 40, 2) === "81 14",
    hex(hold, 0x400, 6));
  check("hold: type 0x94 (20 steps) and a 10 B record",
    hex(hold, 0xdc, 10) === "01 94 ff 00 00 00 04 00 0a 00", hex(hold, 0xdc, 10));
  // "Run until release" mode goes in the button's action byte: 0x2e
  // (0x2d is "Repeat On"), measured with the vendor's "mirror" macro
  const addr9 = g6.KEY_ADDR[9];
  check("hold: action 0x2e (run until release)", hold[addr9] === 0x2e, hex(hold, addr9, 1));
  const tap9 = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "tap" });
  check("tap still uses 0x2d", tap9[addr9] === 0x2d, hex(tap9, addr9, 1));
  check("hold: reads back as held",
    readConfig(hold).buttons[9].action === "k20" &&
    readConfig(hold).buttons[9].actionName === "Key: Q (hold)",
    String(readConfig(hold).buttons[9].actionName));

  // a MACRO in "Run until release" also carries action 0x2e
  const macroRel = { id: "mA", name: "hold A", repeat: "release", steps: [{ type: "key", usage: 0x04 }] };
  const relMacro = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmA" } }, [macroRel]);
  check("macro run until release: action 0x2e", relMacro[g6.KEY_ADDR[9]] === 0x2e,
    hex(relMacro, g6.KEY_ADDR[9], 1));
  const onMacro = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmA" } },
    [{ ...macroRel, repeat: "on" }]);
  check("macro repeat on: action 0x2d", onMacro[g6.KEY_ADDR[9]] === 0x2d,
    hex(onMacro, g6.KEY_ADDR[9], 1));

  // the hardware probe writes the same key in 4-7 with all four shapes
  const probe = applyEdits(Uint8Array.from(mem), { keyProbe: 0x0a });
  check("probe: button 4 = 0x2d with 20 copies",
    probe[g6.KEY_ADDR[4]] === 0x2d && hex(probe, g6.MEDIA_SLOT[4], 10) === "01 94 ff 00 00 00 04 00 0a 00",
    hex(probe, g6.MEDIA_SLOT[4], 10));
  check("probe: button 5 = 0x2e with 20 copies",
    probe[g6.KEY_ADDR[5]] === 0x2e && hex(probe, g6.MEDIA_SLOT[5], 10) === "01 94 ff 00 00 30 04 00 0a 00",
    hex(probe, g6.MEDIA_SLOT[5], 10));
  check("probe: button 6 = 0x2d with a tap",
    probe[g6.KEY_ADDR[6]] === 0x2d && hex(probe, g6.MEDIA_SLOT[6], 10) === "01 02 ff 00 00 60 04 00 0a 00",
    hex(probe, g6.MEDIA_SLOT[6], 10));
  check("probe: button 7 = 0x2e with a tap",
    probe[g6.KEY_ADDR[7]] === 0x2e && hex(probe, g6.MEDIA_SLOT[7], 10) === "01 02 ff 00 00 68 04 00 0a 00",
    hex(probe, g6.MEDIA_SLOT[7], 10));

  // the slot record's mode byte is adjustable (Debug -> slot mode):
  // 0x84 is the doc's "Run until Click" label, 0x04 is "Repeat On"
  const m84 = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "hold", slotMode: 0x84 });
  check("slot mode 0x84 reaches the record",
    hex(m84, 0xdc, 10) === "01 94 ff 00 00 00 84 00 0a 00", hex(m84, 0xdc, 10));
  const mtap = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" }, keyMode: "tap", slotMode: 0x84 });
  check("slot mode in tap mode too",
    hex(mtap, 0xdc, 10) === "01 02 ff 00 00 00 84 00 0a 00", hex(mtap, 0xdc, 10));

  // an old image with the key held (one copy) still reads back
  const stale = Uint8Array.from(mem);
  stale[0x0e] = 0x2d;
  stale.set(g6.holdMacroRecord(0), 0xdc);
  stale.set(g6.holdStream(0x04, 1), 0x400);
  check("old image with a held key: it reads back, not «not in the list»",
    readConfig(stale).buttons[9].action === "k4", String(readConfig(stale).buttons[9].action));
  check("old image: it does not lock block 0x400", (() => {
    const out = applyEdits(stale, { buttons: { 0: "k05", 1: "k06", 2: "k07" } });
    return readConfig(out).buttons.slice(0, 3).every((b, i) => b.action === "k" + (5 + i));
  })());

  // The macro library sits above the button block: the factory image has it at
  // 0x400 and it must be lifted (+0xC0) before writing a flow, or its five
  // records keep pointing at what was just written (that is what made the
  // mouse run another flow: a tap instead of a hold)
  const full = new Uint8Array(0x568); full.set(mem);
  const lifted = applyEdits(full, { buttons: { 3: "k225" }, keyMode: "hold" });
  const libAddrs = g6.LIB_RECORDS.map(r => lifted[r + 5] | (lifted[r + 6] << 8));
  check("library: the five records move up to 0x4C0..0x550",
    libAddrs.join(",") === "1216,1248,1296,1344,1360", libAddrs.join(","));
  check("library: the flows move whole (0x400 → 0x4C0)",
    hex(lifted, 0x4c0, 16) === hex(full, 0x400, 16) && hex(lifted, 0x550, 8) === hex(full, 0x490, 8),
    hex(lifted, 0x4c0, 16));
  check("library: the button block is left free for the new flow",
    hex(lifted, 0x400, 8) === "01 00 81 e1 81 e1 81 e1", hex(lifted, 0x400, 8));
  check("library: the «next free slot» pointers move up too",
    (lifted[0x6e] | (lifted[0x6f] << 8)) === 0x568 &&
    (lifted[0x203] | (lifted[0x204] << 8)) === 0x568 &&
    (lifted[0x28f] | (lifted[0x290] << 8)) === 0x568,
    `${hex(lifted, 0x6e, 2)} / ${hex(lifted, 0x203, 2)} / ${hex(lifted, 0x28f, 2)}`);
  check("library: lifting it again changes nothing",
    (() => {
      const again = applyEdits(lifted, { buttons: { 3: "k225" }, keyMode: "hold" });
      return again.every((v, i) => v === lifted[i]);
    })());
  // held-shape capacity: 42 B per key in 192 B -> four, like the vendor
  // (the fifth runs out of room and is left alone)
  const four = {}; for (let i = 0; i < 5; i++) four[i] = "k" + (4 + i);
  const fit = readConfig(applyEdits(full, { buttons: four, keyMode: "hold" }));
  check("held: four keys fit and the fifth does not",
    [0, 1, 2, 3].every(i => fit.buttons[i].action === "k" + (4 + i)) &&
    fit.buttons[4].action !== "k8",
    fit.buttons.slice(0, 5).map(b => b.action).join(","));

  check("library: a short image (0x500) is left alone",
    applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" } }).length === 0x500);

  const back = applyEdits(two, { buttons: { 9: "12" } });
  check("back to a clean function clears the record", back[0xdc] === 0x00 && back[0x0e] === 0x27);
  check("the other key is still intact", readConfig(back).buttons[3].action === "k225");
}

// --- saved macros (several steps) ---------------------------------------------
// New flow: counter (2 B) + variable steps. A single-tap key takes 6 B
// (`83 usage delay usage 00 00`); the record carries the step count as its type.
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const macros = [
    { id: "m1", name: "copy", steps: [{ usage: 0x06, delay: 10 }, { usage: 0x07, delay: 20 }] },
    { id: "m2", name: "tab tab", steps: [{ usage: 0x2b, delay: 5 }] },
  ];
  const img = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } }, macros);
  check("macro: button marked as macro", img[0x0e] === 0x2d);
  check("macro: the record carries the type = number of steps",
    hx(img, 0xdc, 10) === "01 02 ff 00 00 00 04 00 0a 00", hx(img, 0xdc, 10));
  check("macro: first step at 0x400", hx(img, 0x400, 8) === "01 00 83 06 0a 06 00 00", hx(img, 0x400, 8));
  check("macro: second step right behind it (6 B per step)",
    hx(img, 0x408, 6) === "83 07 14 07 00 00", hx(img, 0x408, 6));

  const back = readConfig(img, macros).buttons[9];
  check("macro: reads back with the list", back.action === "xm1", String(back.action));
  check("macro: name in the view", back.actionName === "Macro: copy", back.actionName);
  check("macro: without the list the assignment is not invented", readConfig(img).buttons[9].action === null);
  check("macro: two macros on different buttons do not overwrite each other", (() => {
    const two = applyEdits(img, { buttons: { 3: "xm2" } }, macros);
    const c = readConfig(two, macros);
    return c.buttons[3].action === "xm2" && c.buttons[9].action === "xm1" &&
      hx(two, 0x410, 8) === "01 00 83 2b 05 2b 00 00" &&
      hx(two, 0xc8, 10) === "01 01 ff 00 00 10 04 00 0a 00";
  })());
  check("macro: what does not fit in 0x400 is not written",
    applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } },
      [{ id: "m1", name: "too long", steps: Array.from({ length: 40 }, () => ({ usage: 4, delay: 10 })) }])[0x0e] === mem[0x0e]);
  check("macro: a macro that does not exist leaves the button alone",
    applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmissing" } }, macros)[0x0e] === mem[0x0e]);
  check("macro: back to a clean function clears the record",
    applyEdits(img, { buttons: { 9: "12" } }, macros)[0xdc] === 0x00);
  check("macro: the 21 steps that fit (6 B per step) are allowed in", (() => {
    const full = Array.from({ length: 21 }, () => ({ usage: 4, delay: 10 }));
    const out = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } }, [{ id: "m1", name: "full", steps: full }]);
    return out[0x0e] === 0x2d && out[0xdc + 1] === 21 &&
      out[0x400 + 2 + 20 * 6] === 0x83;      // the last step is still inside the block
  })());
}

// --- the arena is the real limit, and macros go through the same lift ---------
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const full = new Uint8Array(0x568); full.set(mem);
  const macros = [
    { id: "m1", name: "copy", steps: [{ usage: 0x06, delay: 10 }, { usage: 0x07, delay: 20 }] },
    { id: "m2", name: "veintiuno", steps: Array.from({ length: 21 }, () => ({ usage: 4, delay: 10 })) },
  ];
  const img = applyEdits(full, { buttons: { 9: "xm1", 3: "k225" }, keyMode: "hold" }, macros);
  const libAddrs = g6.LIB_RECORDS.map(r => img[r + 5] | (img[r + 6] << 8));
  check("macro: the library is lifted too when assigning a macro",
    libAddrs.join(",") === "1216,1248,1296,1344,1360", libAddrs.join(","));
  check("macro: the flow goes to the arena and the library stays above",
    hx(img, 0x400, 2) === "01 00" && hx(img, 0x4c0, 2) === hx(full, 0x400, 2),
    hx(img, 0x400, 8));
  check("macro: key and macro read back together", (() => {
    const c = readConfig(img, macros);
    return c.buttons[9].action === "xm1" && c.buttons[3].action === "k225";
  })());

  const u1 = arenaUsage(full, { buttons: { 9: "xm1" }, keyMode: "hold" }, [macros[0]]);
  check("arena: a two-tap macro takes 2 + 2·6 = 14 B", u1.bytes === 14 && u1.size === 192, JSON.stringify(u1));
  const u2 = arenaUsage(full, { buttons: { 9: "k20", 3: "k225" }, keyMode: "hold" }, []);
  check("arena: two held keys are 84 B of 192", u2.bytes === 84, JSON.stringify(u2));
  const fourKeys = { 0: "k04", 1: "k05", 2: "k06", 3: "k07", 9: "xm2" };
  const u3 = arenaUsage(full, { buttons: fourKeys, keyMode: "hold" }, [macros[1]]);
  check("arena: four keys (168 B) + a 21-step macro (128 B) do not fit",
    u3.bytes === 168 && u3.wanted === 296 &&
    readConfig(applyEdits(full, { buttons: fourKeys, keyMode: "hold" }, [macros[1]]), [macros[1]]).buttons[9].action !== "xm2",
    JSON.stringify(u3));
}

// --- macros with buttons, movement, DPI and delay (captured with macro.dat) ---
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const m = {
    id: "m3", name: "actions", repeat: "on", count: 3,
    steps: [
      { kind: "mouse", button: "left", dir: "down" },
      { kind: "dpi", dpi: 800, reset: false },
      { kind: "delay", ms: 2 },
      { kind: "move", x: 0, y: -10 },
      { kind: "dpi", dpi: 800, reset: true },
      { kind: "mouse", button: "middle", dir: "down" },
      { kind: "mouse", button: "right", dir: "up" },
    ],
  };
  const img = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm3" } }, [m]);
  check("actions: counter in the first two bytes", hx(img, 0x400, 2) === "03 00", hx(img, 0x400, 2));
  check("actions: left click down", hx(img, 0x402, 2) === "81 f1", hx(img, 0x402, 2));
  check("actions: dpi 800", hx(img, 0x404, 3) === "81 f8 04", hx(img, 0x404, 3));
  check("actions: 2 ms delay", hx(img, 0x407, 3) === "00 01 00", hx(img, 0x407, 3));
  check("actions: move X=0, Y=-10", hx(img, 0x40a, 6) === "01 f6 00 00 f6 ff", hx(img, 0x40a, 6));
  check("actions: restore dpi", hx(img, 0x410, 3) === "01 f8 04", hx(img, 0x410, 3));
  check("actions: middle down and right up", hx(img, 0x413, 4) === "81 f2 01 f3", hx(img, 0x413, 4));
  check("actions: reads back", (() => {
    const b = readConfig(img, [m]).buttons[9];
    return b.action === "xm3" && b.actionName === "Macro: actions";
  })());
  check("actions: repeat-on mode and counter 3 are rebuilt", (() => {
    const f = g6.macroFlow(m);
    return f[0] === 3 && f[1] === 0;
  })());
}

// --- repeat modes: the record carries the mode --------------------------------
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const base = { id: "mr", name: "rep", steps: [{ kind: "mouse", button: "left", dir: "down" }] };
  const on = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmr" } }, [{ ...base, repeat: "on", count: 4 }]);
  check("repeat on: counter in the flow", hx(on, 0x400, 2) === "04 00", hx(on, 0x400, 2));
  check("repeat on: type = number of steps",
    hx(on, 0xdc, 10) === "01 01 ff 00 00 00 04 00 0a 00", hx(on, 0xdc, 10));
  const click = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmr" } }, [{ ...base, repeat: "click" }]);
  check("run until click: byte 6 with bit 7",
    hx(click, 0xdc, 10) === "01 01 ff 00 00 00 84 00 0a 00", hx(click, 0xdc, 10));
  const rel = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmr" } }, [{ ...base, repeat: "release" }]);
  check("run until release: bit 7 + the flow's 2 B words (1 → 0x81)",
    hx(rel, 0xdc, 10) === "01 81 ff 00 00 00 04 00 0a 00", hx(rel, 0xdc, 10));
  // the vendor's nine-tap macro: 9 * 6 B = 54 B = 27 words -> 0x9b
  const nine = {
    id: "m9", name: "nine", repeat: "release",
    steps: Array.from({ length: 9 }, () => ({ kind: "key", usage: 0x04, delay: 10 })),
  };
  const rel9 = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm9" } }, [nine]);
  check("run until release: nine taps → 0x9b, like the vendor",
    hx(rel9, 0xdc, 10) === "01 9b ff 00 00 00 04 00 0a 00", hx(rel9, 0xdc, 10));
}

// --- LED: block 0x1C-0x3F checked against the vendor config.ini ---------------
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const DJ = v => JSON.stringify(v);
  const led = readConfig(mem).led;
  const imgOf = patch => applyEdits(Uint8Array.from(mem), { led: patch });

  const NAMES = ["Breathing", "Cycle breath", "Constantly", "Flow water", "Single water", "Comet tail",
    "Neon", "Ambilight", "Flicker", "Star Trek", "Water", "enraptured", "Button response", "Mute"];
  check("led: the 14 dropdown effects, in their order", DJ(LED_EFFECTS.map(e => e.name)) === DJ(NAMES),
    DJ(LED_EFFECTS.map(e => e.name)));
  check("led: each effect carries id, bank and options",
    LED_EFFECTS.length === 14 && LED_EFFECTS.every(e => typeof e.mode === "number" &&
      (e.bank === 0 || e.bank === 1) && Array.isArray(e.opts)));
  check("led: the options are the ones the vendor shows", (() => {
    const o = n => LED_EFFECTS.find(e => e.name === n).opts.join(",");
    return o("Constantly") === "bright" && o("Star Trek") === "" && o("Mute") === "" &&
      o("Cycle breath") === "speed,colours" && o("Button response") === "react" &&
      o("Flow water") === "speed,bright,colours,symmetry,dir4" && o("Ambilight") === "speed,symmetry,dir2" &&
      o("Single water") === "speed,bright,colours,symmetry,dir3";
  })());

  // factory: 0x1C = 0x94 (id 9, cycle 4) and 0x33 = 0xBF (bit 7 = second bank)
  check("led: from the factory, id 9 + bank 2 = Star Trek (LED_TYPE 9)",
    led.raw === 0x94 && led.bank === 1 && led.cyc === 4 && led.effect === 9 && led.effectName === "Star Trek",
    DJ([led.raw, led.bank, led.effect, led.effectName]));
  check("led: brightness 0 as LED_BRIGHT", led.brightness === 0);
  check("led: CYC_7COL_EN=127 fits in the 7 bits of 0x1D", led.mask === 127);
  check("led: symmetry off and direction 0", !led.symmetry && led.direction === 0);

  // the nibble id is 8 + (index mod 8); the bank comes from the second bank;
  // Button response and Mute leave the cycle fixed at 0xC and 0x7
  const want1c = e => ((e.mode << 4) | (e.cyc !== undefined ? e.cyc : 4)) & 0xff;
  check("led: each effect sends its mode and cycle to 0x1C",
    LED_EFFECTS.every(e => imgOf({ effect: e.ini, speed: 4 })[0x1c] === want1c(e)),
    DJ(LED_EFFECTS.map(e => [e.name, imgOf({ effect: e.ini, speed: 4 })[0x1c].toString(16)])));
  check("led: the bank goes in bit 7 of 0x33 and the rest of the byte is untouched",
    LED_EFFECTS.every(e => {
      const img = imgOf({ effect: e.ini, speed: 4 });
      return ((img[0x33] & 0x80) ? 1 : 0) === e.bank && (img[0x33] & 0x7f) === (mem[0x33] & 0x7f);
    }));
  check("led: Button response (0x9C) and Mute (0x97) ignore the speed slider", (() => {
    const a = imgOf({ effect: 12, speed: 3 }), b = imgOf({ effect: 13, speed: 3 });
    return a[0x1c] === 0x9c && b[0x1c] === 0x97;
  })());
  check("led: the 14 effects read back", LED_EFFECTS.every(e => readLed(imgOf({ effect: e.ini, speed: 5 })).effect === e.ini),
    DJ(LED_EFFECTS.map(e => [e.name, readLed(imgOf({ effect: e.ini, speed: 5 })).effect])));
  check("led: an id the firmware does not know is marked as such", (() => {
    const probe = Uint8Array.from(mem);
    probe[0x1c] = 0x34; probe[0x33] = mem[0x33] & 0x7f;      // id 3, bank 1
    const other = Uint8Array.from(mem);
    other[0x1c] = 0x34;                                       // id 3, bank 2 (the factory one)
    return readLed(probe).effect === null && readLed(probe).effectName === "unknown (id 3)" &&
      readLed(other).effectName === "unknown (id 3, bank 2)";
  })());

  // The vendor config.ini, with the level inverted: the byte stores the
  // "darkness" (the LED lights with 15 - v), checked on hardware.
  const inv = c => ({ r: 15 - c.r, g: 15 - c.g, b: 15 - c.b });
  check("led: the 7 user colours from config.ini (level inverted)", DJ(led.user) === DJ([
    { r: 0, g: 0, b: 15 }, { r: 15, g: 7, b: 3 }, { r: 0, g: 7, b: 0 }, { r: 15, g: 0, b: 11 },
    { r: 0, g: 15, b: 15 }, { r: 15, g: 0, b: 0 }, { r: 0, g: 15, b: 0 }].map(inv)), DJ(led.user));
  check("led: the 6 dpi-stage colours from config.ini (level inverted)", DJ(led.dpi) === DJ([
    { r: 0, g: 15, b: 0 }, { r: 15, g: 15, b: 0 }, { r: 0, g: 15, b: 0 },
    { r: 15, g: 0, b: 15 }, { r: 0, g: 15, b: 15 }, { r: 15, g: 0, b: 0 }].map(inv)), DJ(led.dpi));

  const want = {
    effect: 3, speed: 6, brightness: 7, mask: 1, symmetry: true, direction: 3,
    user: [...led.user.slice(0, 6), { r: 15, g: 0, b: 15 }], dpi: led.dpi,
  };
  const img = imgOf(want);
  check("led: Flow water goes in the high nibble of 0x1C and speed in the low", img[0x1c] === 0xb6, hx(img, 0x1c, 1));
  check("led: brightness goes in the high nibble of 0x3F", img[0x3f] === 0x70, hx(img, 0x3f, 1));
  check("led: the cycle mask respects the high bit of 0x1D", img[0x1d] === 0x81, hx(img, 0x1d, 1));
  check("led: symmetry is bit 6 of 0x3A and direction bits 4–5",
    img[0x3a] === ((mem[0x3a] & ~0x30) | 0x40 | 0x30), hx(img, 0x3a, 1));
  check("led: direction goes from 0 to 3 and reads back",
    LED_DIRECTIONS.length === 4 && [0, 1, 2, 3].every(d =>
      readLed(imgOf({ direction: d })).direction === d && (imgOf({ direction: d })[0x3a] & 0x30) === (d << 4)));
  check("led: colour 7 uses 0x3E and the low nibble of 0x3F", img[0x3e] === 0x0f && (img[0x3f] & 0x0f) === 0x00,
    hx(img, 0x3e, 2));
  const tailRed = imgOf({ user: [...led.user.slice(0, 6), { r: 15, g: 3, b: 0 }] });
  check("led: in colour 7 the inverted level splits R (0), G (12) and B (15)",
    tailRed[0x3e] >> 4 === 0 && (tailRed[0x3e] & 0x0f) === 12 && (tailRed[0x3f] & 0x0f) === 15, hx(tailRed, 0x3e, 2));
  check("led: the paired colours do not overwrite the dpi channel", (img[0x20] >> 4) === 0 && (img[0x20] & 0x0f) === 0);

  const red = imgOf({ user: [{ r: 15, g: 0, b: 0 }, ...led.user.slice(1)] });
  check("led: asking for red stores 0 in 0x20 and 15 in 0x21/0x22 (level inverted)",
    red[0x20] >> 4 === 0 && red[0x21] >> 4 === 15 && red[0x22] >> 4 === 15, hx(red, 0x20, 3));
  const blue = imgOf({ user: [{ r: 0, g: 0, b: 15 }, ...led.user.slice(1)] });
  check("led: asking for blue stores 15 in 0x20/0x21 and 0 in 0x22",
    blue[0x20] >> 4 === 15 && blue[0x21] >> 4 === 15 && blue[0x22] >> 4 === 0, hx(blue, 0x20, 3));
  const green = imgOf({ user: [{ r: 0, g: 15, b: 0 }, ...led.user.slice(1)] });
  check("led: asking for green stores 0 in the middle channel", green[0x21] >> 4 === 0 && green[0x20] >> 4 === 15, hx(green, 0x20, 3));
  check("led: the stored red reads back as red", (() => {
    const probe = Uint8Array.from(mem);
    probe[0x20] = 0; probe[0x21] = 0xff; probe[0x22] = 0xff;   // 0,15,15 stored
    return DJ(readConfig(probe).led.user[0]) === DJ({ r: 15, g: 0, b: 0 });
  })());
  const back2 = readConfig(img).led;   // same key order that readLed returns
  check("led: round trip through applyEdits",
    back2.effect === want.effect && back2.speed === want.speed && back2.brightness === want.brightness &&
    back2.mask === want.mask && back2.symmetry === want.symmetry && back2.direction === want.direction &&
    DJ(back2.user) === DJ(want.user) && DJ(back2.dpi) === DJ(want.dpi), DJ(back2));

  // "button response": each button's animation in bits 7-6 of its action byte
  // (0x08-0x0F and 0x3B-0x3C), with bit 5 as the enable
  const ADDRS = [0x08, 0x0a, 0x09, 0x0c, 0x0b, 0x0d, 0x3b, 0x3c, 0x0f, 0x0e];
  const reactAll = (type, on) => readLed(mem).react.map(r => ({ ...r, type, on }));
  check("led: the button response list is the one from the .exe",
    DJ(LED_REACT_NAMES) === DJ(["Cycle breath", "Flow water", "Comet tail", "Single water"]));
  check("led: the 10 animations land in the 10 action bytes",
    ADDRS.every((a, i) => {
      const out = applyEdits(Uint8Array.from(mem), { led: { react: readLed(mem).react.map(r => (r.i === i ? { ...r, type: 2, on: true } : r)) } });
      return (out[a] & 0xc0) === 0x80 && (out[a] & 0x1f) === (mem[a] & 0x1f);
    }));
  check("led: the animation reads back per button",
    (() => { const o = readLed(applyEdits(Uint8Array.from(mem), { led: { react: reactAll(1, true) } })); return o.react.every(r => r.on && r.type === 1); })());
  check("led: 'off' clears bits 7–6 and the enable bit (like the vendor)",
    (() => {
      const out = applyEdits(Uint8Array.from(mem), { led: { react: reactAll(0, false) } });
      return out[0x08] === 0x01 && readLed(out).react.every(r => !r.on);
    })());
  check("led: changing a button's action does not overwrite its animation", (() => {
    const base = applyEdits(Uint8Array.from(mem), { led: { react: reactAll(1, true) } });
    const out = applyEdits(base, { buttons: { 0: "12" } });   // Show Desktop = 0x27
    return out[0x08] === 0x67;
  })());

  // a brightness-only edit must not touch a single extra byte
  const only = applyEdits(Uint8Array.from(mem), { led: { brightness: 9 } });
  const touched = [...only].map((v, i) => (v !== mem[i] ? i : -1)).filter(i => i >= 0);
  check("led: changing the brightness only touches 0x3F", DJ(touched) === DJ([0x3f]), DJ(touched));
  const clamped = applyLed(Uint8Array.from(mem), { user: [{ r: 99, g: -5, b: 3 }] });
  check("led: applyLed clamps out-of-range channels (99→15, -5→0, 3→3) before inverting",
    clamped[0x20] >> 4 === 0 && clamped[0x21] >> 4 === 15 && clamped[0x22] >> 4 === 12, hx(clamped, 0x20, 3));
}

console.log(`${ok} checks passed${bad ? ", " + bad + " FAILED" : ""}`);
if (bad) process.exitCode = 1;
