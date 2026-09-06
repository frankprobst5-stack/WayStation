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
use sysinfo::{Disks, System};
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_secs(3);

pub struct SystemHealthState {
    system: Mutex<System>,
    latest: Mutex<Option<SystemHealthSnapshot>>,
}

impl SystemHealthState {
    pub fn new() -> Self {
        SystemHealthState {
            system: Mutex::new(System::new_all()),
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

fn snapshot(system: &mut System) -> SystemHealthSnapshot {
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

    let disks = Disks::new_with_refreshed_list();
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

    let components = sysinfo::Components::new_with_refreshed_list();
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
        snapshot(&mut system)
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
