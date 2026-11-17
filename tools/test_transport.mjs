// Capa WebHID: el S700 declara el informe feature 7 con 7 bytes y Chrome rechaza
// cualquier otro tamaño, que fue justo el fallo con el ratón real.
import * as g6 from "../web/g6.js";

const image = new Uint8Array(0x500);
for (let a = 0; a < image.length; a++) image[a] = (a * 7) & 0xff;

let sent = [];
let reply = new Uint8Array(7);

const mock = {
  collections: [{ usagePage: 0xff01, usage: 1, inputReports: [], outputReports: [],
                  featureReports: [{ reportId: 7, items: [{ reportSize: 8, reportCount: 7 }] }] }],
  async sendFeatureReport(reportId, data) {
    if (data.length !== 7) throw new Error("Failed to write the feature report.");
    sent.push(Uint8Array.from([reportId, ...data]));
    const d = g6.decode(Uint8Array.from([reportId, ...data]));
    if (d && d.cmd === g6.CMD.READ) {
      reply = Uint8Array.from(data);
      reply[5] = image[d.addr + d.index];
    }
  },
  async receiveFeatureReport() { return new DataView(reply.slice().buffer); },
};

let fails = 0;
const check = (n, c, x = "") => { if (c) console.log("ok   " + n); else { fails++; console.error("FAIL " + n + " " + x); } };

// descriptor
check("reportBytes(dev) === 7", g6.reportBytes(mock) === 7, String(g6.reportBytes(mock)));
check("trama completa son 8 bytes", g6.PACKET_LEN === 8);

// escritura
sent = [];
await g6.writeMemory(mock, 0x0008, Uint8Array.from([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x35, 0x29]), () => {}, { bytes: g6.reportBytes(mock) });
check("writeMemory emite 10 tramas", sent.length === 10, String(sent.length));
check("cada envío son 7 bytes de datos", sent.every(f => f.length === 8));
const d0 = g6.decode(sent[0]);
check("primera trama: write en 0x0008", d0.cmd === 3 && d0.addr === 8 && d0.data === 0x21 && d0.length === 8);
check("commit/end cierran el bloque", g6.decode(sent[8]).cmd === g6.CMD.COMMIT && g6.decode(sent[9]).cmd === g6.CMD.END);
check("el byte len-1 viaja en la posición 7", sent[0][7] === 7);

// lectura
sent = [];
const bytes = await g6.readMemory(mock, 0x0000, 64, { bytes: 7 });
check("readMemory devuelve los bytes del dispositivo", bytes.every((b, i) => b === image[i]));
check("readMemory envía 64 lecturas de 1 byte", sent.length === 64);
const dr = g6.decode(sent[3]);
check("lectura: índice 0, longitud 1", dr.cmd === 5 && dr.addr === 3 && dr.length === 1 && dr.index === 0);

// sin el tamaño correcto, el dispositivo debe rechazar (esto es lo que fallaba)
let threw = false;
try { await g6.send(mock, g6.frame(g6.CMD.WRITE, 0, 8, 0x21, 8), { bytes: 64 }); } catch { threw = true; }
check("un tamaño equivocado se rechaza", threw);

// ráfaga multi-byte (sin confirmar en hardware)
sent = [];
const burst = await g6.readBlock(mock, 0x0010, 8, { bytes: 7 });
check("readBlock incrementa el índice", g6.decode(sent[7]).index === 7 && burst.every((b, i) => b === image[0x10 + i]));

console.log(fails ? fails + " FAILED" : "all transport checks passed");
if (fails) process.exitCode = 1;
