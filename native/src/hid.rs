//! HID layer of the host: enumerate and write the feature report.
//!
//! There is no read on purpose: the S700 firmware answers output reports but
//! not GetFeature (docs/PROTOCOL.md §4), so the host only writes.

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

/// Size of the S700 feature report (report id 7, 64 data bytes).
pub const REPORT_BYTES: usize = 64;
