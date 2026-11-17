//! Capa HID del host: enumerar y escribir el feature report.
//!
//! No hay lectura a propósito: el firmware del S700 contesta a los informes de
//! salida pero no a GetFeature (docs/PROTOCOL.md §4), así que el host sólo
//! escribe.

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{enumerate, open, Device};
#[cfg(windows)]
#[path = "windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::{enumerate, open, Device};

/// Tamaño del feature report del S700 (report id 7, 64 bytes de datos).
pub const REPORT_BYTES: usize = 64;
