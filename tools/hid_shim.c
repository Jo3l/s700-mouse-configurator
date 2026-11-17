
/* Shim DLL for the S700 vendor tool: emulates a vendor HID device on Wine.
 * Replaces the app's HID/SETUPAPI imports and logs every feature report.
 * Build: i686-w64-mingw32-gcc -shared -o hid.dll hid_shim.c -lgdi32
 */
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

#define LOGFILE "Z:\\tmp\\hid.log"

typedef struct { DWORD Size; WORD VendorID; WORD ProductID; WORD VersionNumber; } HIDD_ATTRIBUTES_S;
typedef struct {
    USHORT Usage; USHORT UsagePage;
    USHORT InputReportByteLength; USHORT OutputReportByteLength; USHORT FeatureReportByteLength;
    USHORT Reserved[17]; USHORT NumberLinkCollectionNodes;
    USHORT NumberInputButtonCaps; USHORT NumberInputValueCaps;
    USHORT NumberInputDataIndices; USHORT NumberOutputButtonCaps;
    USHORT NumberOutputValueCaps; USHORT NumberOutputDataIndices;
    USHORT NumberFeatureButtonCaps; USHORT NumberFeatureValueCaps;
    USHORT NumberFeatureDataIndices;
} HIDP_CAPS_S;

static unsigned char g_mem[256];        /* fake device memory */
static unsigned char g_stage[256];
static unsigned char g_reply[64];

static void logline(const char *fmt, ...);

static void loghex(const char *tag, const unsigned char *b, int n)
{
    char buf[512]; int i, o = 0;
    o += sprintf(buf, "%s ", tag);
    for (i = 0; i < n && o < 480; i++) o += sprintf(buf + o, "%02x", b[i]);
    buf[o] = 0;
    logline("%s", buf);
}

static void logline(const char *fmt, ...)
{
    FILE *f = fopen(LOGFILE, "a");
    va_list ap;
    if (!f) return;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

/* ---------------- HID stubs ---------------- */
static BOOL WINAPI my_HidD_GetHidGuid(LPGUID g)
{
    static const GUID hid = {0x4d1e55b2,0xf16f,0x11cf,{0x88,0xcb,0x00,0x11,0x11,0x00,0x00,0x30}};
    *g = hid;
    logline("CALL GetHidGuid");
    return TRUE;
}
static BOOL WINAPI my_HidD_GetPreparsedData(HANDLE h, void **pp)
{
    static int dummy;
    *pp = &dummy;
    logline("CALL GetPreparsedData h=%p", h);
    return TRUE;
}
static BOOL WINAPI my_HidD_FreePreparsedData(void *p) { logline("CALL FreePreparsedData"); return TRUE; }
static BOOL WINAPI my_HidP_GetCaps(void *prep, HIDP_CAPS_S *caps)
{
    memset(caps, 0, sizeof(*caps));
    caps->Usage = 0x01;
    caps->UsagePage = 0xFF00;
    caps->InputReportByteLength = 65;
    caps->OutputReportByteLength = 65;
    caps->FeatureReportByteLength = 65;
    logline("CALL GetCaps");
    return TRUE;
}
static BOOL WINAPI my_HidD_GetAttributes(HANDLE h, HIDD_ATTRIBUTES_S *a)
{
    a->Size = sizeof(*a);
    a->VendorID = 0x30FA;
    a->ProductID = 0x1540;
    a->VersionNumber = 0x0100;
    logline("CALL GetAttributes h=%p -> vid=%04x pid=%04x", h, a->VendorID, a->ProductID);
    return TRUE;
}
static BOOL WINAPI my_HidD_GetProductString(HANDLE h, void *buf, ULONG len)
{
    static const WCHAR name[] = L"S700 Gaming Mouse";
    ULONG n = (ULONG)sizeof(name);
    if (len < n) n = len;
    memcpy(buf, name, n);
    logline("CALL GetProductString");
    return TRUE;
}
static BOOL WINAPI my_HidD_SetFeature(HANDLE h, void *buf, ULONG len)
{
    unsigned char *f = (unsigned char *)buf;
    int cmd, idx, addr, val, ln, eff = len ? (int)len : 65;
    loghex("SET", f, eff);
    if (len < 8) return TRUE;
    cmd = f[2]; idx = f[3]; addr = f[4] | (f[5] << 8); val = f[6]; ln = f[7] + 1;
    if (cmd == 5) {                    /* read byte */
        memset(g_reply, 0, sizeof(g_reply));
        g_reply[0] = 7; g_reply[1] = 0x18; g_reply[2] = 5; g_reply[3] = (unsigned char)idx;
        g_reply[4] = (unsigned char)(addr & 0xFF); g_reply[5] = (unsigned char)(addr >> 8);
        g_reply[6] = g_mem[(addr + idx) & 0xFF]; g_reply[7] = f[7];
    } else if (cmd == 3) {
        g_stage[idx & 0xFF] = (unsigned char)val;
    } else if (cmd == 9) {             /* commit */
        int i;
        for (i = 0; i < ln && i < 256; i++) g_mem[(addr + i) & 0xFF] = g_stage[i];
        { FILE *m = fopen("Z:\\tmp\\mem.bin", "wb"); if (m) { fwrite(g_mem, 1, 256, m); fclose(m); } }
    }
    return TRUE;
}
static BOOL WINAPI my_HidD_GetFeature(HANDLE h, void *buf, ULONG len)
{
    ULONG n = len ? (len < sizeof(g_reply) ? len : sizeof(g_reply)) : sizeof(g_reply);
    memcpy(buf, g_reply, n);
    loghex("GET", g_reply, (int)n);
    return TRUE;
}

/* ---------------- setupapi stubs ---------------- */
typedef struct { DWORD cbSize; GUID InterfaceClassGuid; DWORD Flags; ULONG_PTR Reserved; } IFACE_DATA_S;
typedef struct { DWORD cbSize; WCHAR DevicePath[ANYSIZE_ARRAY]; } IFACE_DETAIL_S;
typedef void *HDEVINFO;

static HDEVINFO WINAPI my_SetupDiGetClassDevsW(const GUID *g, LPCWSTR e, HWND h, DWORD f)
{
    logline("CALL GetClassDevs");
    return (HDEVINFO)(ULONG_PTR)1;
}
static BOOL WINAPI my_SetupDiEnumDeviceInterfaces(HDEVINFO d, void *di, const GUID *g, DWORD idx, IFACE_DATA_S *id)
{
    logline("CALL EnumDeviceInterfaces idx=%u", (unsigned)idx);
    if (idx != 0) return FALSE;
    memset(id, 0, sizeof(*id));
    id->cbSize = sizeof(IFACE_DATA_S);
    if (g) id->InterfaceClassGuid = *g;
    id->Flags = 1;
    return TRUE;
}
static BOOL WINAPI my_SetupDiGetDeviceInterfaceDetailW(HDEVINFO d, IFACE_DATA_S *id, IFACE_DETAIL_S *det,
        DWORD size, DWORD *req, void *info)
{
    static const WCHAR path[] = L"\\\\?\\fake";
    logline("CALL GetDeviceInterfaceDetail size=%u", (unsigned)size);
    if (req) *req = 6 + sizeof(path);
    if (!det) return FALSE;
    if (size < 6 + sizeof(path)) { SetLastError(122); return FALSE; }
    det->cbSize = 6;
    memcpy(det->DevicePath, path, sizeof(path));
    return TRUE;
}
static BOOL WINAPI my_SetupDiDestroyDeviceInfoList(HDEVINFO d)
{
    logline("CALL DestroyDeviceInfoList");
    return TRUE;
}

/* ---------------- misc stubs ---------------- */
static HWND WINAPI my_FindWindowW(LPCWSTR cls, LPCWSTR title)
{
    logline("CALL FindWindowW(%ls,%ls) -> NULL", cls ? cls : L"(null)", title ? title : L"(null)");
    return NULL;
}
static HWND WINAPI my_FindWindowA(LPCSTR cls, LPCSTR title)
{
    logline("CALL FindWindowA(%s,%s) -> NULL", cls ? cls : "(null)", title ? title : "(null)");
    return NULL;
}

/* ---------------- IAT patching ---------------- */
typedef struct { const char *dll; const char *fn; void *repl; } PATCH;

static void patch_iat(void)
{
    static PATCH patches[] = {
        {"HID.DLL",       "HidD_GetHidGuid",                (void*)my_HidD_GetHidGuid},
        {"HID.DLL",       "HidD_GetPreparsedData",          (void*)my_HidD_GetPreparsedData},
        {"HID.DLL",       "HidD_FreePreparsedData",         (void*)my_HidD_FreePreparsedData},
        {"HID.DLL",       "HidP_GetCaps",                   (void*)my_HidP_GetCaps},
        {"HID.DLL",       "HidD_GetAttributes",             (void*)my_HidD_GetAttributes},
        {"HID.DLL",       "HidD_GetProductString",          (void*)my_HidD_GetProductString},
        {"HID.DLL",       "HidD_SetFeature",                (void*)my_HidD_SetFeature},
        {"HID.DLL",       "HidD_GetFeature",                (void*)my_HidD_GetFeature},
        {"SETUPAPI.dll",  "SetupDiGetClassDevsW",           (void*)my_SetupDiGetClassDevsW},
        {"SETUPAPI.dll",  "SetupDiEnumDeviceInterfaces",    (void*)my_SetupDiEnumDeviceInterfaces},
        {"SETUPAPI.dll",  "SetupDiGetDeviceInterfaceDetailW",(void*)my_SetupDiGetDeviceInterfaceDetailW},
        {"SETUPAPI.dll",  "SetupDiDestroyDeviceInfoList",   (void*)my_SetupDiDestroyDeviceInfoList},
        {"USER32.dll",    "FindWindowW",                    (void*)my_FindWindowW},
        {"USER32.dll",    "FindWindowA",                    (void*)my_FindWindowA},
    };
    HMODULE base = GetModuleHandleA(NULL);
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((char *)base + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY *imp = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    IMAGE_IMPORT_DESCRIPTOR *d = (IMAGE_IMPORT_DESCRIPTOR *)((char *)base + imp->VirtualAddress);
    int i;
    for (; d->Name; d++) {
        const char *dname = (const char *)base + d->Name;
        IMAGE_THUNK_DATA *thunk = (IMAGE_THUNK_DATA *)((char *)base + d->FirstThunk);
        IMAGE_THUNK_DATA *orig = (IMAGE_THUNK_DATA *)((char *)base + d->OriginalFirstThunk);
        for (i = 0; thunk[i].u1.Function; i++) {
            IMAGE_IMPORT_BY_NAME *ibn;
            const char *fname;
            unsigned k;
            if (!orig[i].u1.AddressOfData) continue;
            ibn = (IMAGE_IMPORT_BY_NAME *)((char *)base + orig[i].u1.AddressOfData);
            fname = (const char *)ibn->Name;
            for (k = 0; k < sizeof(patches)/sizeof(patches[0]); k++) {
                if (lstrcmpiA(dname, patches[k].dll) == 0 && strcmp(fname, patches[k].fn) == 0) {
                    DWORD old;
                    VirtualProtect(&thunk[i].u1.Function, 4, PAGE_READWRITE, &old);
                    thunk[i].u1.Function = (ULONG_PTR)patches[k].repl;
                    VirtualProtect(&thunk[i].u1.Function, 4, old, &old);
                }
            }
        }
    }
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r)
{
    if (reason == DLL_PROCESS_ATTACH) {
        logline("=== shim attached ===");
        patch_iat();
        logline("=== iat patched ===");
    }
    return TRUE;
}
