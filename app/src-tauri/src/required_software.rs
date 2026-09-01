//! Detection status for external programs Waystation orchestrates or
//! connects to. Detection-only, deliberately: checks the filesystem for
//! a matching binary, never executes one. Actually running an unknown
//! copy of JS8Call/meshtasticd/rigctld to "check" it risks launching a
//! GUI window, or a daemon that tries to bind a serial port or network
//! port a *real* running instance already holds -- a detection probe
//! should never have side effects like that. (Pat is the one exception
//! elsewhere in this codebase, in `pat::find_pat_binary` -- its `version`
//! subcommand was verified live to be a fast, side-effect-free status
//! print, not a GUI/daemon launch, which none of the others here have
//! been verified to be.)
//!
//! Also deliberately does not download or run an installer -- see
//! ROADMAP.md's "Required-software panel" entry for why that's separate,
//! harder, real work (checksum/signature verification before executing
//! anything third-party, so a GPLv3 emergency-comms tool never silently
//! pulls unverified binaries). "Install" here just points at the
//! official download page for the operator to handle themselves.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct SoftwareEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub detected: bool,
    pub install_url: &'static str,
    pub note: &'static str,
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn detect(names: &[&str]) -> bool {
    let dirs = candidate_dirs();
    dirs.iter().any(|dir| names.iter().any(|name| is_executable(&dir.join(name))))
}

#[tauri::command]
pub fn get_required_software() -> Vec<SoftwareEntry> {
    vec![
        SoftwareEntry {
            id: "pat",
            name: "Pat (Winlink)",
            detected: detect(&["pat", "pat.exe"]),
            install_url: "https://github.com/la5nta/pat/releases",
            note: "Waystation launches and manages this one for you once it's installed.",
        },
        SoftwareEntry {
            id: "js8call",
            name: "JS8Call",
            detected: detect(&["js8call", "JS8Call", "js8call.exe"]),
            install_url: "https://js8call.com/downloads.html",
            note: "Runs on its own -- Waystation only connects to its TCP API, and never launches it.",
        },
        SoftwareEntry {
            id: "meshtasticd",
            name: "meshtasticd (Meshtastic)",
            detected: detect(&["meshtasticd", "meshtasticd.exe"]),
            install_url: "https://meshtastic.org/docs/meshtasticd/",
            note: "Only needed for a radio wired directly into this computer -- a Meshtastic node reachable over TCP/WiFi needs nothing installed here at all.",
        },
        SoftwareEntry {
            id: "hamlib",
            name: "Hamlib (rigctld / rotctld)",
            detected: detect(&["rigctld", "rigctld.exe"]) || detect(&["rotctld", "rotctld.exe"]),
            install_url: "https://github.com/Hamlib/Hamlib/releases",
            note: "Powers both Rig Control and Rotator Control -- Waystation connects to one already running, never starts it.",
        },
    ]
}
