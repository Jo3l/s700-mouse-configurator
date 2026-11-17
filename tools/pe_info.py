#!/usr/bin/env python3
"""Basic PE recon: sections+entropy, imports, resources, IAT xrefs for chosen APIs."""
import sys, math, struct
import pefile

pe = pefile.PE(sys.argv[1], fast_load=False)

print("== sections ==")
for s in pe.sections:
    data = s.get_data()
    ent = 0.0
    if data:
        c = [0]*256
        for b in data:
            c[b] += 1
        for n in c:
            if n:
                p = n/len(data)
                ent -= p*math.log2(p)
    print(f"{s.Name.decode(errors='replace').strip(chr(0)):10s} vma={s.VirtualAddress:#08x} vs={s.Misc_VirtualSize:#08x} "
          f"raw={s.SizeOfRawData:#08x} ent={ent:.2f} flags={s.Characteristics:#08x}")

print("\n== imports ==")
IAT = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    dll = entry.dll.decode()
    print(f"[{dll}]")
    for imp in entry.imports:
        name = imp.name.decode() if imp.name else f"ord{imp.ordinal}"
        if dll.lower() in ("hid.dll", "setupapi.dll") or "hid" in name.lower() or "setupdi" in name.lower():
            print(f"   {name:40s} IAT={imp.address:#010x} rva={imp.address-pe.OPTIONAL_HEADER.ImageBase:#08x}")
        IAT[name] = imp.address

print("\n== resources ==")
if hasattr(pe, "DIRECTORY_ENTRY_RESOURCE"):
    def walk(d, depth=0):
        for e in d.entries:
            n = e.name if e.name is not None else e.id
            if hasattr(e, "directory"):
                print("  "*depth + f"dir {n}")
                walk(e.directory, depth+1)
            else:
                print("  "*depth + f"{n}: size={e.data.struct.Size} rva={e.data.struct.OffsetToData:#x}")
    walk(pe.DIRECTORY_ENTRY_RESOURCE)
else:
    print("no resources")
