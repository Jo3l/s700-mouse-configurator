#!/usr/bin/env python3
"""Xref callers of a VA (32-bit PE) with context. Usage: xref.py <exe> <target_va> [ctx]"""
import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

EXE, tgt = sys.argv[1], int(sys.argv[2], 0)
ctx = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0x40
pe = pefile.PE(EXE)
base = pe.OPTIONAL_HEADER.ImageBase
data = open(EXE, "rb").read()
text = next(s for s in pe.sections if s.Name.startswith(b".text"))
tdata, tva = text.get_data(), base + text.VirtualAddress
md = Cs(CS_ARCH_X86, CS_MODE_32)

hits = []
for m in md.disasm(tdata, tva):
    if m.mnemonic == "call" and m.op_str.startswith("0x"):
        try:
            if int(m.op_str, 16) == tgt:
                hits.append(m.address)
        except ValueError:
            pass
print(f"callers of {tgt:#x}: {[hex(h) for h in hits]}")
for h in hits:
    off = h - tva - ctx
    print(f"--- {h:#x} ---")
    for ins in md.disasm(tdata[off:off + ctx + 72], h - ctx):
        if ins.address > h + 0x18:
            break
        mark = ">>" if ins.address == h else "  "
        print(f"{mark} {ins.address:#010x} {ins.bytes.hex():<22} {ins.mnemonic:8s} {ins.op_str}")
