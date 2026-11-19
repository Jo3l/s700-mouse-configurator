// ORIEL skin (EVA): the new page has to offer EVERYTHING app.js looks for, with
// no tabs (a single page) and the reference design's tactical frame.
import { readFileSync, existsSync } from "node:fs";

const html = readFileSync(new URL("../web/eva/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const eva = readFileSync(new URL("../web/eva/eva.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/eva/eva.css", import.meta.url), "utf8");
const classic = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

let fails = 0;
const check = (n, c, x = "") => { if (c) console.log("ok   " + n); else { fails++; console.error("FAIL " + n + " " + x); } };

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
const missing = [...used].filter(id => !ids.has(id));
check("eva: every id app.js asks for exists", missing.length === 0, missing.join(","));

check("eva: single page, no tabs", !/role="tab"/.test(html) && !/id="tabs"/.test(html) && !/tabpanel[^>]*hidden/.test(html));
check("eva: the five chapters are still the panels, never hidden",
  ["panelMain", "panelLights", "panelMacros", "panelBackup", "panelDebug"].every(id => ids.has(id)) &&
  !/id="panel\w+"[^>]*hidden/.test(html) &&
  // the floating notice reuses .sec too, but it lives outside main
  (html.match(/<section class="sec" id="panel/g) || []).length === 5);
check("eva: it loads the same app.js as the classic page",
  /<script type="module" src="\.\.\/app\.js"><\/script>/.test(html));
check("eva: its own skin behaviour is loaded", /src="\.\/eva\.js"/.test(html));
check("eva: its own stylesheet is linked", /href="\.\/eva\.css"/.test(html));

// the design's telemetry frame: fixed bars top/bottom, rails, corners and the
// lattice canvas
["frame-bar frame-top", "frame-bar frame-bot", "rail-r", "rail-l", "corner c-tl", "corner c-br"].forEach(cls =>
  check("eva: frame piece " + cls, html.includes(`class="${cls}`)));
["stateTag", "clock", "alt", "tick", "index", "ind", "gl"].forEach(id =>
  check("eva: frame id " + id, ids.has(id)));
check("eva: the kanji index is built from the chapters",
  /data-k="/.test(html) && /dataset\.k/.test(eva) && /aria-current/.test(eva));
check("eva: state machine on scroll", /IntersectionObserver/.test(eva) && /body\.dataset\.state/.test(eva) && /data-state="/.test(html));
check("eva: the scanlines sit on the background canvas, not over the page",
  /#glScan\{[^}]*repeating-linear-gradient\(to bottom/.test(css) && !/body::after/.test(css));
check("eva: canvas lattice fallback when webgl is missing", /getContext\("2d"\)/.test(eva) && /nogl/.test(eva));

// the panels are the same material as the classic page: no id has been lost
const classicIds = new Set([...classic.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const lost = [...classicIds].filter(id => !ids.has(id) && !/^tab/.test(id) && id !== "tabs");
check("eva: no control of the classic page is missing", lost.length === 0, lost.join(","));

// the custom select mounts on the real <select>s, without removing them
check("eva: the custom select wraps the native one",
  /sel-native/.test(eva) && /wrap\.appendChild\(select\)/.test(eva) &&
  /dispatchEvent\(new Event\("change"/.test(eva));
check("eva: it re-enhances the selects that app.js rebuilds",
  /new MutationObserver/.test(eva) && /childList: true, subtree: true/.test(eva));
check("eva: keyboard support in the menu", /ArrowDown/.test(eva) && /Escape/.test(eva) && /aria-haspopup/.test(eva));
check("eva: the custom select looks like a select, not a spine of ribs",
  /--sel:#FC8416/.test(css) && /\.sel-btn\{[^}]*border:1px solid var\(--rule-hi\)/.test(css) &&
  /\.sel-menu\{[^}]*border:1px solid var\(--rule-hi\)/.test(css) &&
  /\.sel-opt\{/.test(css) && !/\.rib-/.test(css) && !/ribIn/.test(css) && !/data-side/.test(eva));
check("eva: the number plate is the component's svg slab",
  /--slab-g:url\("data:image\/svg\+xml,/.test(css) && (css.match(/00FF80/g) || []).length >= 2 &&
  /--slab\(-gf|-o|-of\)?:url\("data:image\/svg\+xml,/.test(css));
check("eva: long lists scroll inside the panel",
  /\.sel-menu\{[^}]*max-height:min\(58vh,340px\)/.test(css) && /overflow:auto/.test(css));
check("eva: opens on click and keyboard, closes on escape or outside",
  /btn\.onclick/.test(eva) && /ArrowDown/.test(eva) && /Escape/.test(eva) &&
  /pointerdown/.test(eva) && !/pointerenter/.test(eva));
check("eva: the css is the ORIEL palette",
  /--phos:#00FF41/.test(css) && /--alarm:#FF2D16/.test(css) && /--unit:#5B4F8C/.test(css) &&
  /--hazard:#FFD400/.test(css) && /--f-disp/.test(css) && /--f-jp/.test(css));
check("eva: panels follow the reference rules (1px rule + corner ticks)",
  /\.panel::before/.test(css) && /\.ph \.jp/.test(css) && /\.sel-menu\s*\{/.test(css) && /\.num-badge\s*\{/.test(css));
check("eva: responsive layout", /@media \(max-width:899px\)/.test(css));
check("eva: offline only (no CDN)", !/https?:\/\/(fonts|cdnjs|unpkg)/.test(html) && !/https?:\/\/(fonts|cdnjs|unpkg)/.test(eva));
// the design's red: marquee, target, pattern, hazard and snap cutting
check("eva: the alarm palette is in the skin",
  /--alarm:#FF2D16/.test(css) && /--hazard:#FFD400/.test(css) && /\.danger\s*\{/.test(css) &&
  /@keyframes marq/.test(css) && /\.pattern \.pv\s*\{/.test(css));
check("eva: the macros chapter wears the other colour",
  /#panelMacros \.sec-h\{color:var\(--alarm\)\}/.test(css) && /#panelMacros button\.primary\{background:var\(--alarm\)/.test(css));
check("eva: snap cutting on enter",
  /\.snap\s*\{animation:snapIn/.test(css) && /@keyframes slice/.test(css) &&
  /function snapIn/.test(eva) && /classList\.add\("snap"\)/.test(eva));
check("eva: the marquee is in the macros chapter", /class="danger"/.test(html) && /MACRO ARENA/.test(html));

// the floating notice on save
["alertLayer", "alert", "alertTitle", "alertNum", "alertMsg", "alertPat", "alertBytes", "alertResult", "alertSectors"].forEach(id =>
  check("eva: alert id " + id, ids.has(id)));
check("eva: the notice is the design's alert section, full width and centred",
  /#alertLayer\{[^}]*position:fixed[^}]*place-items:center/.test(css) &&
  /#alertLayer > #alert\{[^}]*width:100%/.test(css) &&
  /id="alert"[^>]*data-state="alarm"/.test(html) && /class="sectors"/.test(html));
check("eva: the alert is wired to the save actions",
  /btnApplyMacros/.test(eva) && /btnBackup/.test(eva) && /btnCopy/.test(eva) &&
  /function finishAlert/.test(eva) && /statusKind/.test(eva));
check("eva: the regions light up one after the other while writing",
  /function sweepSectors/.test(eva) && /sweepSectors\("SENT"\)/.test(eva) && /\.sector\.wrt\{/.test(css));
check("eva: the notice stays half a screen tall", /#alert \.head\{display:flex/.test(css) &&
  /#alert \.sectors\{display:grid[^}]*repeat\(8/.test(css) && !/#alert \.kv/.test(css));
check("eva: the classic write bar is gone from this skin", /\.bar\{display:none!important\}/.test(css));
check("eva: silence is not reported as success", /No reply from the page/.test(eva) && /result: "UNKNOWN"/.test(eva));
check("eva: the notice tells errors apart from success",
  /kind: bad \? "alert" : "ok"/.test(eva) && /#alertLayer\[data-kind="ok"\]/.test(css));
check("eva: the notice is dismissable and gives the frame back",
  /function hideAlert/.test(eva) && /prevState/.test(eva) &&
  /layer\.addEventListener\("click", hideAlert\)/.test(eva) && /role="status"/.test(html));

// the 3D mesh background, with no CDN, and a 2D fallback
check("eva: the background is a real 3D mesh",
  /getContext\("webgl"/.test(eva) && /mat4 uProj, uView/.test(eva) && /gl\.drawArrays\(gl\.LINES/.test(eva));
check("eva: floor, wall and core geometry",
  /hexSegments\(/.test(eva) && /polySegments\(/.test(eva) && /polySegments\(ico\)/.test(eva) && /polySegments\(dod\)/.test(eva));
check("eva: there is a 2D fallback when webgl is missing",
  /function startLattice/.test(eva) && /startLattice\(canvas\)/.test(eva) && /nogl/.test(css));

// los botones son las costillas del rib-layout del diseño
check("eva: every mouse button is one rib of the spine",
  /#buttons tr:nth-child\(odd\)\{[^}]*margin-right:auto/.test(css) &&
  /#buttons tr:nth-child\(even\)\{[^}]*row-reverse/.test(css) &&
  /#buttons::before\{[^}]*background:linear-gradient\(rgba\(252,132,22/.test(css));
check("eva: the number plate is the component's slab",
  /#buttons \.num-badge\{[^}]*background:var\(--slab-g\)/.test(css) &&
  /#buttons tr\.hasmedia \.num-badge\{background-image:var\(--slab-o\)/.test(css));
check("eva: the mouse photo and the ribs share one row",
  /\.buttons-layout\{[^}]*grid-template-columns:minmax\(/.test(css) &&
  /\.buttons-layout \.diagram\{[^}]*margin:0/.test(css));
check("eva: the ribs fall back to one column on narrow screens",
  /@media \(max-width:899px\)\{[\s\S]*?#buttons tr,\s*#[\s\S]*?width:100%/.test(css));
check("eva: the mouse photo has no filter", !/\.diagram img\{[^}]*filter:/.test(css));

check("eva: the diagram image is inlined by the build",
  /src="\.\/mouse.png"/.test(html) && existsSync(new URL("../web/mouse.png", import.meta.url)));

console.log(fails ? fails + " FAILED" : "all eva ui checks passed");
if (fails) process.exitCode = 1;
