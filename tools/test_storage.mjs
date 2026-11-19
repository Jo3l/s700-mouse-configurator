// Browser storage: round trip of the configuration and the macros. localStorage
// is faked on globalThis because storage.js uses it just as it does on the page.
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

check("storage available", store.available() === true);
check("with nothing saved there is no configuration", store.loadConfig() === null);

const img = Uint8Array.from({ length: 0x500 }, (_, i) => i & 0xff);
const rec = store.saveConfig(img, "manual");
check("saves and returns the record", !!rec && rec.size === 0x500 && rec.source === "manual");
check("the record carries a date", typeof rec.savedAt === "number" && rec.savedAt > 0);

const back = store.loadConfig();
check("recovers the same image", back && back.mem.length === 0x500 &&
  back.mem.every((v, i) => v === img[i]));
check("keeps the source", back.source === "manual", back && back.source);

store.saveConfig(img, "applied");
check("the source updates on apply", store.loadConfig().source === "applied");

check("the macros start empty", Array.isArray(store.loadMacros()) && store.loadMacros().length === 0);
store.saveMacros([{ id: "m1", name: "first aid", steps: [{ usage: 0x25, delay: 10 }] }]);
check("the macros are saved and read back", store.loadMacros().length === 1 &&
  store.loadMacros()[0].name === "first aid");
check("describe() resume config + macros",
  store.describe().config.size === 0x500 && store.describe().macros === 1);

// workspace: base + unsent changes, kept apart from the configuration
check("with no work in progress there is no workspace", store.loadWorkspace() === null);
const edits = { buttons: { 3: "3" }, dpi: { 0: 5 }, profile: 1 };
const work = store.saveWorkspace(img, edits, "edited");
check("saves the workspace with its changes", !!work && work.source === "edited" &&
  JSON.stringify(work.edits) === JSON.stringify(edits));
const backWork = store.loadWorkspace();
check("recovers the image and changes from the workspace", backWork && backWork.mem.length === 0x500 &&
  backWork.mem.every((v, i) => v === img[i]) && backWork.edits.buttons["3"] === "3" &&
  backWork.edits.dpi["0"] === 5 && backWork.edits.profile === 1);
check("the workspace does not overwrite the saved configuration", store.loadConfig().source === "applied");
check("describe() says there is unsent work", !!store.describe().work && store.describe().work.size === 0x500);
store.saveWorkspace(img, {});
check("a workspace with no changes is still valid", JSON.stringify(store.loadWorkspace().edits) === "{}");
check("clearing the workspace leaves the configuration alone",
  store.clearWorkspace() === true && store.loadWorkspace() === null && store.loadConfig() !== null);

check("forgetting clears the configuration", store.clearConfig() === true && store.loadConfig() === null);
check("forgetting leaves the macros alone", store.loadMacros().length === 1);

// a localStorage that throws on write (private mode / no quota) must not break
globalThis.window = { localStorage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} } };
check("without storage, available() is false", store.available() === false);
check("without storage, saving does not throw and returns null", store.saveConfig(img, "manual") === null);
check("without storage, loading returns null", store.loadConfig() === null);
check("without storage, describe() says so", store.describe().available === false);
check("without storage, the workspace does not throw", store.saveWorkspace(img, {}) === null &&
  store.loadWorkspace() === null && store.clearWorkspace() === false);

console.log(bad ? bad + " FAILED" : "all storage checks passed");
if (bad) process.exitCode = 1;
