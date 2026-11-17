#!/usr/bin/env python3
"""Locate calls to HID import thunks and disassemble context around them."""
import sys, struct
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

EXE = sys.argv[1]
pe = pefile.PE(EXE)
base = pe.OPTIONAL_HEADER.ImageBase
data = open(EXE, "rb").read()

# rva->file offset helper
secs = [(s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData) for s in pe.sections]
def rva2off(rva):
    for va, vs, pr, sr in secs:
        if va <= rva < va + max(vs, sr):
            return rva - va + pr
    return None

THUNKS = {
    0x17b3aa: "HidP_GetCaps",
    0x17b3b0: "HidD_GetAttributes",
    0x17b3b6: "HidD_GetHidGuid",
    0x17b3bc: "HidD_GetPreparsedData",
    0x17b3c2: "HidD_FreePreparsedData",
    0x17b3c8: "HidD_GetFeature",
    0x17b3ce: "HidD_SetFeature",
    0x17b3d4: "HidD_GetProductString",
}

md = Cs(CS_ARCH_X86, CS_MODE_32)

text = next(s for s in pe.sections if s.Name.startswith(b".text"))
tdata = text.get_data()
tva = base + text.VirtualAddress

for trva, name in THUNKS.items():
    tva_target = base + trva
    print(f"\n########## {name}  (thunk {tva_target:#x}) ##########")
    hits = []
    for m in md.disasm(tdata, tva):
        if m.mnemonic == "call" and m.op_str.startswith("0x"):
            try:
                if int(m.op_str, 16) == tva_target:
                    hits.append(m.address)
            except ValueError:
                pass
    print(f"call sites: {[hex(h) for h in hits]}")
    for h in hits:
        off = h - tva - 0x60
        code = tdata[off:off + 0x100]
        print(f"--- context @ {h:#x} ---")
        for ins in md.disasm(code, h - 0x60):
            mark = ">>" if ins.address == h else "  "
            if ins.address > h + 0x50:
                break
            print(f"{mark} {ins.address:#010x} {ins.bytes.hex():<16} {ins.mnemonic:8s} {ins.op_str}")
