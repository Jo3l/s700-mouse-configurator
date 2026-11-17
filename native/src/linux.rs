//! hidraw: el nodo /dev/hidrawN, que es lo que el kernel expone para cada
//! interfaz HID. Se escribe el feature report con ioctl(HIDIOCSFEATURE) y el
//! primer byte del buffer es el report id, igual que en el navegador.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;

pub struct Info {
    pub path: String,
    pub name: String,
    pub vid: u16,
    pub pid: u16,
}

#[allow(dead_code)] // vid/pid/name se usan en --list y en el JSON de /api/open
pub struct Device {
    file: File,
    pub path: String,
    pub name: String,
    pub vid: u16,
    pub pid: u16,
}

/// _IOWR('H', 0x06, len): HIDIOCSFEATURE. El tamaño viaja en los bits 16-29.
fn hid_iocsfeature(len: usize) -> u64 {
    0xC000_0000u64 | ((len as u64) << 16) | 0x0648
}

extern "C" {
    fn ioctl(fd: i32, request: u64, ...) -> i32;
}

/// Interfaces HID cuyo descriptor declara el vendor page 0xFF00: son las del
/// ratón (la de configuración; la de ratón normal no lo declara).
pub fn enumerate() -> Vec<Info> {
    let mut out = Vec::new();
    let entries = match fs::read_dir("/sys/class/hidraw") {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let node = entry.path();
        let dev = node.join("device");
        let desc = fs::read(dev.join("report_descriptor")).unwrap_or_default();
        if !desc.windows(3).any(|w| w == [0x06, 0x00, 0xff]) {
            continue;
        }
        let uevent = fs::read_to_string(dev.join("uevent")).unwrap_or_default();
        let mut vid = 0u16;
        let mut pid = 0u16;
        let mut name = String::new();
        for line in uevent.lines() {
            if let Some(v) = line.strip_prefix("HID_ID=") {
                let parts: Vec<&str> = v.split(':').collect();
                if parts.len() == 3 {
                    vid = u32::from_str_radix(parts[1], 16).unwrap_or(0) as u16;
                    pid = u32::from_str_radix(parts[2], 16).unwrap_or(0) as u16;
                }
            } else if let Some(v) = line.strip_prefix("HID_NAME=") {
                name = v.to_string();
            }
        }
        let node_name = entry.file_name().to_string_lossy().to_string();
        out.push(Info { path: format!("/dev/{node_name}"), name, vid, pid });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

pub fn open(path: &str) -> io::Result<Device> {
    let file = OpenOptions::new().read(true).write(true).open(path).map_err(|e| {
        if e.kind() == io::ErrorKind::PermissionDenied {
            io::Error::new(
                e.kind(),
                format!(
                    "{path}: permission denied. El nodo es de root y este usuario no lo puede abrir; \
                     instala la regla udev de docs/NATIVE.md (§ Permisos) y reconecta el ratón."
                ),
            )
        } else {
            e
        }
    })?;
    let info = enumerate().into_iter().find(|d| d.path == path);
    let (name, vid, pid) = match info {
        Some(i) => (i.name, i.vid, i.pid),
        None => (String::from("HID device"), 0, 0),
    };
    Ok(Device { file, path: path.to_string(), name, vid, pid })
}

impl Device {
    /// Escribe un feature report. `data` va sin el report id: se antepone aquí.
    pub fn send_feature(&self, id: u8, data: &[u8]) -> io::Result<usize> {
        let mut buf = Vec::with_capacity(data.len() + 1);
        buf.push(id);
        buf.extend_from_slice(data);
        let rc = unsafe { ioctl(self.file.as_raw_fd(), hid_iocsfeature(buf.len()), buf.as_ptr()) };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(buf.len())
    }
}
