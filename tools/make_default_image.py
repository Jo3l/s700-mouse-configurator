#!/usr/bin/env python3
"""Genera web/default_image.js a partir de la captura del programa del fabricante.

El ratón no implementa la lectura (GetFeature devuelve basura o ceros), así que el
configurador trabaja sobre una imagen conocida: la que el propio fabricante escribe
para su configuración de fábrica. Se reconstruye de tools/probe/baseline.log
(commits del shim) y se guarda como una cadena hex en un módulo ES para que la web
la pueda importar sin red ni ficheros extra.

    python3 tools/make_default_image.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from probe.parse_log import parse, memory  # noqa: E402

SIZE = 0x500
SRC = os.path.join(HERE, "probe", "baseline.log")
OUT = os.path.join(ROOT, "web", "default_image.js")

HEADER = """// Imagen de memoria que escribe el programa del fabricante con su config.ini de
// fábrica, reconstruida de tools/probe/baseline.log (generado por
// tools/make_default_image.py; no editar a mano).
//
// Este ratón no contesta a las lecturas (GetFeature devuelve basura), así que la
// configuración se construye desde esta imagen y se escribe entera, igual que hace
// el fabricante. Los bytes no escritos por él (0x0080-0x009F) quedan a 0x00.
"""


def main():
    commits = parse(SRC)
    mem = memory(commits)
    img = bytearray(SIZE)
    for addr, value in mem.items():
        if 0 <= addr < SIZE:
            img[addr] = value
    hexs = img.hex()
    written = sorted(mem)
    print("bytes escritos por el fabricante: %d de %#x" % (len(written), SIZE))
    print("rango: %#06x..%#06x" % (written[0], written[-1]))
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(HEADER)
        fh.write('export const DEFAULT_MEM_HEX =\n  "%s";\n' % hexs)
    print("escrito", OUT, len(hexs), "chars de hex")


if __name__ == "__main__":
    main()
