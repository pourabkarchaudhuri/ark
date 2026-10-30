//! ark-native — small native helpers for Ark's Electron main process.
//!
//! `session_enumerate()` replaces the PowerShell/tasklist subprocess pair in
//! `electron/session-tracker.ts` with a single native syscall-based process
//! enumeration: a Toolhelp32 process snapshot (`CreateToolhelp32Snapshot`)
//! to list PIDs plus each image's basename (`szExeFile`), then
//! `QueryFullProcessImageNameW` per PID to resolve the full executable path.
//! The basename is available even for processes whose path cannot be read,
//! so the JS side no longer needs `tasklist` for basenames (1.0.97). When the
//! snapshot itself fails we fall back to `EnumProcesses` (psapi) with no
//! basenames.
//! No subprocess spawn, no shell, no PowerShell startup cost, and no
//! dependency on PowerShell's availability/reliability under load (the root
//! cause class of the v1.0.60 tracker-never-ends bug — see session-tracker.ts
//! for the JS-side safety net that remains as defense-in-depth).
//!
//! Every process is returned regardless of path-resolution success — when
//! `QueryFullProcessImageNameW` fails (elevated process while we're not
//! admin, protected system process, race where the process exited between
//! enumeration and the query), `path` is `None` and the caller falls back to
//! basename-only matching, mirroring the existing PowerShell-failure
//! fallback semantics on the JS side.

#![deny(clippy::all)]

use napi_derive::napi;

#[napi(object)]
pub struct NativeProcessInfo {
    pub pid: u32,
    /// Full executable path, lowercased. `None` when the path could not be
    /// resolved (elevated process, protected process, or the process exited
    /// mid-enumeration).
    pub path: Option<String>,
    /// Image basename (Toolhelp32 `szExeFile`), lowercased. Present even when
    /// `path` is `None`; `None` only on the `EnumProcesses` fallback.
    pub name: Option<String>,
}

#[cfg(windows)]
mod windows_impl {
    use super::NativeProcessInfo;
    use std::mem;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, MAX_PATH};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::EnumProcesses;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// Enumerate every running process's PID via `EnumProcesses`, growing the
    /// buffer until the returned count no longer fills it (matching the
    /// documented Win32 pattern for an unbounded-length result).
    fn enum_pids() -> Vec<u32> {
        let mut capacity: usize = 1024;
        loop {
            let mut pids: Vec<u32> = vec![0; capacity];
            let mut bytes_returned: u32 = 0;
            let ok = unsafe {
                EnumProcesses(
                    pids.as_mut_ptr(),
                    (pids.len() * mem::size_of::<u32>()) as u32,
                    &mut bytes_returned,
                )
            };
            if ok == 0 {
                return Vec::new();
            }
            let count = (bytes_returned as usize) / mem::size_of::<u32>();
            if count < capacity {
                pids.truncate(count);
                return pids;
            }
            // Buffer was completely filled — there may be more processes than
            // it could hold. Grow and retry rather than silently truncating.
            capacity *= 2;
            if capacity > 1_048_576 {
                // Sanity cap — no real system has >1M processes; avoid an
                // unbounded loop if EnumProcesses ever misbehaves.
                pids.truncate(count);
                return pids;
            }
        }
    }

    /// Resolve one PID's full image path. Returns `None` on any failure
    /// (access denied, process exited, protected process) rather than
    /// propagating an error — a single unresolvable process must not abort
    /// the whole enumeration.
    fn query_image_path(pid: u32) -> Option<String> {
        if pid == 0 {
            return None; // System Idle Process — never a game.
        }
        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return None;
            }
            let mut buf: [u16; MAX_PATH as usize] = [0; MAX_PATH as usize];
            let mut size: u32 = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 || size == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            Some(path.to_lowercase())
        }
    }

    /// Every process's PID and lowercased image basename from one Toolhelp32
    /// snapshot. `None` when the snapshot could not be taken.
    fn snapshot_pids_and_names() -> Option<Vec<(u32, String)>> {
        unsafe {
            let snap: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap == 0 {
                return None;
            }
            let mut out: Vec<(u32, String)> = Vec::new();
            let mut entry: PROCESSENTRY32W = mem::zeroed();
            entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                out.push((entry.th32ProcessID, name));
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
    }

    pub fn enumerate() -> Vec<NativeProcessInfo> {
        if let Some(entries) = snapshot_pids_and_names() {
            return entries
                .into_iter()
                .map(|(pid, name)| NativeProcessInfo {
                    pid,
                    path: query_image_path(pid),
                    name: if name.is_empty() { None } else { Some(name) },
                })
                .collect();
        }
        enum_pids()
            .into_iter()
            .map(|pid| NativeProcessInfo {
                pid,
                path: query_image_path(pid),
                name: None,
            })
            .collect()
    }
}

#[cfg(not(windows))]
mod windows_impl {
    use super::NativeProcessInfo;

    /// Non-Windows builds never actually ship this native module today (the
    /// session tracker's JS fallback covers macOS/Linux via `ps`), but the
    /// crate must still compile in case CI or local dev runs on a
    /// non-Windows host. Return an empty list rather than failing the build.
    pub fn enumerate() -> Vec<NativeProcessInfo> {
        Vec::new()
    }
}

/// Enumerate every running process's PID and (when resolvable) full
/// lowercased executable path, in a single native call. Returns an empty
/// array (never throws) on total enumeration failure — callers must treat
/// an empty result the same way the JS fallback treats a failed `tasklist`
/// call: mark the snapshot stale and fall back to the previous good data,
/// never silently trust "nothing is running".
#[napi]
pub fn session_enumerate() -> Vec<NativeProcessInfo> {
    windows_impl::enumerate()
}
