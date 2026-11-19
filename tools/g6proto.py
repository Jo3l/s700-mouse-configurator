#!/usr/bin/env python3
"""Reference implementation of the S700 (HXSJ) gaming-mouse HID protocol.

No third-party dependencies: this module only encodes/decodes the frames.
You feed it the 65-byte feature reports in and out of the device.

Verified against the vendor tool running under Wine (see tools/hid_shim.c and
tools/probe/): every frame below appears verbatim in tools/probe/baseline.log.
"""

REPORT_ID = 0x07
MAGIC = 0x18              # second byte of every frame
PACKET_LEN = 8            # report id + 7 data bytes (the descriptor declares 56 bits)

CMD_END = 0x00            # close transaction / no-op
CMD_WRITE = 0x03          # stage one data byte
CMD_READ = 0x05           # read one data byte
CMD_COMMIT = 0x09         # commit the staged block
CMD_FLUSH = 0x10          # end of session

PROFILE_SHIFT = 5         # status byte = 0x03 | (profile << 5)


def frame(cmd, index=0, addr=0, data=0, length=0):
    """Build the 8-byte feature report (report id + 7 data bytes).

    The vendor tool passes a 65-byte buffer and the HID stack truncates it; the
    mouse's descriptor declares feature report 7 with 56 bits, and WebHID/hidapi
    reject anything else, so 8 bytes is the real frame size.
    """
    out = bytearray(PACKET_LEN)
    out[0] = REPORT_ID
    out[1] = MAGIC
    out[2] = cmd & 0xFF
    out[3] = index & 0xFF
    out[4] = addr & 0xFF
    out[5] = (addr >> 8) & 0xFF
    out[6] = data & 0xFF
    out[7] = ((length - 1) & 0xFF) if length else 0
    return bytes(out)


def decode(report):
    r = bytes(report)
    if len(r) < 8 or r[0] != REPORT_ID:
        return None
    return {
        "cmd": r[2],
        "index": r[3],
        "addr": r[4] | (r[5] << 8),
        "data": r[6],
        "length": r[7] + 1,
    }


def write_block(addr, payload):
    """Frames to write `payload` at `addr` (vendor tool uses 8-byte bursts)."""
    n = len(payload)
    out = [frame(CMD_WRITE, i, addr, b, n) for i, b in enumerate(payload)]
    out.append(frame(CMD_COMMIT, 0, addr, 0, n))
    out.append(frame(CMD_END, 0, addr, 0, 0))
    return out


def read_requests(addr, n):
    """Frames to read n bytes at addr (send the same addr, index increments)."""
    return [frame(CMD_READ, i, addr, 0, n) for i in range(n)]


def profile_frames(profile):
    """Select which of the 4 onboard profiles is active."""
    return write_block(0x0001, bytes([0x03 | ((profile & 3) << PROFILE_SHIFT)]))


# --------------------------------------------------------------------------
# Action codes: value stored at 0x08..0x0f / 0x3b / 0x3c for a button.
# Measured by sweeping every id through the vendor tool.
# --------------------------------------------------------------------------
ACTION_CODE = {
    0x01: 0x21, 0x02: 0x22, 0x03: 0x23, 0x04: 0x24, 0x05: 0x25, 0x06: 0x26,
    0x07: 0x22, 0x08: 0x23, 0x09: 0x24, 0x0A: 0x25, 0x0B: 0x26, 0x0C: 0x27,
    0x0D: 0x28, 0x0E: 0x29, 0x0F: 0x35, 0x10: 0x2B, 0x11: 0x2C, 0x12: 0x34,
    0x13: 0x37, 0x14: 0x38,
}
# ids >= 0x15 are "advanced" actions: they additionally emit a parameter record.

CODE_ACTION = {}
for _a, _c in ACTION_CODE.items():
    CODE_ACTION.setdefault(_c, _a)

# config.ini K<n> -> device address of the button's action code
KEY_ADDR = {
    0: 0x08, 2: 0x09, 1: 0x0A, 4: 0x0B, 3: 0x0C, 5: 0x0D,
    9: 0x0E, 8: 0x0F, 6: 0x3B, 7: 0x3C,
}

# config.ini DPI_SET<n> -> 4-bit code in 0x15..0x17 (two stages per byte,
# high nibble = even stage, low nibble = odd stage).
def dpi_code(setting):
    s = setting & 0xFF
    return (s + 1) & 0xF if s <= 9 else (s + 2) & 0xF


def dpi_bytes(stages):
    out = []
    for i in range(0, 6, 2):
        out.append((dpi_code(stages[i]) << 4) | dpi_code(stages[i + 1]))
    return bytes(out)          # 3 bytes for 6 stages


def parse_dpi(buf3):
    codes = []
    for b in buf3:
        codes.append(b >> 4)
        codes.append(b & 0x0F)
    return codes


# --------------------------------------------------------------------------
# Memory model helpers
# --------------------------------------------------------------------------
class DeviceMemory(dict):
    """Sparse byte map addr -> value; feed it decoded frames."""

    def apply(self, report):
        f = decode(report)
        if not f:
            return None
        if f["cmd"] == CMD_READ:
            self[f["addr"] + f["index"]] = f["data"]
        return f

    def dump(self, start=0, end=None):
        if end is None:
            end = (max(self) + 1) if self else 0
        return bytes(self.get(a, 0) for a in range(start, end))
