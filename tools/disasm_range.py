#!/usr/bin/env python3
"""Disassemble a VA range of the PE (32-bit). Usage: dis.py <exe> <start_va> <end_va> [--data ptr]"""
import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

EXE = sys.argv[1]
start = int(sys.argv[2], 0)
end = int(sys.argv[3], 0)
pe = pefile.PE(EXE)
base = pe.OPTIONAL_HEADER.ImageBase
data = open(EXE, "rb").read()
secs = [(s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData) for s in pe.sections]

def va2off(va):
    rva = va - base
    for sva, vs, ptr, sz in secs:
        if sva <= rva < sva + max(vs, sz):
            return rva - sva + ptr
    return None

off = va2off(start)
n = end - start
code = data[off:off + n]
md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = False
for ins in md.disasm(code, start):
    print(f"{ins.address:#010x}  {ins.bytes.hex():<24} {ins.mnemonic:8s} {ins.op_str}")
