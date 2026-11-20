//! How this copy of ezTerm was installed.
//!
//! The same `ezterm.exe` ships in the GitHub release (MSI / NSIS / portable
//! tar.xz) and inside the Microsoft Store MSIX. The two channels differ in who
//! owns updates: GitHub builds self-update through `tauri-plugin-updater`,
//! while the Store delivers updates itself and its policy forbids an MSIX app
//! from replacing its own binaries. Detecting the channel at runtime keeps a
//! single build artifact for both.

use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallChannel {
    /// Installed from the Microsoft Store (running with MSIX package identity).
    Store,
    /// GitHub release installer, portable archive, or a dev build.
    Direct,
}

impl InstallChannel {
    /// True when updates are delivered by the platform store rather than by
    /// ezTerm's own updater.
    pub fn store_managed(self) -> bool {
        self == Self::Store
    }
}

/// The channel this process runs under. Package identity can't change during a
/// process's lifetime, so the OS is queried once and cached.
pub fn install_channel() -> InstallChannel {
    static CHANNEL: OnceLock<InstallChannel> = OnceLock::new();
    *CHANNEL.get_or_init(detect)
}

#[cfg(target_os = "windows")]
fn detect() -> InstallChannel {
    // kernel32 has exported this since Windows 8; called through a direct
    // declaration rather than pulling in the `windows` crate for one symbol.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentPackageFullName(
            package_full_name_length: *mut u32,
            package_full_name: *mut u16,
        ) -> i32;
    }
    const ERROR_INSUFFICIENT_BUFFER: i32 = 122;

    let mut len: u32 = 0;
    // SAFETY: a zero length with a null buffer is the documented way to probe
    // for identity: the call writes only `len` and returns
    // ERROR_INSUFFICIENT_BUFFER when the process has package identity, or
    // APPMODEL_ERROR_NO_PACKAGE (15700) when it doesn't.
    let rc = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
    if rc == ERROR_INSUFFICIENT_BUFFER {
        InstallChannel::Store
    } else {
        InstallChannel::Direct
    }
}

#[cfg(not(target_os = "windows"))]
fn detect() -> InstallChannel {
    InstallChannel::Direct
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpackaged_process_is_direct() {
        // `cargo test` runs without MSIX package identity.
        assert_eq!(install_channel(), InstallChannel::Direct);
        assert!(!install_channel().store_managed());
    }

    #[test]
    fn channel_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&InstallChannel::Store).unwrap(),
            "\"store\""
        );
        assert_eq!(
            serde_json::to_string(&InstallChannel::Direct).unwrap(),
            "\"direct\""
        );
    }
}
