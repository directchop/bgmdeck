mod audio;
mod menu;
mod midi;
mod osc;

use audio::{lock_or_recover, AudioDeviceInfo, Engine, FadeCurve, FileInfo};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct AppState {
    engine: Mutex<Engine>,
}

// ---- audio device ----

#[tauri::command]
async fn audio_list_devices() -> Vec<AudioDeviceInfo> {
    tauri::async_runtime::spawn_blocking(audio::list_devices)
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedAudio {
    device_id: String,
    sample_rate: u32,
    channels: u16,
}

/// (Re)open the output stream. Playback stops; every pad is re-primed.
#[tauri::command]
fn audio_restart(
    state: State<'_, AppState>,
    device_id: Option<String>,
    sample_rate: Option<u32>,
    buffer_size: Option<u32>,
) -> Result<AppliedAudio, String> {
    let mut engine = lock_or_recover(&state.engine);
    engine.start_with(device_id.as_deref(), sample_rate, buffer_size)?;
    Ok(AppliedAudio {
        device_id: engine.device_id().unwrap_or_default().to_string(),
        sample_rate: engine.sample_rate(),
        channels: engine.output_channels(),
    })
}

#[tauri::command]
fn audio_get_channels(state: State<'_, AppState>) -> u16 {
    lock_or_recover(&state.engine).output_channels()
}

// ---- pads ----

/// Attach a file to a pad. Returns once the file has been measured (length,
/// waveform); the pad is playable as soon as the command starts.
#[tauri::command]
async fn slot_load(
    state: State<'_, AppState>,
    slot_id: String,
    path: String,
    looping: bool,
) -> Result<FileInfo, String> {
    lock_or_recover(&state.engine).load_slot(&slot_id, &path, looping)?;
    let scan_path = path.clone();
    let info = tauri::async_runtime::spawn_blocking(move || audio::scan_file(&scan_path))
        .await
        .map_err(|e| e.to_string())??;
    lock_or_recover(&state.engine).set_slot_info(&slot_id, &path, info.clone());
    Ok(info)
}

#[tauri::command]
fn slot_unload(state: State<'_, AppState>, slot_id: String) {
    lock_or_recover(&state.engine).unload_slot(&slot_id);
}

#[tauri::command]
fn slot_set_looping(state: State<'_, AppState>, slot_id: String, looping: bool) {
    lock_or_recover(&state.engine).set_slot_looping(&slot_id, looping);
}

#[tauri::command]
fn slot_set_volume(state: State<'_, AppState>, slot_id: String, volume: f32) {
    lock_or_recover(&state.engine).set_slot_volume(&slot_id, volume);
}

// ---- deck transport ----

#[tauri::command]
fn deck_play(
    state: State<'_, AppState>,
    slot_id: String,
    volume: f32,
    fade_in: f32,
    fade_out: f32,
) -> Result<u64, String> {
    lock_or_recover(&state.engine).play(&slot_id, volume, fade_in, fade_out)
}

#[tauri::command]
fn deck_stop(state: State<'_, AppState>, fade: f32) {
    lock_or_recover(&state.engine).stop_all(fade);
}

#[tauri::command]
fn deck_stop_slot(state: State<'_, AppState>, slot_id: String, fade: f32) {
    lock_or_recover(&state.engine).stop_slot(&slot_id, fade);
}

#[tauri::command]
fn deck_set_master(state: State<'_, AppState>, volume: f32) {
    lock_or_recover(&state.engine).set_master(volume);
}

#[tauri::command]
fn deck_set_duck(state: State<'_, AppState>, on: bool, level: f32, fade: f32) {
    lock_or_recover(&state.engine).set_duck(on, level, fade);
}

#[tauri::command]
fn deck_set_routing(state: State<'_, AppState>, left: usize, right: usize) {
    lock_or_recover(&state.engine).set_routing(left, right);
}

#[tauri::command]
fn deck_set_curve(state: State<'_, AppState>, curve: String) {
    lock_or_recover(&state.engine).set_curve(FadeCurve::parse(&curve));
}

// ---- OSC / MIDI ----

#[tauri::command]
fn osc_configure(
    receiver: State<'_, Arc<osc::OscReceiver>>,
    port: Option<u16>,
    interface: String,
) -> Result<(), String> {
    receiver.configure(port, &interface).map_err(|e| {
        log::warn!("{e}");
        e
    })
}

#[tauri::command]
fn osc_list_interfaces() -> Vec<osc::NetInterface> {
    osc::list_interfaces()
}

#[tauri::command]
fn osc_send(
    sender: State<'_, osc::OscSender>,
    target: String,
    address: String,
    args: Vec<osc::OscArg>,
) -> Result<(), String> {
    sender.send(&target, &address, &args)
}

#[tauri::command]
fn midi_list_inputs() -> Vec<String> {
    midi::MidiState::list_inputs()
}

#[tauri::command]
fn midi_connect(state: State<'_, Arc<midi::MidiState>>, name: Option<String>) -> Result<(), String> {
    state.connect(name.as_deref()).map_err(|e| {
        log::warn!("{e}");
        e
    })
}

// ---- files / dialogs ----

const DECK_EXT: &str = "bgmdeck";

fn with_deck_extension(path: PathBuf) -> PathBuf {
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(DECK_EXT))
    {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(".");
    s.push(DECK_EXT);
    PathBuf::from(s)
}

#[tauri::command]
async fn deck_pick_save_path(app: AppHandle, default_name: String) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("BGM Deck", &[DECK_EXT])
        .set_file_name(format!("{default_name}.{DECK_EXT}"))
        .blocking_save_file()?;
    let path = with_deck_extension(picked.into_path().ok()?);
    Some(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn deck_pick_open_path(app: AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("BGM Deck", &[DECK_EXT])
        .blocking_pick_file()?;
    Some(picked.into_path().ok()?.to_string_lossy().into_owned())
}

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "aif", "aiff", "mp3", "flac", "m4a", "aac", "mp4", "ogg", "oga",
];

#[tauri::command]
async fn file_pick_audio(app: AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio", AUDIO_EXTENSIONS)
        .blocking_pick_file()?;
    Some(picked.into_path().ok()?.to_string_lossy().into_owned())
}

/// Write via a temp file + rename so a crash mid-save never truncates the
/// existing deck.
#[tauri::command]
async fn deck_write(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

#[tauri::command]
async fn deck_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

#[tauri::command]
async fn dialog_confirm(app: AppHandle, title: String, message: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

#[tauri::command]
async fn dialog_message(app: AppHandle, title: String, message: String, error: bool) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(if error {
            MessageDialogKind::Error
        } else {
            MessageDialogKind::Warning
        })
        .blocking_show();
}

// ---- window / menu / logging ----

/// Mirrors the frontend's unsaved-changes flag so the close prompt runs in
/// Rust even if the webview has stopped responding.
#[derive(Default)]
struct UnsavedChanges {
    dirty: AtomicBool,
    prompting: AtomicBool,
}

#[tauri::command]
fn deck_set_dirty(flag: State<'_, UnsavedChanges>, dirty: bool) {
    flag.dirty.store(dirty, Ordering::Relaxed);
}

fn confirm_close(window: &tauri::Window) {
    let guard = window.state::<UnsavedChanges>();
    if guard.prompting.swap(true, Ordering::AcqRel) {
        return;
    }
    let window = window.clone();
    window
        .dialog()
        .message("This deck has unsaved changes. Close without saving?")
        .title("Unsaved changes")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |close| {
            let guard = window.state::<UnsavedChanges>();
            guard.prompting.store(false, Ordering::Release);
            if close {
                guard.dirty.store(false, Ordering::Relaxed);
                let _ = window.destroy();
            }
        });
}

#[tauri::command]
fn menu_sync(handles: State<'_, menu::MenuHandles>, state: menu::MenuState) -> Result<(), String> {
    menu::sync(&handles, &state).map_err(|e| {
        log::warn!("menu_sync failed: {e}");
        e.to_string()
    })
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) {
    menu::open_path(&app, path);
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) {
    menu::open_url(&app, &url);
}

#[tauri::command]
fn window_set_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

#[tauri::command]
fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!(target: "webview", "{message}"),
        "warn" => log::warn!(target: "webview", "{message}"),
        _ => log::info!(target: "webview", "{message}"),
    }
}

#[tauri::command]
fn app_log_dir(app: AppHandle) -> Option<String> {
    app.path().app_log_dir().ok().map(|p| p.display().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && window
                        .state::<UnsavedChanges>()
                        .dirty
                        .load(Ordering::Relaxed)
                {
                    api.prevent_close();
                    confirm_close(window);
                }
            }
        })
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .level_for("webview", log::LevelFilter::Info)
                    .level_for("symphonia_bundle_mp3", log::LevelFilter::Warn)
                    .level_for("symphonia_core", log::LevelFilter::Warn)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("bgmdeck".into()),
                        }),
                    ])
                    .max_file_size(5_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                    .build(),
            )?;
            log::info!(
                "BGM Deck v{} starting ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            if let Ok(dir) = app.path().app_log_dir() {
                log::info!("Log directory: {}", dir.display());
            }
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                log::error!("PANIC: {info}");
                default_hook(info);
            }));

            menu::install(app.handle())?;

            // Stream errors (device unplugged) reach the UI, which reopens
            // the device and shows an engine warning.
            let handle_for_audio = app.handle().clone();
            lock_or_recover(&app.state::<AppState>().engine).set_error_handler(Arc::new(
                move |message: String| {
                    let _ = handle_for_audio.emit(
                        "audio-stream-error",
                        serde_json::json!({ "message": message }),
                    );
                },
            ));

            // Deck status broadcast (positions, stages, meters) at 20 fps.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("deck-status".into())
                .spawn(move || {
                    let mut last: Option<audio::DeckStatus> = None;
                    let mut idle_ticks = 0u32;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        let status = lock_or_recover(&handle.state::<AppState>().engine).status();
                        let quiet = status.voices.is_empty()
                            && status.peak.iter().all(|p| *p < 1e-4)
                            && last.as_ref().is_some_and(|l| l.voices.is_empty());
                        // Keep emitting a few idle frames so meters fall to zero,
                        // then back off to 2 fps while nothing plays.
                        if quiet {
                            idle_ticks += 1;
                            if idle_ticks % 10 != 0 && idle_ticks > 10 {
                                continue;
                            }
                        } else {
                            idle_ticks = 0;
                        }
                        let _ = handle.emit("deck-status", &status);
                        last = Some(status);
                    }
                })?;

            let handle_for_osc = app.handle().clone();
            app.manage(Arc::new(osc::OscReceiver::new(Arc::new(
                move |message: osc::ReceivedMessage| {
                    let _ = handle_for_osc.emit("osc-received", &message);
                },
            ))));
            app.manage(osc::OscSender::new()?);

            let handle_for_midi = app.handle().clone();
            app.manage(Arc::new(midi::MidiState::new(Arc::new(move |bytes: Vec<u8>| {
                let _ = handle_for_midi.emit("midi-message", serde_json::json!({ "data": bytes }));
            }))));

            Ok(())
        })
        .manage(UnsavedChanges::default())
        .manage(AppState {
            engine: Mutex::new(Engine::new()),
        })
        .invoke_handler(tauri::generate_handler![
            audio_list_devices,
            audio_restart,
            audio_get_channels,
            slot_load,
            slot_unload,
            slot_set_looping,
            slot_set_volume,
            deck_play,
            deck_stop,
            deck_stop_slot,
            deck_set_master,
            deck_set_duck,
            deck_set_routing,
            deck_set_curve,
            osc_configure,
            osc_list_interfaces,
            osc_send,
            midi_list_inputs,
            midi_connect,
            deck_pick_save_path,
            deck_pick_open_path,
            file_pick_audio,
            deck_write,
            deck_read,
            file_exists,
            dialog_confirm,
            dialog_message,
            deck_set_dirty,
            menu_sync,
            open_path,
            open_url,
            window_set_title,
            log_frontend,
            app_log_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_extension_is_appended_once() {
        assert_eq!(
            with_deck_extension(PathBuf::from("/tmp/show")),
            PathBuf::from("/tmp/show.bgmdeck")
        );
        assert_eq!(
            with_deck_extension(PathBuf::from("/tmp/show.BGMDECK")),
            PathBuf::from("/tmp/show.BGMDECK")
        );
        assert_eq!(
            with_deck_extension(PathBuf::from("/tmp/my.show")),
            PathBuf::from("/tmp/my.show.bgmdeck")
        );
    }
}
