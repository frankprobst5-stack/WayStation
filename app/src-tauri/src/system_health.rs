//! Real host system health for the Dashboard's System Health card.
//!
//! Deliberately not routed through `connectivity::report_source_health` --
//! that machinery exists to answer "can I reach this external thing," and
//! the host machine WayStation itself is running on isn't a source that
//! goes up or down the same way. This is always-available, zero-dependency
//! telemetry (no network, no external process), so it just gets its own
//! small always-fresh snapshot instead.
//!
//! CPU usage needs two samples with time between them to mean anything --
//! a `System` built fresh on every call would report 0% or a stale
//! since-boot average depending on platform. `SystemHealthState` keeps one
//! persistent `sysinfo::System` alive for the app's whole lifetime instead,
//! refreshed on a short interval by `spawn_poller`, matching every other
//! polled subsystem in this codebase (see weather_station.rs).

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Components, Disks, System};
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Real bug found 2026-09-20 from a live Windows tester report (WayStation
/// typing lag: every keystroke taking 30-60 seconds, escalating to a full
/// "Not Responding" freeze): `Disks` and `Components` were being
/// reconstructed from scratch -- a full disk/volume and hardware-sensor
/// re-enumeration -- on every 3-second poll, forever, for the app's whole
/// lifetime. `Components::new_with_refreshed_list()` on Windows goes
/// through WMI, which is well-known for being slow and occasionally
/// stalling for multiple seconds under real-world conditions (especially
/// with third-party antivirus also hooking WMI); `Disks::
/// new_with_refreshed_list()` re-enumerates every mounted volume, worse
/// on a machine also running Docker Desktop's WSL2 virtual disks. Real
/// fix: keep one persistent instance of each (same pattern this file
/// already used correctly for `System` below) and call the real
/// incremental `.refresh()` method sysinfo provides instead of
/// reconstructing from scratch every cycle.
pub struct SystemHealthState {
    system: Mutex<System>,
    disks: Mutex<Disks>,
    components: Mutex<Components>,
    latest: Mutex<Option<SystemHealthSnapshot>>,
}

impl SystemHealthState {
    pub fn new() -> Self {
        SystemHealthState {
            system: Mutex::new(System::new_all()),
            disks: Mutex::new(Disks::new_with_refreshed_list()),
            components: Mutex::new(Components::new_with_refreshed_list()),
            latest: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemHealthSnapshot {
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    /// The disk actually backing WayStation's own data directory -- not an
    /// arbitrary "first disk" or a sum across every mounted volume, which
    /// would be a real but meaningless number on a machine with several.
    pub disk_percent: Option<f32>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    /// Only ever `Some` when a real sensor reported a real value. Omitted,
    /// never guessed, on hardware/OS combinations sysinfo can't read a
    /// temperature from at all -- the same "not on map" honesty already
    /// used for an unparsable grid square elsewhere in this app.
    pub temperature_c: Option<f32>,
}

/// Picks the disk whose mount point is the longest real prefix of `path` --
/// the standard "which filesystem actually holds this path" rule. A pure
/// function over plain data so it's testable without real disk hardware.
fn disk_containing_path<'a>(
    disks: &'a [(std::path::PathBuf, u64, u64)],
    path: &Path,
) -> Option<&'a (std::path::PathBuf, u64, u64)> {
    disks
        .iter()
        .filter(|(mount, _, _)| path.starts_with(mount))
        .max_by_key(|(mount, _, _)| mount.as_os_str().len())
}

/// Picks a CPU-ish temperature sensor by label out of whatever sysinfo's
/// `Components` enumerates -- labels are wildly inconsistent across
/// platforms/hardware ("CPU Package", "Tctl", "Core 0", "acpitz"), so this
/// matches loosely rather than pretending there's one canonical name.
fn find_cpu_temperature(components: &[(String, f32)]) -> Option<f32> {
    components
        .iter()
        .find(|(label, _)| {
            let l = label.to_lowercase();
            l.contains("cpu") || l.contains("package") || l.contains("tctl") || l.contains("core 0")
        })
        .map(|(_, temp)| *temp)
}

fn snapshot(system: &mut System, disks: &mut Disks, components: &mut Components) -> SystemHealthSnapshot {
    system.refresh_cpu_usage();
    system.refresh_memory();

    let cpu_percent = system.global_cpu_usage();
    let memory_used_mb = system.used_memory() / 1024 / 1024;
    let memory_total_mb = system.total_memory() / 1024 / 1024;
    let memory_percent = if memory_total_mb > 0 {
        (memory_used_mb as f32 / memory_total_mb as f32) * 100.0
    } else {
        0.0
    };

    // Incremental refresh of the persistent instance -- NOT
    // Disks::new_with_refreshed_list(), which reconstructs from scratch
    // (a full volume re-enumeration) every single call. See this state's
    // own doc comment above for the real bug this replaced.
    disks.refresh();
    let disk_rows: Vec<(std::path::PathBuf, u64, u64)> = disks
        .list()
        .iter()
        .map(|d| (d.mount_point().to_path_buf(), d.total_space(), d.available_space()))
        .collect();
    let data_dir = crate::db::data_dir();
    let matched = disk_containing_path(&disk_rows, &data_dir);
    let (disk_percent, disk_used_gb, disk_total_gb) = match matched {
        Some((_, total, available)) if *total > 0 => {
            let used = total.saturating_sub(*available);
            let pct = (used as f32 / *total as f32) * 100.0;
            let gb = |b: u64| b as f64 / 1024.0 / 1024.0 / 1024.0;
            (Some(pct), Some(gb(used)), Some(gb(*total)))
        }
        _ => (None, None, None),
    };

    // Same fix as disks above -- incremental refresh, not a fresh
    // Components::new_with_refreshed_list() every cycle. This one matters
    // even more on Windows, where component enumeration goes through WMI,
    // a real, well-known source of multi-second stalls when re-queried
    // from scratch repeatedly.
    components.refresh();
    let component_rows: Vec<(String, f32)> = components
        .list()
        .iter()
        .map(|c| (c.label().to_string(), c.temperature()))
        .collect();
    let temperature_c = find_cpu_temperature(&component_rows);

    SystemHealthSnapshot {
        cpu_percent,
        memory_percent,
        memory_used_mb,
        memory_total_mb,
        disk_percent,
        disk_used_gb,
        disk_total_gb,
        temperature_c,
    }
}

pub fn poll_once(app: &AppHandle) {
    let state = app.state::<SystemHealthState>();
    let snap = {
        let mut system = state.system.lock().expect("system_health mutex poisoned");
        let mut disks = state.disks.lock().expect("system_health mutex poisoned");
        let mut components = state.components.lock().expect("system_health mutex poisoned");
        snapshot(&mut system, &mut disks, &mut components)
    };
    *state.latest.lock().expect("system_health mutex poisoned") = Some(snap);
    let _ = app.emit("system-health-changed", ());
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        poll_once(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[tauri::command]
pub fn get_system_health(state: tauri::State<SystemHealthState>) -> Option<SystemHealthSnapshot> {
    state.latest.lock().expect("system_health mutex poisoned").clone()
}

#[cfg(test)]
mod tests {
    //! Pure logic only -- real CPU/memory/disk numbers vary by machine and
    //! aren't meaningfully assertable in CI, so these test the two
    //! decision functions (which disk, which sensor) against synthetic
    //! data instead of real hardware.
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn disk_containing_path_picks_the_longest_matching_mount() {
        let disks = vec![
            (PathBuf::from("/"), 500_000_000_000u64, 200_000_000_000u64),
            (PathBuf::from("/home"), 1_000_000_000_000u64, 900_000_000_000u64),
        ];
        let found = disk_containing_path(&disks, Path::new("/home/frank/.local/share/waystation"));
        assert_eq!(found.unwrap().0, PathBuf::from("/home"));
    }

    #[test]
    fn disk_containing_path_falls_back_to_root_when_no_deeper_mount_matches() {
        let disks = vec![
            (PathBuf::from("/"), 500_000_000_000u64, 200_000_000_000u64),
            (PathBuf::from("/mnt/external"), 2_000_000_000_000u64, 1_000_000_000_000u64),
        ];
        let found = disk_containing_path(&disks, Path::new("/home/frank/.local/share/waystation"));
        assert_eq!(found.unwrap().0, PathBuf::from("/"));
    }

    #[test]
    fn disk_containing_path_returns_none_when_nothing_matches() {
        let disks = vec![(PathBuf::from("/mnt/other"), 500_000_000_000u64, 200_000_000_000u64)];
        let found = disk_containing_path(&disks, Path::new("/home/frank/data"));
        assert!(found.is_none());
    }

    #[test]
    fn find_cpu_temperature_matches_common_real_world_labels() {
        assert_eq!(find_cpu_temperature(&[("Tctl".into(), 55.0)]), Some(55.0));
        assert_eq!(find_cpu_temperature(&[("CPU Package".into(), 42.5)]), Some(42.5));
        assert_eq!(find_cpu_temperature(&[("Core 0".into(), 48.0)]), Some(48.0));
    }

    #[test]
    fn find_cpu_temperature_is_honestly_none_when_nothing_matches() {
        assert_eq!(find_cpu_temperature(&[("acpitz".into(), 30.0), ("nvme".into(), 40.0)]), None);
        assert_eq!(find_cpu_temperature(&[]), None);
    }
}
