// Native host shim (native/): lets the same UI talk to the process HID instead
// of navigator.hid. In a browser WebHID asks for permission per origin; here
// there is no dialog because the process already owns the device.
// Without window.__S700_API__ (normal browser) this file does nothing.
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

  // The real descriptor is not needed: the host already filters the interfaces
  // that declare vendor page 0xFF00, and reportBytes() stays at 64 B with no items.
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
    // There are no grants to remember here: if the host sees the mouse, it can
    // be used, so the page connects on its own when it loads.
    async getDevices() {
      const out = await host.get("/devices").catch(() => ({ devices: [] }));
      return (out.devices || []).map(d => new Device(d));
    },
    async requestDevice() {
      // No permission dialog: the host returns what it enumerated and app.js
      // sorts and opens the first one that answers.
      const out = await host.get("/devices");
      return (out.devices || []).map(d => new Device(d));
    },
  };

  Object.defineProperty(navigator, "hid", { value: hid, configurable: true, writable: false });
  window.__s700Host = host;
})();
