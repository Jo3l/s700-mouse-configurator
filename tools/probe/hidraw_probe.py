#!/usr/bin/env python3
"""Talk to a /dev/hidraw* through ioctl, no dependencies (to probe the mouse
from a root container, the only way to open the node here).

    python3 tools/probe/hidraw_probe.py /dev/hidraw1

Only GET and SET of feature report 7: it never commits blocks, so it writes
nothing into the mouse memory.
"""
import fcntl
import os
import sys

HIDIOCGRAWNAME = 0x80804804
HIDIOCGFEATURE = lambda n: 0xC0000000 | (n << 16) | (0x48 << 8) | 0x07
HIDIOCSFEATURE = lambda n: 0xC0000000 | (n << 16) | (0x48 << 8) | 0x06


def get_feature(fd, report_id=7, size=65):
    buf = bytearray(size)
    buf[0] = report_id
    try:
        fcntl.ioctl(fd, HIDIOCGFEATURE(size), buf)
    except OSError as exc:
        return "ERR %s" % exc
    return " ".join("%02x" % b for b in buf)


def set_feature(fd, data, size=65):
    buf = bytearray(size)
    buf[:len(data)] = bytes(data)
    try:
        fcntl.ioctl(fd, HIDIOCSFEATURE(size), buf)
        return "ok"
    except OSError as exc:
        return "ERR %s" % exc


def main():
    path = sys.argv[1]
    fd = os.open(path, os.O_RDWR)
    name = bytearray(256)
    try:
        fcntl.ioctl(fd, HIDIOCGRAWNAME, name)
        print("device:", name.split(b"\x00")[0].decode("utf-8", "replace"))
    except OSError as exc:
        print("device: (?)", exc)

    # 1) GET without asking for anything
    print("\n-- GET 7 (idle, twice) --")
    print("  ", get_feature(fd)[:120])
    print("  ", get_feature(fd)[:120])

    # 2) the protocol read: 1 byte at 0x0008  ->  07 18 05 00 08 00 00 00
    print("\n-- SET 18 05 00 08 00 00 00  +  GET --")
    print("  set:", set_feature(fd, [0x07, 0x18, 0x05, 0x00, 0x08, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    # 3) same but at the address the vendor uses (0x0076)
    print("\n-- SET 18 05 00 76 00 00 00  +  GET --")
    print("  set:", set_feature(fd, [0x07, 0x18, 0x05, 0x00, 0x76, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    # 4) burst of 8 (index 0..7) and GETs
    print("\n-- SET burst 0x08 idx 0..7 --")
    for i in range(8):
        set_feature(fd, [0x07, 0x18, 0x05, i, 0x08, 0x00, 0x00, 0x07])
    for _ in range(4):
        print("  get:", get_feature(fd)[:120])

    # 5) what about the id inside the 8-byte data buffer (no id)?
    print("\n-- SET 18 18 05 00 08 00 00 00 (in case the id goes inside) --")
    print("  set:", set_feature(fd, [0x18, 0x05, 0x00, 0x08, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    os.close(fd)


if __name__ == "__main__":
    main()
