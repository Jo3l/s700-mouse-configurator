// Enchufe del host nativo (native/): deja que la misma UI hable con el HID del
// proceso en vez de con navigator.hid. En un navegador WebHID pide permiso por
// origen; aquí no hay diálogo porque el proceso ya es dueño del dispositivo.
// Sin window.__S700_API__ (navegador normal) este fichero no hace nada.
(() => {
  const api = window.__S700_API__;
  if (!api || typeof fetch !== "function") return;

  const host = {
    api,
    async post(path, body) {
      const res = await fetch(api + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const out = await res.json().catch(() => ({ ok: false, error: `the host answered ${res.status}` }));
      if (!out.ok) throw new Error(out.error || `the host answered ${res.status}`);
      return out;
    },
    async get(path) {
      const res = await fetch(api + path);
      const out = await res.json().catch(() => ({ ok: false, error: `the host answered ${res.status}` }));
      if (!out.ok) throw new Error(out.error || `the host answered ${res.status}`);
      return out;
    },
  };

  // El descriptor real no hace falta: el host ya filtra las interfaces que
  // declaran el vendor page 0xFF00, y reportBytes() se queda en 64 B sin items.
  const VENDOR = [{ usagePage: 0xff00, usage: 1, inputReports: [], outputReports: [], featureReports: [{ reportId: 7 }] }];

  class Device extends EventTarget {
    constructor(d) {
      super();
      this.__path = d.path;
      this.productName = d.name || "HID device";
      this.vendorId = d.vid || 0;
      this.productId = d.pid || 0;
      this.opened = false;
      this.collections = VENDOR;
    }
    async open() {
      if (this.opened) return;
      const out = await host.post("/open", { path: this.__path });
      this.opened = true;
      if (out.name) this.productName = out.name;
    }
    async close() { this.opened = false; }
    async forget() {}
    async sendFeatureReport(reportId, data) {
      const view = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
      await host.post("/send", { id: reportId, data: Array.from(view) });
      return view.length;
    }
    async receiveFeatureReport() {
      throw new Error("the mouse does not answer GetFeature (docs/PROTOCOL.md §4)");
    }
  }

  const hid = {
    __native: true,
    onconnect: null,
    ondisconnect: null,
    addEventListener() {},
    removeEventListener() {},
    // Aquí no hay concesiones que recordar: si el host ve el ratón, se puede
    // usar, así que la página se conecta sola al cargar.
    async getDevices() {
      const out = await host.get("/devices").catch(() => ({ devices: [] }));
      return (out.devices || []).map(d => new Device(d));
    },
    async requestDevice() {
      // Sin diálogo de permisos: el host devuelve lo que ha enumerado y app.js
      // ordena y abre la primera que responda.
      const out = await host.get("/devices");
      return (out.devices || []).map(d => new Device(d));
    },
  };

  Object.defineProperty(navigator, "hid", { value: hid, configurable: true, writable: false });
  window.__s700Host = host;
})();
