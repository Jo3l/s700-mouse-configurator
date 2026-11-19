// Fake mouse to test the configurator in the browser without hardware.
// Mimics the real S700 descriptor and, like Chrome, REJECTS reports of the wrong
// size (feature 7 declares 56 bits = 7 bytes).
//   window.__img  → fake mouse memory (0x500 bytes)
//   window.__sent → frames sent (7 data bytes each)
(function () {
  const MEM = 0x500;
  const img = new Uint8Array(MEM);
  const put = (addr, bytes) => bytes.forEach((b, i) => { img[addr + i] = b; });
  put(0x01, [0x03]);
  put(0x08, [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x35, 0x29]);
  put(0x15, [0x68, 0xc1, 0x28]);
  put(0x1c, [0x94]);
  put(0x1e, [0x01]);
  put(0x3b, [0x29]);
  put(0x3c, [0x27]);

  window.__img = img;
  window.__sent = [];
  window.__stage = new Uint8Array(256);
  let reply = new Uint8Array(7);

  const REPORT_BYTES = 7;

  const dev = {
    opened: false,
    vendorId: 0x30fa,
    productId: 0x1540,
    productName: "USB GAMING MOUSE ",
    collections: [
      { usagePage: 0xff00, usage: 0x01, featureReports: [], outputReports: [],
        inputReports: [{ reportId: 6, items: [{ reportSize: 8, reportCount: 8 }] }] },
      { usagePage: 0xff01, usage: 0x01, inputReports: [], outputReports: [],
        featureReports: [{ reportId: 7, items: [{ reportSize: 8, reportCount: 7 }] }] },
      { usagePage: 0x0c, usage: 0x01, featureReports: [], outputReports: [],
        inputReports: [{ reportId: 2, items: [{ reportSize: 8, reportCount: 2 }] }] },
    ],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener() {}, removeEventListener() {},
    async sendFeatureReport(id, data) {
      if (id !== 7) throw new Error("The report ID is not valid.");
      if (data.length !== REPORT_BYTES) throw new Error("Failed to write the feature report.");
      window.__sent.push(Array.from(data));
      const cmd = data[1], idx = data[2], addr = data[3] | (data[4] << 8), len = data[6] + 1;
      if (cmd === 5) {
        reply = Uint8Array.from(data);
        reply[5] = img[(addr + idx) & (MEM - 1)];
      } else if (cmd === 9) {
        for (let i = 0; i < len; i++) img[(addr + i) & (MEM - 1)] = window.__stage[i];
      } else if (cmd === 3) {
        window.__stage[idx] = data[5];
      }
      return true;
    },
    async receiveFeatureReport(id) {
      if (id !== 7) throw new Error("The report ID is not valid.");
      return new DataView(reply.slice().buffer);
    },
  };

  window.__dev = dev;
  window.__mockHID = function () {
    Object.defineProperty(navigator, "hid", {
      value: {
        getDevices: async () => [dev],
        requestDevice: async () => [dev],
        addEventListener() {}, removeEventListener() {},
      },
      configurable: true,
    });
  };
})();
