#!/usr/bin/env python3
"""Find code references to HID IAT slots and disassemble around them."""
import sys, struct, re
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

EXE = sys.argv[1]
pe = pefile.PE(EXE)
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if s.Name.startswith(b".text"))
text_data = text.get_data()
text_va = base + text.VirtualAddress

targets = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    if entry.dll.decode().lower() != "hid.dll":
        continue
    for imp in entry.imports:
        targets[imp.name.decode()] = imp.address

md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = True

def find_refs(addr):
    """find FF15 <addr> (call [addr]) and A1/8B refs"""
    pat_call = b"\xff\x15" + struct.pack("<I", addr)
    out = []
    start = 0
    while True:
        i = text_data.find(pat_call, start)
        if i < 0:
            break
        out.append(("call", text_va + i))
        start = i + 1
    for op in (b"\xa1", b"\x8b\x0d"):  # mov eax,[addr] / mov ecx,[addr]
        p = op + struct.pack("<I", addr)
        start = 0
        while True:
            i = text_data.find(p, start)
            if i < 0:
                break
            out.append(("mov", text_va + i))
            start = i + 1
    return out

def disasm(va, nbytes=160, back=0):
    off = va - text_va - back
    code = text_data[off:off+nbytes]
    lines = []
    for ins in md.disasm(code, va-back):
        lines.append(f"  {ins.address:#010x}  {ins.mnemonic:8s} {ins.op_str}")
    return lines

for name, addr in targets.items():
    refs = find_refs(addr)
    print(f"\n===== {name} @ {addr:#x} : {len(refs)} refs =====")
    for kind, va in refs:
        print(f" [{kind}] at {va:#x}")
