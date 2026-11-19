// Persistence in the browser: the last configuration and, in the future, the
// macro collection. It does not touch the mouse; it keeps work from being lost
// between reloads and lets a known configuration be written again without
// rebuilding it by hand.
//
// None of this is the mouse source of truth (it cannot be read: see
// docs/PROTOCOL.md §4). The base is always the factory image from the vendor
// program (web/default_image.js); what is stored here is what you decided.

const NS = "s700";
const K_CONFIG = NS + ".config.v1";
const K_WORK = NS + ".work.v1";
const K_MACROS = NS + ".macros.v1";

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// localStorage may not exist (file:// in some browsers, old private mode) or
// throw when writing without quota: in that case all of this is a no-op.
function store() {
  try {
    const s = window.localStorage;
    const probe = NS + ".probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export const available = () => !!store();

// ------------------------------------------------------------- configuration
export function saveConfig(mem, source = "manual") {
  const s = store();
  if (!s) return null;
  const rec = { version: 1, savedAt: Date.now(), source, size: mem.length, mem: toHex(mem) };
  try {
    s.setItem(K_CONFIG, JSON.stringify(rec));
    return rec;
  } catch {
    return null;
  }
}

export function loadConfig() {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(K_CONFIG);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    const mem = fromHex(rec && rec.mem);
    if (!mem.length) return null;
    return {
      mem,
      savedAt: Number(rec.savedAt) || 0,
      source: rec.source || "manual",
      size: Number(rec.size) || mem.length,
    };
  } catch {
    return null;
  }
}

export function clearConfig() {
  const s = store();
  if (!s) return false;
  try {
    s.removeItem(K_CONFIG);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ workspace
// What you are editing: the base image (saved, imported or factory) plus the
// changes not yet sent to the mouse. It lives apart from K_CONFIG so that
// «Revert to saved» has somewhere to go back to: K_CONFIG is the last thing
// written to the mouse (or imported) and is not overwritten while editing.
export function saveWorkspace(mem, edits, source = "edited") {
  const s = store();
  if (!s) return null;
  const rec = {
    version: 1, savedAt: Date.now(), source,
    size: mem.length, mem: toHex(mem),
    edits: edits && typeof edits === "object" ? edits : {},
  };
  try {
    s.setItem(K_WORK, JSON.stringify(rec));
    return rec;
  } catch {
    return null;
  }
}

export function loadWorkspace() {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(K_WORK);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    const mem = fromHex(rec && rec.mem);
    if (!mem.length) return null;
    return {
      mem,
      edits: rec.edits && typeof rec.edits === "object" ? rec.edits : {},
      savedAt: Number(rec.savedAt) || 0,
      source: rec.source || "edited",
      size: Number(rec.size) || mem.length,
    };
  } catch {
    return null;
  }
}

export function clearWorkspace() {
  const s = store();
  if (!s) return false;
  try {
    s.removeItem(K_WORK);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- macros
// Planned format, no UI yet: [{ id, name, steps: [{ usage, delay, ... }] }]
// Stored as JSON as-is so the format is not locked in before it is implemented.
export function loadMacros() {
  const s = store();
  if (!s) return [];
  try {
    const list = JSON.parse(s.getItem(K_MACROS) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveMacros(list) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(K_MACROS, JSON.stringify(Array.isArray(list) ? list : []));
    return true;
  } catch {
    return false;
  }
}

// Summary for the UI: what is stored and since when.
export function describe() {
  const cfg = loadConfig();
  const work = loadWorkspace();
  return {
    available: available(),
    config: cfg ? { savedAt: cfg.savedAt, source: cfg.source, size: cfg.size } : null,
    work: work ? { savedAt: work.savedAt, size: work.size } : null,
    macros: loadMacros().length,
  };
}
