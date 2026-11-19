// Cheap UI sanity check: every getElementById in app.js must exist in index.html,
// and the module graph must be importable.
import { readFileSync, existsSync } from "node:fs";
import * as g6 from "../web/g6.js";
import * as core from "../web/core.js";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
const missing = [...used].filter(id => !ids.has(id));
let fails = 0;
const check = (n, c, x = "") => { if (c) console.log("ok   " + n); else { fails++; console.error("FAIL " + n + " " + x); } };

check("index.html referenced ids all exist", missing.length === 0, missing.join(","));
check("html loads app.js as a module", /<script type="module" src="\.\/app\.js">/.test(html));
check("css linked", /href="\.\/style\.css"/.test(html));
const imgSrc = (/<img src="\.\/([^"]+)"/.exec(html) || [])[1];
check("the diagram image exists next to index.html",
  !!imgSrc && existsSync(new URL("../web/" + imgSrc, import.meta.url)), String(imgSrc));
check("g6 exports the wire helpers",
  ["frame", "decode", "writeBlock", "readRequests", "writeMemory", "readMemory", "flush", "WRITE_BLOCKS", "toHex", "fromHex"]
    .every(k => k in g6));
check("core exports the view helpers",
  ["readConfig", "planWrites", "hexdump", "ACTIONS", "DPI_CHOICES"].every(k => k in core));
check("hex <-> bytes round trip", g6.toHex(g6.fromHex("00ff10ab")) === "00ff10ab");

// tabs: each tab points at an existing panel, one per view
const tabs = [...html.matchAll(/<button role="tab"[^>]*data-panel="([^"]+)"[^>]*aria-controls="([^"]+)"/g)];
const panels = [...html.matchAll(/<div class="tabpanel" id="([^"]+)"[^>]*role="tabpanel"/g)].map(m => m[1]);
check("five tabs with their panels", tabs.length === 5 && panels.length === 5, `${tabs.length} tabs / ${panels.length} panels`);
check("every tab controls an existing panel", tabs.every(([, , id]) => panels.includes(id)), tabs.map(t => t[2]).join(","));
const hiddenPanels = panels.filter(id => new RegExp(`id="${id}"[^>]*hidden`).test(html));
check("only lights, macros, backup and debug start hidden",
  hiddenPanels.length === 4 &&
  ["panelLights", "panelMacros", "panelBackup", "panelDebug"].every(id => hiddenPanels.includes(id)),
  hiddenPanels.join(","));

// each view has its own: the editor in Configuration, macros in Macros, the
// files in Backup and the scaffolding (log, dump, diagnostics) in Debug
const slice = (id, next) => html.split(`id="${id}"`)[1].split(next)[0];
const mainPanel = slice("panelMain", 'id="panelLights"');
const lightsPanel = slice("panelLights", 'id="panelMacros"');
const macrosPanel = slice("panelMacros", 'id="panelBackup"');
const backupPanel = slice("panelBackup", 'id="panelDebug"');
const debugPanel = slice("panelDebug", "</main>");
const inPanel = (panel, ids, label) => {
  const missing = ids.filter(id => !panel.includes(`id="${id}"`));
  check(label, missing.length === 0, missing.join(","));
};
inPanel(mainPanel, ["profiles", "buttons", "dpi", "btnApply", "btnDefaults", "applyState"], "editor controls sit in Configuration");
inPanel(lightsPanel, ["ledMode", "ledModeRaw", "ledOptBright", "ledBright", "ledBrightVal",
  "ledOptSpeed", "ledCycle", "ledCycleVal", "ledOptSym", "ledSymmetry", "ledOptDirs", "ledDirs",
  "ledRowFeats", "ledOptReact", "ledReact", "ledHint", "secLedColours", "secLedDpi", "ledUser", "ledDpi",
  "btnApplyLeds",
  "ledApplyState", "ledBar"], "the lighting controls sit in Lighting");
check("the effects panel shows each effect's controls and not another's",
  /ledOptBright"\)\.hidden/.test(app) && /ledOptSpeed"\)\.hidden/.test(app) &&
  /ledOptSym"\)\.hidden/.test(app) && /ledOptReact"\)\.hidden/.test(app) &&
  /ledOptDirs"\)\.hidden/.test(app) && /secLedColours"\)\.hidden/.test(app) &&
  !/secLedDpi"\)\.hidden/.test(app));
check("the button response offers each button's animation",
  /function buildLedReact\(/.test(app) && /LED_REACT_NAMES/.test(app) &&
  /const host = \$\("ledReact"\)/.test(app) && /host\.appendChild\(row\)/.test(app));

// on Linux the native host offers to install the udev rule with nothing copied by hand
inPanel(debugPanel, ["linPerm", "linPermNode", "btnInstallRule", "linPermState"], "the udev-rule helper sits in Debug");
check("the permissions notice is only painted with the native host",
  /__S700_API__/.test(app) && /\/permissions/.test(app) && /\/install-rule/.test(app) &&
  /state\.needed/.test(app));

// the Debug tab carries the byte probe (to look at fields the UI does not expose)
inPanel(debugPanel, ["pokeAddr", "pokeVal", "btnPoke", "btnPokeClear", "pokeState"]);
check("the probe writes into the image and is not saved",
  /pokes\.set\(addr, val\)/.test(app) && /for \(const \[addr, val\] of pokes\) img\[addr\] = val/.test(app));
check("Apply sits after the colours, at the foot of Lighting",
  lightsPanel.indexOf('id="ledDpi"') < lightsPanel.indexOf('id="btnApplyLeds"') &&
  /whole configuration/.test(lightsPanel), "order in the Lighting panel");
inPanel(macrosPanel, ["macroList", "btnMacroNew", "macroName", "macroSteps", "btnMacroAddStep",
  "btnMacroDelete", "macroBytes", "btnApplyMacros", "macroApplyState"], "the macro editor sits in Macros");
inPanel(backupPanel, ["btnBackup", "btnRestore", "fileRestore", "btnLoadSaved", "btnForget", "storageState"], "export/import + browser storage sit in Backup");
inPanel(debugPanel, ["log", "hex", "device", "pauseMs", "btnConnectAll", "btnCopy"], "debug material sits in the Debug tab");
check("order: configuration, then profiles, then DPI",
  mainPanel.indexOf('id="buttons"') < mainPanel.indexOf('id="profiles"') &&
  mainPanel.indexOf('id="profiles"') < mainPanel.indexOf('id="dpi"'));
check("the intro paragraph is gone, its slot only shows on failure",
  /<p class="hint err" id="intro" hidden><\/p>/.test(mainPanel) && /\$\("intro"\)\.hidden = false/.test(app));
check("Apply is at the foot of the configuration block",
  /<div class="body footer">[\s\S]*id="btnApply"[\s\S]*id="btnDefaults"/.test(mainPanel));
check("the old Configuration block is gone",
  !/id="btnStock"|id="btnSave"/.test(html) && !/btnStock|btnSave\(|saveToBrowser/.test(app));
check("app.js wires the tabs and the new actions",
  /function selectTab\(/.test(app) && /initTabs\(\);/.test(app) &&
  /btnDefaults"\)\.onclick/.test(app) && /function importConfig\(/.test(app) && /function scheduleAutosave\(/.test(app));
const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
check("diagram numbers reuse the table badge",
  (app.match(/badge\.className = "num-badge"/g) || []).length === 2 &&
  /\.num-badge \{/.test(css) && /\.diagram \.hot \.num-badge/.test(css));
check("app.js wires the lighting tab",
  /buildLedRows\(\);/.test(app) && /buildLedDirs\(\);/.test(app) && /buildLedReact\(\);/.test(app) &&
  /function renderLeds\(/.test(app) && /btnApplyLeds"\).onclick/.test(app) && /ledMode"\).onchange/.test(app));
check("the old lighting ids are gone (direction was a checkbox)",
  !/id="ledDirection"/.test(html) && !/LED_MODE_IDS|LED_MODE_DARK/.test(app) && !/LED_MODE_IDS|LED_MODE_DARK/.test(html));
check("app.js wires the macro editor",
  ["newMacro", "deleteMacro", "editMacro", "renderMacroList", "renderMacroForm"].every(f => new RegExp(`function ${f}\\(`).test(app)) &&
  /btnMacroNew"\)\.onclick/.test(app) && /btnApplyMacros"\)\.onclick/.test(app));
check("the button select offers the saved macros", /Macros \(profile 1 only\)/.test(app) && /macroValue\(m\.id\)/.test(app));

check("write blocks cover the config areas",
  g6.WRITE_BLOCKS.some(([a, n]) => a === 0x08 && n === 8) &&
  g6.WRITE_BLOCKS.some(([a, n]) => a === 0x4a0 && n === 8));

console.log(fails ? fails + " FAILED" : "all ui checks passed");
if (fails) process.exitCode = 1;
