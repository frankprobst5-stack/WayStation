//! Critical Resource Status chips (Power/Water/Food), a real v2 backlog
//! item. Simple Good/Low/Critical indicators, not a telemetry dashboard --
//! WayStation only displays a summary, Citadel owns the actual
//! hardware/inventory polling, same "Citadel captures/configures, WayStation
//! is the operator-facing UI" pattern `citadel_scanner.rs` already
//! established for the scanner. Reuses `station_profile.citadel_map_host`/
//! `citadel_vault_token`, same as every other Citadel client here.
//!
//! Power comes from Project VIGIL's real `/api/vigil/state`
//! (`solar_battery_soc`) -- already live and already consumed by Citadel's
//! own Master Situation Board, confirmed by reading that real endpoint
//! directly before building this, not assumed to exist. Water/Food come
//! from Citadel's Homestead Logistics `/api/inventory/<category>` --
//! checked live too: real items carry a `qty` and an optional `min_qty`,
//! with `min_qty == 0` meaning "not tracked" (the same convention
//! `logistics.html`'s own `statusBadges()` already uses), not "always out."
//! An empty category (confirmed live: Water and Freezer are currently
//! empty on this real household's own inventory) reports `NoData`, never a
//! fabricated status -- the same "don't invent a reading you don't have"
//! rule every other source in this app already follows.

use crate::db::{self, Db};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

fn citadel_base(host: &Option<String>) -> String {
    let h = host.as_deref().unwrap_or("127.0.0.1:8085").trim().to_string();
    format!("http://{h}")
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
}

fn station_citadel_host(db: &State<Db>) -> Option<String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).citadel_map_host
}

fn station_citadel_vault_token(db: &State<Db>) -> Option<String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).citadel_vault_token
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceLevel {
    Good,
    Low,
    Critical,
    /// Genuinely no data to judge from -- a category with nothing logged,
    /// or Citadel itself unreachable. Never silently shown as Good.
    NoData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceChip {
    pub level: ResourceLevel,
    /// A short, real reason a human can sanity-check -- e.g. "38% battery"
    /// or "3 items below their own low-stock line", never just a bare color.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceStatus {
    pub power: ResourceChip,
    pub water: ResourceChip,
    pub food: ResourceChip,
}

#[derive(Deserialize)]
struct VigilState {
    #[serde(default)]
    solar_battery_soc: Option<f64>,
}

#[derive(Deserialize)]
struct InventoryItem {
    qty: f64,
    #[serde(default)]
    min_qty: Option<f64>,
}

fn power_chip(db: &State<Db>) -> ResourceChip {
    let host = station_citadel_host(db);
    let token = station_citadel_vault_token(db);
    let url = format!("{}/api/vigil/state", citadel_base(&host));
    let state: Result<VigilState, String> = client()
        .get(&url)
        .header("X-Vault-Token", token.unwrap_or_default())
        .send()
        .map_err(|e| e.to_string())
        .and_then(|r| r.error_for_status().map_err(|e| e.to_string()))
        .and_then(|r| r.json::<VigilState>().map_err(|e| e.to_string()));

    match state {
        Ok(VigilState {
            solar_battery_soc: Some(soc),
        }) => {
            let level = if soc >= 50.0 {
                ResourceLevel::Good
            } else if soc >= 20.0 {
                ResourceLevel::Low
            } else {
                ResourceLevel::Critical
            };
            ResourceChip {
                level,
                detail: format!("{soc:.0}% battery (Project VIGIL)"),
            }
        }
        Ok(VigilState {
            solar_battery_soc: None,
        }) => ResourceChip {
            level: ResourceLevel::NoData,
            detail: "Project VIGIL reachable but reports no battery reading".into(),
        },
        Err(_) => ResourceChip {
            level: ResourceLevel::NoData,
            detail: "Project VIGIL unreachable -- is the vigil module running on Citadel?".into(),
        },
    }
}

/// Shared by water and food -- both are plain Homestead Logistics
/// inventory categories, judged the same honest way: Critical if anything
/// real is tracked (a real `min_qty` > 0) and sitting at zero, Low if
/// anything tracked is at or under its own line, Good if everything
/// tracked clears its line, NoData if the category is empty or
/// unreachable. Mirrors `logistics.html`'s own `statusBadges()` low-stock
/// convention exactly, not a new threshold invented here.
fn inventory_chip(db: &State<Db>, category: &str, label: &str) -> ResourceChip {
    let host = station_citadel_host(db);
    let token = station_citadel_vault_token(db);
    let url = format!("{}/api/inventory/{category}", citadel_base(&host));
    let items: Result<Vec<InventoryItem>, String> = client()
        .get(&url)
        .header("X-Vault-Token", token.unwrap_or_default())
        .send()
        .map_err(|e| e.to_string())
        .and_then(|r| r.error_for_status().map_err(|e| e.to_string()))
        .and_then(|r| r.json::<Vec<InventoryItem>>().map_err(|e| e.to_string()));

    let items = match items {
        Ok(items) => items,
        Err(_) => {
            return ResourceChip {
                level: ResourceLevel::NoData,
                detail: format!("Citadel unreachable -- can't check {label}"),
            }
        }
    };

    if items.is_empty() {
        return ResourceChip {
            level: ResourceLevel::NoData,
            detail: format!("Nothing logged in Citadel's {label} ledger yet"),
        };
    }

    let tracked: Vec<&InventoryItem> = items
        .iter()
        .filter(|i| i.min_qty.unwrap_or(0.0) > 0.0)
        .collect();
    if tracked.is_empty() {
        return ResourceChip {
            level: ResourceLevel::NoData,
            detail: format!("{} items in {label}, none have a low-stock line set", items.len()),
        };
    }

    let zero_and_tracked = tracked.iter().filter(|i| i.qty <= 0.0).count();
    let at_or_under = tracked
        .iter()
        .filter(|i| i.qty <= i.min_qty.unwrap_or(0.0))
        .count();

    let (level, detail) = if zero_and_tracked > 0 {
        (
            ResourceLevel::Critical,
            format!("{zero_and_tracked} tracked {label} item(s) at zero"),
        )
    } else if at_or_under > 0 {
        (
            ResourceLevel::Low,
            format!("{at_or_under} of {} tracked {label} item(s) at or below their low-stock line", tracked.len()),
        )
    } else {
        (
            ResourceLevel::Good,
            format!("All {} tracked {label} item(s) above their low-stock line", tracked.len()),
        )
    };
    ResourceChip { level, detail }
}

#[tauri::command]
pub fn get_resource_status(db: State<Db>) -> Result<ResourceStatus, String> {
    Ok(ResourceStatus {
        power: power_chip(&db),
        water: inventory_chip(&db, "water", "Water"),
        food: inventory_chip(&db, "food", "Food"),
    })
}
