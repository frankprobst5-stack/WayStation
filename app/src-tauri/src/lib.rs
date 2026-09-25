mod ai_sitrep;
mod aprs;
mod auto_sync;
mod backup;
mod citadel_scanner;
mod connectivity;
mod contest_calendar;
mod db;
mod discovery;
mod direwolf;
mod dispatch;
mod dxcluster;
mod flight_tracking;
mod js8call;
mod kiwix_search;
mod maidenhead;
mod mesh;
mod net_sync;
mod nws;
mod pat;
mod pota;
mod pskreporter;
mod readiness;
mod repeaterbook;
mod required_software;
mod rig;
mod rotator;
mod satellite;
mod space_weather;
mod spc_outlook;
mod sync;
mod system_health;
mod transcription;
mod transport;
mod weather_station;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

/// WebKitGTK's hardware-accelerated DMA-BUF rendering path is broken on
/// many Wayland sessions -- verified live 2026-08-31: the Tactical Map's
/// MapLibre canvas rendered nothing (plain white, no error), while every
/// other DOM element on the exact same page, including MapLibre's own
/// attribution control, rendered correctly. That split is the documented
/// fingerprint of this bug (Tauri's own Linux graphics troubleshooting
/// guide): WebGL context creation succeeds from the JS side even when the
/// GPU compositing path underneath is broken, so nothing ever throws an
/// error to catch. Scoped to Wayland specifically, not applied
/// unconditionally to every Linux user, per Tauri's own guidance --
/// X11 sessions aren't affected by this bug and disabling DMA-BUF costs a
/// real rendering-performance path that shouldn't be paid for nothing.
/// Must run before the webview is created, hence first thing in `run()`.
#[cfg(target_os = "linux")]
fn apply_wayland_webkit_workaround() {
    if std::env::var("WAYLAND_DISPLAY").is_ok() || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    apply_wayland_webkit_workaround();

    tauri::Builder::default()
        // Must be the first plugin registered -- its whole job is deciding,
        // before anything else runs, whether this process should hand off
        // to an already-running instance and exit instead of starting a
        // second one. That matters here specifically: a second WayStation
        // process would open the same SQLite file and try to rebind the
        // same mesh/rig/rotator TCP ports as the first, which is a real
        // resource-contention bug, not a cosmetic one -- so a second
        // launch (e.g. clicking Citadel's Communications Hub tile while
        // WayStation is already open) must focus the existing window
        // rather than spawn a competing process.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Dynamic runtime registration of the waystation:// scheme.
            // Only needed on Linux dev/unbundled builds -- a real .deb/AppImage
            // build gets its MimeType=x-scheme-handler/waystation; association
            // baked into the .desktop file by Tauri's bundler at package time
            // (driven by the `plugins.deep-link` config in tauri.conf.json),
            // and macOS/Windows installers register the scheme at install
            // time too. This call is what makes `xdg-open waystation://...`
            // work against a `cargo tauri dev` binary before it's ever been
            // packaged.
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("waystation")?;
            }

            let conn = db::open();
            app.manage(Db(Mutex::new(conn)));
            app.manage(pat::PatProcess(Mutex::new(None)));
            app.manage(direwolf::DirewolfProcess(Mutex::new(None)));
            app.manage(mesh::MeshState::new());
            app.manage(discovery::DiscoveryState::new());
            app.manage(auto_sync::AutoSyncState::new());
            app.manage(system_health::SystemHealthState::new());
            system_health::spawn_poller(app.handle().clone());
            discovery::spawn_advertiser(app.handle().clone());
            discovery::spawn_browser(app.handle().clone());
            net_sync::spawn_listener(app.handle().clone());
            auto_sync::spawn_poller(app.handle().clone());
            connectivity::spawn_poller(app.handle().clone());
            nws::spawn_poller(app.handle().clone());
            weather_station::spawn_poller(app.handle().clone());
            space_weather::spawn_poller(app.handle().clone());
            spc_outlook::spawn_poller(app.handle().clone());
            contest_calendar::spawn_poller(app.handle().clone());
            pskreporter::spawn_poller(app.handle().clone());
            pota::spawn_poller(app.handle().clone());
            dxcluster::spawn_poller(app.handle().clone());
            flight_tracking::spawn_poller(app.handle().clone());
            satellite::spawn_poller(app.handle().clone());
            mesh::spawn_poller(app.handle().clone());
            pat::spawn_or_restart(app.handle());
            pat::spawn_health_poller(app.handle().clone());
            // Deliberately no direwolf::start_direwolf(...) call here --
            // unlike Pat, this never auto-starts (see direwolf.rs's own
            // doc comment: a real live microphone opening on every app
            // launch, before an operator has confirmed audio routing, is
            // a real surprise). The health poller just reports whatever
            // state already exists.
            direwolf::spawn_health_poller(app.handle().clone());
            // Safe to always run, unlike direwolf::start_direwolf itself:
            // this is just a TCP client retry loop against Direwolf's
            // KISS port, no audio device involved. It reports honestly
            // as unreachable until Direwolf's actually started.
            aprs::spawn_listener(app.handle().clone());
            js8call::spawn_poller(app.handle().clone());
            rig::spawn_poller(app.handle().clone());
            rotator::spawn_poller(app.handle().clone());
            // Belt-and-suspenders with tauri.conf.json's own "maximized"
            // hint: some Linux window managers apply an initial-maximize
            // request inconsistently (timing-dependent on when the WM
            // actually sees the window), so this asks again explicitly
            // once the window definitely exists, rather than trusting the
            // config hint alone to have taken effect by launch time.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.maximize();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::get_station_profile,
            db::save_station_profile,
            db::set_tactical_mode,
            db::set_mesh_enabled,
            db::set_rig_enabled,
            db::set_rotator_enabled,
            db::set_theme,
            db::get_traffic_counts,
            db::get_recent_activity,
            ai_sitrep::generate_sitrep_narrative,
            kiwix_search::list_kiwix_books,
            kiwix_search::search_kiwix_library,
            system_health::get_system_health,
            db::get_or_create_signing_secret,
            db::add_trusted_peer,
            db::get_trusted_peers,
            db::delete_trusted_peer,
            db::set_trusted_peer_auto_sync,
            db::get_incident_info,
            db::save_incident_info,
            db::create_incident,
            db::get_incidents,
            db::close_incident,
            db::set_message_incident,
            db::set_marker_incident,
            db::create_person,
            db::get_personnel,
            db::set_person_status,
            db::assign_person_to_incident,
            db::set_person_location,
            db::create_resource_request,
            db::get_resource_requests,
            db::set_resource_request_status,
            db::set_resource_request_incident,
            db::set_resource_request_location,
            db::get_incident_events,
            db::log_transcript_to_incident,
            db::create_sitrep,
            db::get_sitreps,
            db::get_alerts,
            db::get_net_roster,
            db::check_in_station,
            db::check_out_station,
            db::mark_heard,
            db::clear_net_roster,
            db::get_messages,
            db::create_message,
            dispatch::dispatch_message,
            db::get_markers,
            db::create_marker,
            db::delete_marker,
            dispatch::dispatch_marker,
            db::get_delivery_attempts,
            sync::export_manifest_to_file,
            sync::manifest_diff_from_file,
            sync::export_objects_to_file,
            sync::import_objects_from_file,
            sync::export_full_bundle_to_file,
            discovery::get_discovered_peers,
            net_sync::sync_with_peer,
            auto_sync::get_auto_sync_history,
            citadel_scanner::get_citadel_scanner_status,
            citadel_scanner::get_citadel_scanner_config,
            citadel_scanner::save_citadel_scanner_config,
            citadel_scanner::list_citadel_scanner_profiles,
            citadel_scanner::save_citadel_scanner_profile,
            citadel_scanner::activate_citadel_scanner_profile,
            citadel_scanner::delete_citadel_scanner_profile,
            db::get_resources,
            db::upsert_resource,
            db::delete_resource,
            db::get_space_weather,
            db::get_channels,
            db::upsert_channel,
            db::delete_channel,
            db::get_websdr_stations,
            db::upsert_websdr_station,
            db::delete_websdr_station,
            db::get_contests,
            db::get_psk_spots,
            db::get_pota_spots,
            db::get_dx_spots,
            db::get_aircraft_tracks,
            db::get_forecast_periods,
            db::get_spc_outlook,
            db::get_nws_current_observation,
            db::get_local_weather_observation,
            db::get_satellite_tles,
            db::get_qso_log,
            db::upsert_qso_log_entry,
            db::delete_qso_log_entry,
            db::export_qso_log_adif,
            db::get_mesh_nodes,
            db::get_mesh_messages,
            db::clear_mesh_messages,
            db::delete_mesh_message,
            mesh::get_mesh_status,
            mesh::send_mesh_text,
            mesh::send_mesh_position,
            mesh::request_mesh_position,
            mesh::reconnect_mesh,
            rig::get_rig_status,
            rig::set_rig_frequency,
            rig::set_rig_mode,
            rotator::get_rotator_status,
            rotator::set_rotator_position,
            satellite::get_satellite_status,
            satellite::get_satellite_ground_track,
            connectivity::get_connectivity_state,
            connectivity::get_manual_offline,
            connectivity::set_manual_offline,
            readiness::prepare_for_offline,
            pat::get_winlink_status,
            pat::get_winlink_inbox,
            pat::restart_winlink_service,
            direwolf::get_direwolf_status,
            direwolf::start_direwolf,
            direwolf::stop_direwolf,
            aprs::get_aprs_stations,
            transcription::get_scanner_recordings,
            transcription::transcribe_recording,
            js8call::get_js8call_status,
            js8call::get_js8call_inbox,
            repeaterbook::search_repeaters,
            required_software::get_required_software,
            backup::backup_database,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<pat::PatProcess>();
                let mut guard = state.0.lock().expect("pat process mutex poisoned");
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let direwolf_state = app_handle.state::<direwolf::DirewolfProcess>();
                let mut direwolf_guard = direwolf_state.0.lock().expect("direwolf process mutex poisoned");
                if let Some(mut child) = direwolf_guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
