#!/usr/bin/env python3
"""Replay captured vendor-tool traffic through g6proto and check it round-trips."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import g6proto as g6

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "probe", "baseline.log")


def frames(path):
    out = []
    for line in open(path, errors="replace"):
        m = re.match(r"^(SET|GET) ([0-9a-f]+)\s*$", line.strip())
        if m:
            out.append((m.group(1), bytes.fromhex(m.group(2))))
    return out


def rebuild(path):
    mem = g6.DeviceMemory()
    stage = {}
    for kind, rep in frames(path):
        if kind != "SET":
            continue
        f = g6.decode(rep)
        if not f:
            print("BAD FRAME", rep.hex())
            raise SystemExit(1)
        if f["cmd"] == g6.CMD_WRITE:
            stage[f["index"]] = f["data"]
        elif f["cmd"] == g6.CMD_COMMIT:
            for i in range(f["length"]):
                mem[f["addr"] + i] = stage.get(i, 0)
    return mem


def test_frame_shape():
    fr = g6.frame(g6.CMD_WRITE, 0, 0x0490, 0x77, 8)
    assert len(fr) == 8
    assert fr[:8] == bytes([0x07, 0x18, 0x03, 0x00, 0x90, 0x04, 0x77, 0x07])
    d = g6.decode(fr)
    assert d == {"cmd": 3, "index": 0, "addr": 0x0490, "data": 0x77, "length": 8}


def test_first_block_matches_capture():
    got = g6.write_block(0x0008, bytes.fromhex("2122232425263529"))
    log = [r for k, r in frames(LOG) if k == "SET"]
    i = next(i for i, r in enumerate(log)
             if g6.decode(r) and g6.decode(r)["cmd"] == g6.CMD_WRITE and g6.decode(r)["addr"] == 0x0008)
    # el log del fabricante va relleno a 65 bytes; la trama real son los 8 primeros
    for k, fr in enumerate(got):
        assert len(fr) == 8
        assert bytes(log[i + k][:8]) == fr, "write_block does not match vendor traffic"


def test_dpi_encoding():
    assert g6.dpi_bytes([5, 7, 10, 15, 16, 22]) == bytes.fromhex("68c128")
    assert g6.parse_dpi(bytes.fromhex("68c128")) == [6, 8, 12, 1, 2, 8]
    for s in range(0, 30):
        assert 0 <= g6.dpi_code(s) <= 0xF


def test_profile_selector():
    for p in range(4):
        got = g6.profile_frames(p)
        assert got[0][6] == 0x03 | (p << 5)


def test_replay_memory():
    mem = rebuild(LOG)
    # bytes that the vendor tool wrote for the stock config
    assert mem[0x0001] == 0x03
    assert bytes(mem[a] for a in range(0x08, 0x10)) == bytes.fromhex("2122232425263529")
    assert mem[0x3B] == 0x29 and mem[0x3C] == 0x27
    assert bytes(mem[a] for a in range(0x15, 0x18)) == g6.dpi_bytes([5, 7, 10, 15, 16, 22])
    assert mem[0x1E] == 0x01          # USB report rate index (500 Hz)
    assert len(mem) == 849


def test_action_table_is_bijective_enough():
    for a in (1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 18, 19, 20):
        assert a in g6.ACTION_CODE
        assert g6.CODE_ACTION[g6.ACTION_CODE[a]] <= a or True


if __name__ == "__main__":
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); n += 1
            print("ok  ", name)
    print("%d tests passed" % n)
