// Persistencia en el navegador: la última configuración y, a futuro, la colección
// de macros. No toca el ratón; sirve para no perder el trabajo entre recargas y
// para volver a escribir una configuración conocida sin reconstruirla a mano.
//
// Nada de esto es la fuente de verdad del ratón (no se puede leer: ver
// docs/PROTOCOL.md §4). La base siempre es la imagen de fábrica del programa del
// fabricante (web/default_image.js); lo guardado aquí es lo que tú has decidido.

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

// localStorage puede no existir (file:// en algunos navegadores, modo privado
// antiguo) o lanzar al escribir sin cuota: en ese caso todo esto es un no-op.
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

// ------------------------------------------------------------- configuración
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

// --------------------------------------------------------- espacio de trabajo
// Lo que estás editando: la imagen base (guardada, importada o de fábrica) más
// los cambios que aún no se han enviado al ratón. Va aparte de K_CONFIG para que
// «Revert to saved» tenga a dónde volver: K_CONFIG es lo último que se escribió
// en el ratón (o se importó) y no se pisa al editar.
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
// Formato previsto, todavía sin interfaz: [{ id, name, steps: [{ usage, delay, ... }] }]
// Se guarda como JSON tal cual para no cerrar el formato antes de implementarlo.
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

// Resumen para la interfaz: qué hay guardado y desde cuándo.
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
