// Decode the memory image the vendor tool wrote and check the config view.
import { readFileSync } from "node:fs";
import * as g6 from "../web/g6.js";
import { readConfig, readLed, planWrites, applyEdits, applyLed, settingsForCode, DPI_CHOICES, MEDIA_CHOICES } from "../web/core.js";
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

// sin cambios no se escribe nada
const plan = planWrites(mem, {});
check("sin ediciones no hay escrituras", plan.length === 0, JSON.stringify(plan.map(w => w.addr)));

// una edición escribe sólo los bloques afectados
const one = planWrites(mem, { buttons: { 0: "20" } });
check("un botón tocado = un bloque", one.length === 1 && one[0].addr === 0x08, JSON.stringify(one.map(w => w.addr)));
check("el bloque lleva el dato nuevo", one[0].payload[0] === 0x38);

// edits land where they should (perfil 3 de la interfaz = perfil 2 = bloque 0x50)
const edited = planWrites(mem, { profile: 2, buttons: { 0: 20, 6: 1 }, dpi: { 0: 22, 1: 5 } });
const img = Uint8Array.from(mem);
for (const w of edited) img.set(w.payload, w.addr);
check("profile byte written", img[0x0001] === 0x43);
check("button 1 -> 0x50 (bloque del perfil)", img[0x50] === 0x38);
check("button 7 -> 0x59 (bloque del perfil)", img[0x59] === 0x21);
check("no toca las ranuras del perfil 1", img[0x08] === mem[0x08] && img[0x3b] === mem[0x3b]);
check("dpi stage 1/2 repacked", img[0x15] === ((g6.dpiCode(22) << 4) | g6.dpiCode(5)),
  "0x" + img[0x15].toString(16));
check("dpi choices sorted", DPI_CHOICES[0].dpi === 1200 && DPI_CHOICES.at(-1).dpi === 12800);
check("settingsForCode(6) includes 5", settingsForCode(6).includes(5));

// --- teclas multimedia -------------------------------------------------
const mute = planWrites(mem, { buttons: { 0: "m30" } });
check("multimedia = bloque del botón + bloque del registro", mute.length === 2,
  JSON.stringify(mute.map(w => [w.addr, w.len])));
const mid = applyEdits(mem, { buttons: { 0: "m30" } });
check("botón multimedia guarda 0x2f", mid[0x08] === 0x2f, "0x" + mid[0x08].toString(16));
const slot0 = MEDIA_SLOT[0];
check("registro en la ranura 0xA0", mid[slot0] === 0x01 && mid[slot0 + 2] === 0xff);
check("registro lleva el usage de Mute (0x00e2)",
  (mid[slot0 + 3] | (mid[slot0 + 4] << 8)) === 0x00e2,
  "0x" + ((mid[slot0 + 3] | (mid[slot0 + 4] << 8)).toString(16)));
check("el resto del registro es 00 04 00 00",
  mid[slot0 + 5] === 0 && mid[slot0 + 6] === 4 && mid[slot0 + 7] === 0 && mid[slot0 + 8] === 0);
check("leer de vuelta da la tecla multimedia",
  readConfig(applyEdits(mem, { buttons: { 0: "m30" } })).buttons[0].action === "m30");

// volver a una función normal limpia el registro
const back = applyEdits(mid, { buttons: { 0: "1" } });
check("volver a básica borra el registro",
  back[0x08] === 0x21 && back.subarray(slot0, slot0 + 9).every(b => b === 0));

// todas las ranuras son distintas y no se solapan
const slots = Object.values(MEDIA_SLOT).sort((a, b) => a - b);
check("10 ranuras multimedia distintas", new Set(slots).size === 10, slots.map(s => s.toString(16)).join(","));
check("ninguna ranura se solapa", slots.every((s, i) => i === 0 || s - slots[i - 1] >= 9),
  slots.map(s => s.toString(16)).join(","));
check("10 teclas multimedia ofrecidas", MEDIA_CHOICES.length === 10 && Object.keys(MEDIA).length === 10);

// una macro asignada (0x2d, capturada del fabricante) se reconoce pero no se edita
const withMacro = Uint8Array.from(mem); withMacro[0x0e] = 0x2d;
const mb = readConfig(withMacro).buttons[9];
check("macro asignada se muestra como tal", mb.actionName.includes("macro"), mb.actionName);
check("macro no se ofrece como opción editable", mb.action === null);

// la vista debe reflejar los cambios pendientes, no sólo lo que hay en el ratón
{
  const pend = applyEdits(Uint8Array.from(mem), { buttons: { 3: "m26" }, dpi: { 0: 5 } });
  const view = readConfig(pend);
  check("cambio de botón visible antes de aplicar", view.buttons[3].action === "m26", String(view.buttons[3].action));
  check("cambio de DPI visible antes de aplicar", view.dpi[0].settings.includes(5), JSON.stringify(view.dpi[0].settings));
}
{
  const pend = applyEdits(Uint8Array.from(mem), { profile: 2 });
  check("cambio de perfil visible antes de aplicar", readConfig(pend).profile === 2, String(readConfig(pend).profile));
  check("los botones que se ven son los del perfil activo", readConfig(pend).buttons[0].addr === 0x50,
    String(readConfig(pend).buttons[0].addr));
}

// --- perfiles: cada uno guarda sus botones en su propio bloque ----------------
{
  const p1 = applyEdits(Uint8Array.from(mem), { profile: 1, buttons: { 0: "20", 6: "1" } });
  check("perfil 2: K0 en 0x44", p1[0x44] === 0x38, "0x" + p1[0x44].toString(16));
  check("perfil 2: K6 en 0x4D", p1[0x4d] === 0x21, "0x" + p1[0x4d].toString(16));
  const p3 = applyEdits(Uint8Array.from(mem), { profile: 3, buttons: { 9: "14" } });
  check("perfil 4: K9 en 0x66", p3[0x66] === 0x29, "0x" + p3[0x66].toString(16));
  const p2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 9: "14" } });
  check("perfil 3: K9 no se toca (guarda un registro)", p2[0x56] === mem[0x56]);
  const media2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 0: "m30" } });
  check("multimedia no se escribe fuera del perfil 1", media2[0x50] === mem[0x50], "0x" + media2[0x50].toString(16));
  const key2 = applyEdits(Uint8Array.from(mem), { profile: 2, buttons: { 0: "k20" } });
  check("tecla de teclado no se escribe fuera del perfil 1", key2[0x50] === mem[0x50], "0x" + key2[0x50].toString(16));
  check("perfil 3: K9 aparece como no editable",
    readConfig(applyEdits(Uint8Array.from(mem), { profile: 2 })).buttons[9].actionName === "(not editable in this profile)",
    readConfig(applyEdits(Uint8Array.from(mem), { profile: 2 })).buttons[9].actionName);
}




// tecla de teclado = macro de un paso. Captura real del fabricante: macro «map»
// (tecla Q) en el botón 10 -> botón 0x2d, registro 01 02 ff 00 00 00 04 00 0a 00,
// flujo 01 00 83 14 0a 14 00 00 01 00
{
  const hex = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const img = applyEdits(Uint8Array.from(mem), { buttons: { 9: "k20" } });
  check("tecla: botón marcado como macro", img[0x0e] === 0x2d);
  check("tecla: registro igual al del fabricante",
    hex(img, 0xdc, 10) === "01 02 ff 00 00 00 04 00 0a 00", hex(img, 0xdc, 10));
  check("tecla: flujo igual al del fabricante",
    hex(img, 0x400, 10) === "01 00 83 14 0a 14 00 00 01 00", hex(img, 0x400, 10));
  check("tecla: se lee de vuelta", readConfig(img).buttons[9].action === "k20");
  check("tecla: nombre en la vista", readConfig(img).buttons[9].actionName === "Key: Q");

  const two = applyEdits(img, { buttons: { 3: "k225" } });   // LShift en el botón 4
  check("dos teclas no se pisan",
    readConfig(two).buttons[3].action === "k225" && readConfig(two).buttons[9].action === "k20");
  check("segunda tecla en su propio tramo", hex(two, 0x40a, 10) === "01 00 83 e1 0a e1 00 00 01 00", hex(two, 0x40a, 10));

  const back = applyEdits(two, { buttons: { 9: "12" } });
  check("volver a una función limpia el registro", back[0xdc] === 0x00 && back[0x0e] === 0x27);
  check("la otra tecla sigue intacta", readConfig(back).buttons[3].action === "k225");
}

// --- macros guardadas (varios pasos) --------------------------------------
// Misma forma que la tecla suelta pero 10 bytes por paso; el registro lleva la
// longitud total (ver docs/PROTOCOL.md §5-ter).
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const macros = [
    { id: "m1", name: "copy", steps: [{ usage: 0x06, delay: 10 }, { usage: 0x07, delay: 20 }] },
    { id: "m2", name: "tab tab", steps: [{ usage: 0x2b, delay: 5 }] },
  ];
  const img = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } }, macros);
  check("macro: botón marcado como macro", img[0x0e] === 0x2d);
  check("macro: el registro lleva la longitud total",
    hx(img, 0xdc, 10) === "01 02 ff 00 00 00 04 00 14 00", hx(img, 0xdc, 10));
  check("macro: primer paso en 0x400", hx(img, 0x400, 10) === "01 00 83 06 0a 06 00 00 01 00", hx(img, 0x400, 10));
  check("macro: segundo paso detrás", hx(img, 0x40a, 10) === "01 00 83 07 14 07 00 00 01 00", hx(img, 0x40a, 10));

  const back = readConfig(img, macros).buttons[9];
  check("macro: se lee de vuelta con la lista", back.action === "xm1", String(back.action));
  check("macro: nombre en la vista", back.actionName === "Macro: copy", back.actionName);
  check("macro: sin la lista no se inventa la asignación", readConfig(img).buttons[9].action === null);
  check("macro: dos macros en botones distintos no se pisan", (() => {
    const two = applyEdits(img, { buttons: { 3: "xm2" } }, macros);
    const c = readConfig(two, macros);
    return c.buttons[3].action === "xm2" && c.buttons[9].action === "xm1" &&
      hx(two, 0x40a + 10, 10) === "01 00 83 2b 05 2b 00 00 01 00";
  })());
  check("macro: lo que no cabe en 0x400 no se escribe",
    applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } },
      [{ id: "m1", name: "too long", steps: Array.from({ length: 17 }, () => ({ usage: 4, delay: 10 })) }])[0x0e] === mem[0x0e]);
  check("macro: una macro que no existe no toca el botón",
    applyEdits(Uint8Array.from(mem), { buttons: { 9: "xmissing" } }, macros)[0x0e] === mem[0x0e]);
  check("macro: volver a una función limpia el registro",
    applyEdits(img, { buttons: { 9: "12" } }, macros)[0xdc] === 0x00);
  check("macro: los 16 pasos que caben se dejan escribir", (() => {
    const full = Array.from({ length: 16 }, () => ({ usage: 4, delay: 10 }));
    const out = applyEdits(Uint8Array.from(mem), { buttons: { 9: "xm1" } }, [{ id: "m1", name: "full", steps: full }]);
    return out[0x0e] === 0x2d && (out[0xdc + 9] << 8 | out[0xdc + 8]) === 160;
  })());
}

// --- LED: bloque 0x1C–0x3F contrastado con el config.ini del fabricante ------
{
  const hx = (a, from, n) => [...a.slice(from, from + n)].map(b => b.toString(16).padStart(2, "0")).join(" ");
  const DJ = v => JSON.stringify(v);
  const led = readConfig(mem).led;
  const imgOf = patch => applyEdits(Uint8Array.from(mem), { led: patch });

  const NAMES = ["Breathing", "Cycle breath", "Constantly", "Flow water", "Single water", "Comet tail",
    "Neon", "Ambilight", "Flicker", "Star Trek", "Water", "enraptured", "Button response", "Mute"];
  check("led: los 14 efectos del desplegable, en su orden", DJ(LED_EFFECTS.map(e => e.name)) === DJ(NAMES),
    DJ(LED_EFFECTS.map(e => e.name)));
  check("led: cada efecto trae id, banco y opciones",
    LED_EFFECTS.length === 14 && LED_EFFECTS.every(e => typeof e.mode === "number" &&
      (e.bank === 0 || e.bank === 1) && Array.isArray(e.opts)));
  check("led: las opciones son las que enseña el fabricante", (() => {
    const o = n => LED_EFFECTS.find(e => e.name === n).opts.join(",");
    return o("Constantly") === "bright" && o("Star Trek") === "" && o("Mute") === "" &&
      o("Cycle breath") === "speed,colours" && o("Button response") === "react" &&
      o("Flow water") === "speed,bright,colours,symmetry,dir4" && o("Ambilight") === "speed,symmetry,dir2" &&
      o("Single water") === "speed,bright,colours,symmetry,dir3";
  })());

  // la fábrica: 0x1C = 0x94 (id 9, ciclo 4) y 0x33 = 0xBF (bit 7 = segunda tanda)
  check("led: de fábrica, id 9 + banco 2 = Star Trek (LED_TYPE 9)",
    led.raw === 0x94 && led.bank === 1 && led.cyc === 4 && led.effect === 9 && led.effectName === "Star Trek",
    DJ([led.raw, led.bank, led.effect, led.effectName]));
  check("led: brillo 0 como LED_BRIGHT", led.brightness === 0);
  check("led: CYC_7COL_EN=127 cabe en los 7 bits de 0x1D", led.mask === 127);
  check("led: simetría apagada y dirección 0", !led.symmetry && led.direction === 0);

  // el id del nibble es 8 + (índice mod 8); el banco lo pone la segunda tanda;
  // Button response y Mute dejan el ciclo fijo en 0xC y 0x7
  const want1c = e => ((e.mode << 4) | (e.cyc !== undefined ? e.cyc : 4)) & 0xff;
  check("led: cada efecto manda su modo y su ciclo a 0x1C",
    LED_EFFECTS.every(e => imgOf({ effect: e.ini, speed: 4 })[0x1c] === want1c(e)),
    DJ(LED_EFFECTS.map(e => [e.name, imgOf({ effect: e.ini, speed: 4 })[0x1c].toString(16)])));
  check("led: el banco va en el bit 7 de 0x33 y el resto del byte no se toca",
    LED_EFFECTS.every(e => {
      const img = imgOf({ effect: e.ini, speed: 4 });
      return ((img[0x33] & 0x80) ? 1 : 0) === e.bank && (img[0x33] & 0x7f) === (mem[0x33] & 0x7f);
    }));
  check("led: Button response (0x9C) y Mute (0x97) ignoran el slider de velocidad", (() => {
    const a = imgOf({ effect: 12, speed: 3 }), b = imgOf({ effect: 13, speed: 3 });
    return a[0x1c] === 0x9c && b[0x1c] === 0x97;
  })());
  check("led: los 14 efectos se leen de vuelta", LED_EFFECTS.every(e => readLed(imgOf({ effect: e.ini, speed: 5 })).effect === e.ini),
    DJ(LED_EFFECTS.map(e => [e.name, readLed(imgOf({ effect: e.ini, speed: 5 })).effect])));
  check("led: un id que el firmware no conoce se marca como tal", (() => {
    const probe = Uint8Array.from(mem);
    probe[0x1c] = 0x34; probe[0x33] = mem[0x33] & 0x7f;      // id 3, banco 1
    const other = Uint8Array.from(mem);
    other[0x1c] = 0x34;                                       // id 3, banco 2 (el de fábrica)
    return readLed(probe).effect === null && readLed(probe).effectName === "unknown (id 3)" &&
      readLed(other).effectName === "unknown (id 3, bank 2)";
  })());

  // El config.ini del fabricante, con el nivel invertido: el byte guarda la
  // "oscuridad" (el LED enciende con 15 - v), comprobado en hardware.
  const inv = c => ({ r: 15 - c.r, g: 15 - c.g, b: 15 - c.b });
  check("led: los 7 colores de usuario del config.ini (nivel invertido)", DJ(led.user) === DJ([
    { r: 0, g: 0, b: 15 }, { r: 15, g: 7, b: 3 }, { r: 0, g: 7, b: 0 }, { r: 15, g: 0, b: 11 },
    { r: 0, g: 15, b: 15 }, { r: 15, g: 0, b: 0 }, { r: 0, g: 15, b: 0 }].map(inv)), DJ(led.user));
  check("led: los 6 colores de etapa de DPI del config.ini (nivel invertido)", DJ(led.dpi) === DJ([
    { r: 0, g: 15, b: 0 }, { r: 15, g: 15, b: 0 }, { r: 0, g: 15, b: 0 },
    { r: 15, g: 0, b: 15 }, { r: 0, g: 15, b: 15 }, { r: 15, g: 0, b: 0 }].map(inv)), DJ(led.dpi));

  const want = {
    effect: 3, speed: 6, brightness: 7, mask: 1, symmetry: true, direction: 3,
    user: [...led.user.slice(0, 6), { r: 15, g: 0, b: 15 }], dpi: led.dpi,
  };
  const img = imgOf(want);
  check("led: Flow water va al nibble alto de 0x1C y la velocidad al bajo", img[0x1c] === 0xb6, hx(img, 0x1c, 1));
  check("led: el brillo va al nibble alto de 0x3F", img[0x3f] === 0x70, hx(img, 0x3f, 1));
  check("led: la máscara del ciclo respeta el bit alto de 0x1D", img[0x1d] === 0x81, hx(img, 0x1d, 1));
  check("led: simetría es el bit 6 de 0x3A y la dirección los bits 4–5",
    img[0x3a] === ((mem[0x3a] & ~0x30) | 0x40 | 0x30), hx(img, 0x3a, 1));
  check("led: la dirección va de 0 a 3 y se lee de vuelta",
    LED_DIRECTIONS.length === 4 && [0, 1, 2, 3].every(d =>
      readLed(imgOf({ direction: d })).direction === d && (imgOf({ direction: d })[0x3a] & 0x30) === (d << 4)));
  check("led: el color 7 usa 0x3E y el nibble bajo de 0x3F", img[0x3e] === 0x0f && (img[0x3f] & 0x0f) === 0x00,
    hx(img, 0x3e, 2));
  const tailRed = imgOf({ user: [...led.user.slice(0, 6), { r: 15, g: 3, b: 0 }] });
  check("led: en el color 7 el nivel invertido reparte R (0), G (12) y B (15)",
    tailRed[0x3e] >> 4 === 0 && (tailRed[0x3e] & 0x0f) === 12 && (tailRed[0x3f] & 0x0f) === 15, hx(tailRed, 0x3e, 2));
  check("led: los colores pareados no pisan el canal de DPI", (img[0x20] >> 4) === 0 && (img[0x20] & 0x0f) === 0);

  const red = imgOf({ user: [{ r: 15, g: 0, b: 0 }, ...led.user.slice(1)] });
  check("led: pedir rojo guarda 0 en 0x20 y 15 en 0x21/0x22 (nivel invertido)",
    red[0x20] >> 4 === 0 && red[0x21] >> 4 === 15 && red[0x22] >> 4 === 15, hx(red, 0x20, 3));
  const blue = imgOf({ user: [{ r: 0, g: 0, b: 15 }, ...led.user.slice(1)] });
  check("led: pedir azul guarda 15 en 0x20/0x21 y 0 en 0x22",
    blue[0x20] >> 4 === 15 && blue[0x21] >> 4 === 15 && blue[0x22] >> 4 === 0, hx(blue, 0x20, 3));
  const green = imgOf({ user: [{ r: 0, g: 15, b: 0 }, ...led.user.slice(1)] });
  check("led: pedir verde guarda 0 en el canal del medio", green[0x21] >> 4 === 0 && green[0x20] >> 4 === 15, hx(green, 0x20, 3));
  check("led: el rojo guardado se lee como rojo", (() => {
    const probe = Uint8Array.from(mem);
    probe[0x20] = 0; probe[0x21] = 0xff; probe[0x22] = 0xff;   // 0,15,15 guardado
    return DJ(readConfig(probe).led.user[0]) === DJ({ r: 15, g: 0, b: 0 });
  })());
  const back2 = readConfig(img).led;   // mismo orden de claves que devuelve readLed
  check("led: ida y vuelta por applyEdits",
    back2.effect === want.effect && back2.speed === want.speed && back2.brightness === want.brightness &&
    back2.mask === want.mask && back2.symmetry === want.symmetry && back2.direction === want.direction &&
    DJ(back2.user) === DJ(want.user) && DJ(back2.dpi) === DJ(want.dpi), DJ(back2));

  // "button response": la animación de cada botón en los bits 7–6 de su byte de
  // acción (0x08–0x0F y 0x3B–0x3C), con el bit 5 de activado
  const ADDRS = [0x08, 0x0a, 0x09, 0x0c, 0x0b, 0x0d, 0x3b, 0x3c, 0x0f, 0x0e];
  const reactAll = (type, on) => readLed(mem).react.map(r => ({ ...r, type, on }));
  check("led: la lista del button response es la del .exe",
    DJ(LED_REACT_NAMES) === DJ(["Cycle breath", "Flow water", "Comet tail", "Single water"]));
  check("led: las 10 animaciones caen en los 10 bytes de acción",
    ADDRS.every((a, i) => {
      const out = applyEdits(Uint8Array.from(mem), { led: { react: readLed(mem).react.map(r => (r.i === i ? { ...r, type: 2, on: true } : r)) } });
      return (out[a] & 0xc0) === 0x80 && (out[a] & 0x1f) === (mem[a] & 0x1f);
    }));
  check("led: la animación se lee de vuelta por botón",
    (() => { const o = readLed(applyEdits(Uint8Array.from(mem), { led: { react: reactAll(1, true) } })); return o.react.every(r => r.on && r.type === 1); })());
  check("led: 'off' borra los bits 7–6 y el bit de activado (como el fabricante)",
    (() => {
      const out = applyEdits(Uint8Array.from(mem), { led: { react: reactAll(0, false) } });
      return out[0x08] === 0x01 && readLed(out).react.every(r => !r.on);
    })());
  check("led: cambiar la acción de un botón no pisa su animación", (() => {
    const base = applyEdits(Uint8Array.from(mem), { led: { react: reactAll(1, true) } });
    const out = applyEdits(base, { buttons: { 0: "12" } });   // Show Desktop = 0x27
    return out[0x08] === 0x67;
  })());

  // una sola edición de brillo no debe tocar ni un byte más
  const only = applyEdits(Uint8Array.from(mem), { led: { brightness: 9 } });
  const touched = [...only].map((v, i) => (v !== mem[i] ? i : -1)).filter(i => i >= 0);
  check("led: cambiar el brillo sólo toca 0x3F", DJ(touched) === DJ([0x3f]), DJ(touched));
  const clamped = applyLed(Uint8Array.from(mem), { user: [{ r: 99, g: -5, b: 3 }] });
  check("led: applyLed recorta los canales fuera de rango (99→15, -5→0, 3→3) antes de invertir",
    clamped[0x20] >> 4 === 0 && clamped[0x21] >> 4 === 15 && clamped[0x22] >> 4 === 12, hx(clamped, 0x20, 3));
}

console.log(`${ok} checks passed${bad ? ", " + bad + " FAILED" : ""}`);
if (bad) process.exitCode = 1;
