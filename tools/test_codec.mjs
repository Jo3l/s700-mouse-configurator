// Replay the traffic captured from the vendor tool through the browser codec.
import { readFileSync } from "node:fs";
import * as g6 from "../web/g6.js";

const logPath = new URL("../tools/probe/baseline.log", import.meta.url);
const frames = [];
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  const m = /^(SET|GET) ([0-9a-f]+)$/.exec(line.trim());
  if (m) frames.push([m[1], Uint8Array.from(Buffer.from(m[2], "hex"))]);
}

let ok = 0;
function check(name, cond) {
  if (!cond) { console.error("FAIL " + name); process.exitCode = 1; }
  else { ok++; console.log("ok   " + name); }
}

check("frames parsed", frames.length > 1000);

const decoded = frames.filter(([k]) => k === "SET").map(([, r]) => g6.decode(r));
check("every frame decodes", decoded.every(Boolean));

// rebuilding the first block must reproduce the vendor bytes exactly
const setFrames = frames.filter(([k]) => k === "SET").map(([, r]) => r);
const i = setFrames.findIndex(r => g6.decode(r).cmd === g6.CMD.WRITE && g6.decode(r).addr === 0x0008);
const block = g6.writeBlock(0x0008, Uint8Array.from([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x35, 0x29]));
// el log del fabricante va relleno a 65 bytes; la trama real son los 8 primeros
check("writeBlock reproduces vendor frames",
  block.every((f, k) => f.length === 8 && f.every((b, j) => b === setFrames[i + k][j])));

// DPI packing matches the captured bytes
check("dpi packing", Buffer.from(g6.dpiBytes([5, 7, 10, 15, 16, 22])).toString("hex") === "68c128");
check("dpi parse", g6.parseDpi(Uint8Array.from([0x68, 0xc1, 0x28])).join(",") === "6,8,12,1,2,8");

// rebuild the whole memory image from the log
const mem = new Uint8Array(0x500);
const stage = {};
for (const [k, r] of frames) {
  if (k !== "SET") continue;
  const f = g6.decode(r);
  if (f.cmd === g6.CMD.WRITE) stage[f.index] = f.data;
  else if (f.cmd === g6.CMD.COMMIT) for (let n = 0; n < f.length; n++) mem[f.addr + n] = stage[n] ?? 0;
}
check("profile byte", mem[0x0001] === 0x03);
check("button codes", Buffer.from(mem.slice(0x08, 0x10)).toString("hex") === "2122232425263529");
check("extra buttons", mem[0x3b] === 0x29 && mem[0x3c] === 0x27);
check("dpi bytes", Buffer.from(mem.slice(0x15, 0x18)).toString("hex") === "68c128");

check("button addresses decode back to actions",
  g6.CODE_ACTION[mem[g6.KEY_ADDR[0]]] === 1 && g6.CODE_ACTION[mem[g6.KEY_ADDR[6]]] === 14);

console.log(ok + (process.exitCode ? " checks, FAILURES" : " checks passed"));
