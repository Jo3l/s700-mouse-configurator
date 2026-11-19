//! Windows: hid.dll for the feature report and cfgmgr32 to list the HID
//! interfaces. No permission dialog: there is nothing to grant here, the
//! process opens the device like any other file.
//!
//! WRITTEN BUT **NOT COMPILED OR TESTED** on this machine (Linux). Cross
//! compilation needs the Windows target; see docs/NATIVE.md.

use std::ffi::c_void;
use std::io;
use std::mem::zeroed;
use std::ptr;

type HANDLE = *mut c_void;
type BOOL = i32;

const GENERIC_READ_WRITE: u32 = 0xC000_0000;
const FILE_SHARE_READ_WRITE: u32 = 0x0000_0003;
const OPEN_EXISTING: u32 = 3;
const CR_SUCCESS: u32 = 0;
const CM_GET_DEVICE_INTERFACE_LIST_PRESENT: u32 = 0;

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

const GUID_DEVINTERFACE_HID: Guid = Guid {
    data1: 0x4D1E_55B2,
    data2: 0xF16F,
    data3: 0x11CF,
    data4: [0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30],
};

#[repr(C)]
#[derive(Default)]
struct HidAttributes {
    size: u32,
    vendor_id: u16,
    product_id: u16,
    version: u16,
}

#[link(name = "hid")]
extern "system" {
    fn HidD_GetAttributes(h: HANDLE, a: *mut HidAttributes) -> BOOL;
    fn HidD_GetProductString(h: HANDLE, buf: *mut u16, len: u32) -> BOOL;
    fn HidD_SetFeature(h: HANDLE, buf: *const u8, len: u32) -> BOOL;
    fn HidD_GetPreparsedData(h: HANDLE, pp: *mut *mut c_void) -> BOOL;
    fn HidD_FreePreparsedData(pp: *mut c_void) -> BOOL;
    fn HidP_GetCaps(pp: *mut c_void, out: *mut u8) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        sa: *mut c_void,
        disposition: u32,
        flags: u32,
        template: HANDLE,
    ) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
}

#[link(name = "cfgmgr32")]
extern "system" {
    fn CM_Get_Device_Interface_List_SizeW(len: *mut u32, guid: *const Guid, devinst: u32, flags: u32) -> u32;
    fn CM_Get_Device_Interface_ListW(
        guid: *const Guid,
        devinst: u32,
        buf: *mut u16,
        len: u32,
        flags: u32,
    ) -> u32;
}

pub struct Info {
    pub path: String,
    pub name: String,
    pub vid: u16,
    pub pid: u16,
}

#[allow(dead_code)] // vid/pid/name are used in --list and in the /api/open JSON
pub struct Device {
    handle: HANDLE,
    pub path: String,
    pub name: String,
    pub vid: u16,
    pub pid: u16,
}

// The Windows HANDLE has no thread affinity and here the host Mutex is what
// serializes access, so it can move between threads. Without this the crate
// does not compile for Windows (Arc<Host> stops being Send).
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn interface_paths() -> Vec<String> {
    let mut len: u32 = 0;
    let rc = unsafe {
        CM_Get_Device_Interface_List_SizeW(&mut len, &GUID_DEVINTERFACE_HID, 0, CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
    };
    if rc != CR_SUCCESS || len == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u16; len as usize];
    let rc = unsafe {
        CM_Get_Device_Interface_ListW(
            &GUID_DEVINTERFACE_HID,
            0,
            buf.as_mut_ptr(),
            len,
            CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
        )
    };
    if rc != CR_SUCCESS {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    for i in 0..buf.len() {
        if buf[i] == 0 {
            if i == start {
                break; // double null: end of the list
            }
            out.push(String::from_utf16_lossy(&buf[start..i]));
            start = i + 1;
        }
    }
    out
}

fn open_handle(path: &str) -> Option<HANDLE> {
    let w = wide(path);
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            GENERIC_READ_WRITE,
            FILE_SHARE_READ_WRITE,
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if h.is_null() || h as isize == -1 {
        None
    } else {
        Some(h)
    }
}

/// HIDP_CAPS is larger than 64 bytes on x64; plenty is reserved and
/// UsagePage is read, which is the second u16 (offset 2).
fn usage_page(h: HANDLE) -> Option<u16> {
    let mut preparsed: *mut c_void = ptr::null_mut();
    if unsafe { HidD_GetPreparsedData(h, &mut preparsed) } == 0 || preparsed.is_null() {
        return None;
    }
    let mut caps = [0u8; 128];
    let status = unsafe { HidP_GetCaps(preparsed, caps.as_mut_ptr()) };
    unsafe { HidD_FreePreparsedData(preparsed) };
    if status < 0 {
        return None;
    }
    Some(u16::from_le_bytes([caps[2], caps[3]]))
}

fn describe(h: HANDLE, path: &str) -> Option<Info> {
    let page = usage_page(h)?;
    if page != 0xff00 {
        return None;
    }
    let mut attrs: HidAttributes = unsafe { zeroed() };
    attrs.size = std::mem::size_of::<HidAttributes>() as u32;
    let (vid, pid) = if unsafe { HidD_GetAttributes(h, &mut attrs) } != 0 {
        (attrs.vendor_id, attrs.product_id)
    } else {
        (0, 0)
    };
    let mut name = [0u16; 128];
    let name = if unsafe { HidD_GetProductString(h, name.as_mut_ptr(), 128) } != 0 {
        let end = name.iter().position(|c| *c == 0).unwrap_or(0);
        String::from_utf16_lossy(&name[..end])
    } else {
        String::from("HID device")
    };
    Some(Info { path: path.to_string(), name, vid, pid })
}

pub fn enumerate() -> Vec<Info> {
    let mut out = Vec::new();
    for path in interface_paths() {
        if let Some(h) = open_handle(&path) {
            if let Some(info) = describe(h, &path) {
                out.push(info);
            }
            unsafe { CloseHandle(h) };
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

pub fn open(path: &str) -> io::Result<Device> {
    let handle = open_handle(path).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{path}: could not open. Close the vendor tool and its tray icon: they hold the device open exclusively."),
        )
    })?;
    let info = describe(handle, path);
    let (name, vid, pid) = match info {
        Some(i) => (i.name, i.vid, i.pid),
        None => (String::from("HID device"), 0, 0),
    };
    Ok(Device { handle, path: path.to_string(), name, vid, pid })
}

impl Device {
    pub fn send_feature(&self, id: u8, data: &[u8]) -> io::Result<usize> {
        let mut buf = Vec::with_capacity(data.len() + 1);
        buf.push(id);
        buf.extend_from_slice(data);
        let ok = unsafe { HidD_SetFeature(self.handle, buf.as_ptr(), buf.len() as u32) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(buf.len())
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}
