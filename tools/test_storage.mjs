// Almacenamiento en el navegador: ida y vuelta de la configuración y las macros.
// Se simula localStorage en globalThis porque storage.js lo usa igual que en la
// página.
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  },
};
const store = await import("../web/storage.js");

let ok = 0, bad = 0;
const check = (n, c, x = "") => {
  if (c) { ok++; console.log("ok   " + n); }
  else { bad++; console.error("FAIL " + n + " " + x); }
};

check("storage disponible", store.available() === true);
check("sin nada guardado no hay configuración", store.loadConfig() === null);

const img = Uint8Array.from({ length: 0x500 }, (_, i) => i & 0xff);
const rec = store.saveConfig(img, "manual");
check("guarda y devuelve el registro", !!rec && rec.size === 0x500 && rec.source === "manual");
check("el registro lleva fecha", typeof rec.savedAt === "number" && rec.savedAt > 0);

const back = store.loadConfig();
check("recupera la misma imagen", back && back.mem.length === 0x500 &&
  back.mem.every((v, i) => v === img[i]));
check("conserva el origen", back.source === "manual", back && back.source);

store.saveConfig(img, "applied");
check("el origen se actualiza al aplicar", store.loadConfig().source === "applied");

check("las macros empiezan vacías", Array.isArray(store.loadMacros()) && store.loadMacros().length === 0);
store.saveMacros([{ id: "m1", name: "first aid", steps: [{ usage: 0x25, delay: 10 }] }]);
check("las macros se guardan y se leen", store.loadMacros().length === 1 &&
  store.loadMacros()[0].name === "first aid");
check("describe() resume config + macros",
  store.describe().config.size === 0x500 && store.describe().macros === 1);

// espacio de trabajo: base + cambios sin enviar, aparte de la configuración
check("sin trabajo a medias no hay workspace", store.loadWorkspace() === null);
const edits = { buttons: { 3: "3" }, dpi: { 0: 5 }, profile: 1 };
const work = store.saveWorkspace(img, edits, "edited");
check("guarda el workspace con sus cambios", !!work && work.source === "edited" &&
  JSON.stringify(work.edits) === JSON.stringify(edits));
const backWork = store.loadWorkspace();
check("recupera imagen y cambios del workspace", backWork && backWork.mem.length === 0x500 &&
  backWork.mem.every((v, i) => v === img[i]) && backWork.edits.buttons["3"] === "3" &&
  backWork.edits.dpi["0"] === 5 && backWork.edits.profile === 1);
check("el workspace no pisa la configuración guardada", store.loadConfig().source === "applied");
check("describe() dice que hay trabajo sin enviar", !!store.describe().work && store.describe().work.size === 0x500);
store.saveWorkspace(img, {});
check("un workspace sin cambios sigue siendo válido", JSON.stringify(store.loadWorkspace().edits) === "{}");
check("borrar el workspace no toca la configuración",
  store.clearWorkspace() === true && store.loadWorkspace() === null && store.loadConfig() !== null);

check("olvidar borra la configuración", store.clearConfig() === true && store.loadConfig() === null);
check("olvidar no toca las macros", store.loadMacros().length === 1);

// un localStorage que lanza al escribir (modo privado / sin cuota) no debe romper
globalThis.window = { localStorage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} } };
check("sin almacenamiento, available() es false", store.available() === false);
check("sin almacenamiento, guardar no lanza y devuelve null", store.saveConfig(img, "manual") === null);
check("sin almacenamiento, cargar devuelve null", store.loadConfig() === null);
check("sin almacenamiento, describe() lo dice", store.describe().available === false);
check("sin almacenamiento, el workspace no lanza", store.saveWorkspace(img, {}) === null &&
  store.loadWorkspace() === null && store.clearWorkspace() === false);

console.log(bad ? bad + " FAILED" : "all storage checks passed");
if (bad) process.exitCode = 1;
