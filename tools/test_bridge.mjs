#!/usr/bin/env node
// Tests for the native host shim (web/bridge.js): that it touches nothing in
// a plain browser and that, with window.__S700_API__, it imitates WebHID by
// talking to the process over HTTP.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../web/bridge.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../native/src/main.rs", import.meta.url), "utf8");
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

// --- in a plain browser the file is inert --------------------------------
{
  const { navigator } = load();
  check("bridge: without a host it does not define navigator.hid", navigator.hid === undefined);
  const plain = load({ api: "" });
  check("bridge: an empty API does not define it either", plain.navigator.hid === undefined);
}

// --- with the host: it imitates WebHID -----------------------------------
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
  check("bridge: navigator.hid is the host's", !!hid && hid.__native === true);

  const list = await hid.getDevices();
  check("bridge: getDevices brings back what is enumerated", list.length === 1 && list[0].productName === "S700 Gaming Mouse", JSON.stringify(list.length));
  check("bridge: the device carries path and opened=false", list[0].__path === "/dev/hidraw1" && list[0].opened === false);
  check("bridge: it declares collection 0xFF00 with report 7",
    list[0].collections[0].usagePage === 0xff00 && list[0].collections[0].featureReports[0].reportId === 7);

  const dev = list[0];
  await dev.open();
  check("bridge: open() asks /api/open for the path", dev.opened && calls.some(c => c.path === "/open" && c.body.path === "/dev/hidraw1"));

  const n = await dev.sendFeatureReport(7, new Uint8Array([1, 2, 3]));
  const sent = calls.filter(c => c.path === "/send").pop();
  check("bridge: sendFeatureReport sends id and bytes", !!sent && sent.body.id === 7 && JSON.stringify(sent.body.data) === "[1,2,3]", JSON.stringify(sent && sent.body));
  check("bridge: it returns the size sent", n === 3);

  let threw = null;
  try { await dev.receiveFeatureReport(7); } catch (e) { threw = e; }
  check("bridge: reading fails like in the firmware", !!threw && /GetFeature/.test(threw.message), threw && threw.message);

  const asked = await hid.requestDevice([{}]);
  check("bridge: requestDevice opens no dialog and returns candidates", asked.length === 1);
  check("bridge: addEventListener does not break", typeof hid.addEventListener === "function" && hid.addEventListener("disconnect", () => {}) === undefined);
}

// --- host errors arrive as an exception ----------------------------------
{
  const { navigator } = load({
    api: "/api",
    routes: {
      "/devices": { ok: true, devices: [DEVICE] },
      "/open": { ok: false, error: "/dev/hidraw1: permission denied" },
      "/send": { ok: false, error: "the device is not open" },
    },
  });
  const dev = (await navigator.hid.getDevices())[0];
  let openErr = null, sendErr = null;
  try { await dev.open(); } catch (e) { openErr = e; }
  try { await dev.sendFeatureReport(7, new Uint8Array([0])); } catch (e) { sendErr = e; }
  check("bridge: the open() error propagates whole", !!openErr && /permission denied/.test(openErr.message), openErr && openErr.message);
  check("bridge: the write error too", !!sendErr && /not open/.test(sendErr.message), sendErr && sendErr.message);
  check("bridge: after failing, the device is not left open", dev.opened === false);
}

console.log(`${ok} checks passed${bad ? ", " + bad + " FAILED" : ""}`);
process.exit(bad ? 1 : 0);

// the host exposes the permission state and the udev rule install
check("main.rs serves /api/permissions and /api/install-rule",
  main.includes('"/api/permissions"') && main.includes('"/api/install-rule"') &&
  main.includes("fn permissions_json") && main.includes("fn elevate_install"));
check("the udev rule travels inside the binary",
  /include_str!\("\.\.\/99-s700-hid\.rules"\)/.test(main));
check("--install-rule re-executes with pkexec",
  main.includes('"--install-rule"') && main.includes('Command::new("pkexec")'));
