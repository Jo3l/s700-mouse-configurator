#!/usr/bin/env node
// Pruebas del enchufe del host nativo (web/bridge.js): que no toque nada en un
// navegador normal y que, con window.__S700_API__, imite a WebHID hablando con
// el proceso por HTTP.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../web/bridge.js", import.meta.url), "utf8");
let ok = 0, bad = 0;
const check = (name, cond, extra = "") => {
  if (cond) { ok++; console.log("ok   " + name); }
  else { bad++; console.log("FAIL " + name + (extra ? "  " + extra : "")); }
};

const DEVICE = { path: "/dev/hidraw1", name: "S700 Gaming Mouse", vid: 0x30fa, pid: 0x1540 };

function load({ api = null, routes = {} } = {}) {
  const calls = [];
  const navigator = {};
  const window = {};
  if (api) window.__S700_API__ = api;
  const fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^.*\/api/, "");
    calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[path];
    const out = typeof hit === "function" ? hit(opts) : hit;
    return { status: 200, json: async () => out ?? { ok: true } };
  };
  const sandbox = { window, navigator, fetch, EventTarget, console, JSON, Object, Array, Uint8Array, Error, Number, String, Math, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { navigator, calls, window };
}

// --- en un navegador normal el fichero es inerte -------------------------
{
  const { navigator } = load();
  check("bridge: sin host no define navigator.hid", navigator.hid === undefined);
  const plain = load({ api: "" });
  check("bridge: una API vacía tampoco lo define", plain.navigator.hid === undefined);
}

// --- con el host: imita WebHID ------------------------------------------
{
  const { navigator, calls } = load({
    api: "/api",
    routes: {
      "/devices": { ok: true, devices: [DEVICE] },
      "/open": { ok: true, name: "S700 Gaming Mouse", bytes: 64 },
      "/send": { ok: true, wrote: 65 },
    },
  });
  const hid = navigator.hid;
  check("bridge: navigator.hid es el del host", !!hid && hid.__native === true);

  const list = await hid.getDevices();
  check("bridge: getDevices trae lo enumerado", list.length === 1 && list[0].productName === "S700 Gaming Mouse", JSON.stringify(list.length));
  check("bridge: el dispositivo lleva path y opened=false", list[0].__path === "/dev/hidraw1" && list[0].opened === false);
  check("bridge: declara la colección 0xFF00 con el informe 7",
    list[0].collections[0].usagePage === 0xff00 && list[0].collections[0].featureReports[0].reportId === 7);

  const dev = list[0];
  await dev.open();
  check("bridge: open() pide /api/open con la ruta", dev.opened && calls.some(c => c.path === "/open" && c.body.path === "/dev/hidraw1"));

  const n = await dev.sendFeatureReport(7, new Uint8Array([1, 2, 3]));
  const sent = calls.filter(c => c.path === "/send").pop();
  check("bridge: sendFeatureReport manda id y bytes", !!sent && sent.body.id === 7 && JSON.stringify(sent.body.data) === "[1,2,3]", JSON.stringify(sent && sent.body));
  check("bridge: devuelve el tamaño enviado", n === 3);

  let threw = null;
  try { await dev.receiveFeatureReport(7); } catch (e) { threw = e; }
  check("bridge: leer falla como en el firmware", !!threw && /GetFeature/.test(threw.message), threw && threw.message);

  const asked = await hid.requestDevice([{}]);
  check("bridge: requestDevice no abre diálogo y devuelve candidatos", asked.length === 1);
  check("bridge: addEventListener no rompe", typeof hid.addEventListener === "function" && hid.addEventListener("disconnect", () => {}) === undefined);
}

// --- errores del host llegan como excepción -----------------------------
{
  const { navigator } = load({
    api: "/api",
    routes: {
      "/devices": { ok: true, devices: [DEVICE] },
      "/open": { ok: false, error: "/dev/hidraw1: permission denied" },
      "/send": { ok: false, error: "el dispositivo no está abierto" },
    },
  });
  const dev = (await navigator.hid.getDevices())[0];
  let openErr = null, sendErr = null;
  try { await dev.open(); } catch (e) { openErr = e; }
  try { await dev.sendFeatureReport(7, new Uint8Array([0])); } catch (e) { sendErr = e; }
  check("bridge: el error de open() se propaga entero", !!openErr && /permission denied/.test(openErr.message), openErr && openErr.message);
  check("bridge: el error de escritura también", !!sendErr && /no está abierto/.test(sendErr.message), sendErr && sendErr.message);
  check("bridge: tras fallar, el dispositivo no queda abierto", dev.opened === false);
}

console.log(`${ok} checks passed${bad ? ", " + bad + " FAILED" : ""}`);
process.exit(bad ? 1 : 0);
