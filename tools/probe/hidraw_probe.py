#!/usr/bin/env python3
"""Habla con un /dev/hidraw* por ioctl, sin dependencias (para probar el ratón
desde un contenedor con root, que es la única forma de abrir el nodo aquí).

    python3 tools/probe/hidraw_probe.py /dev/hidraw1

Sólo hace GET y SET de informes feature 7: no confirma bloques, así que no
escribe nada en la memoria del ratón.
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

    # 1) GET sin pedir nada
    print("\n-- GET 7 (idle, dos veces) --")
    print("  ", get_feature(fd)[:120])
    print("  ", get_feature(fd)[:120])

    # 2) la lectura del protocolo: 1 byte en 0x0008  ->  07 18 05 00 08 00 00 00
    print("\n-- SET 18 05 00 08 00 00 00  +  GET --")
    print("  set:", set_feature(fd, [0x07, 0x18, 0x05, 0x00, 0x08, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    # 3) igual pero en la dirección que usa el fabricante (0x0076)
    print("\n-- SET 18 05 00 76 00 00 00  +  GET --")
    print("  set:", set_feature(fd, [0x07, 0x18, 0x05, 0x00, 0x76, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    # 4) ráfaga de 8 (índice 0..7) y GETs
    print("\n-- SET ráfaga 0x08 idx 0..7 --")
    for i in range(8):
        set_feature(fd, [0x07, 0x18, 0x05, i, 0x08, 0x00, 0x00, 0x07])
    for _ in range(4):
        print("  get:", get_feature(fd)[:120])

    # 5) ¿y con el id en el búfer de 8 bytes de datos (sin id)?
    print("\n-- SET 18 18 05 00 08 00 00 00 (por si el id va dentro) --")
    print("  set:", set_feature(fd, [0x18, 0x05, 0x00, 0x08, 0x00, 0x00, 0x00]))
    print("  get:", get_feature(fd)[:120])

    os.close(fd)


if __name__ == "__main__":
    main()
