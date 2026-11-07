//! Native application menu (macOS menu bar / Windows + Linux window menu).
//!
//! Every item has a stable id ("file.save", "deck.stop", ...). Items that
//! need the deck state are forwarded to the webview as a `menu-command`
//! event and handled by `src/commands.ts`, which is also what the keyboard
//! shortcuts call, so a menu click and its shortcut always do the same
//! thing. Items that must work even if the webview is wedged (quit, open the
//! log folder) are handled here.
//!
//! Only modifier shortcuts are declared as accelerators. Bare keys (Space,
//! digits, D, ...) stay in the webview's keydown handler: a native
//! accelerator would fire while typing in a text field.

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_opener::OpenerExt;

pub const RELEASES_URL: &str = "https://github.com/directchop/bgmdeck/releases";
pub const DOCS_URL: &str = "https://github.com/directchop/bgmdeck#readme";

pub struct MenuHandles {
    undo: MenuItem<Wry>,
    redo: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    stop_now: MenuItem<Wry>,
    reveal_deck: MenuItem<Wry>,
    pad_rename: MenuItem<Wry>,
    pad_choose: MenuItem<Wry>,
    pad_clear: MenuItem<Wry>,
    duck: CheckMenuItem<Wry>,
    waveforms: CheckMenuItem<Wry>,
    tab_pads: CheckMenuItem<Wry>,
    tab_settings: CheckMenuItem<Wry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    pub playing: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub has_deck_path: bool,
    pub pad_selected: bool,
    pub duck_on: bool,
    pub show_waveforms: bool,
    pub tab: String,
}

/// Label with a shortcut hint for keys that are deliberately not
/// accelerators. Win32 right-aligns text after a tab like a real
/// accelerator; macOS lists these in Help > Keyboard Shortcuts instead.
fn hint(label: &str, key: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{label}\t{key}")
    } else {
        label.to_string()
    }
}

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: impl AsRef<str>,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text.as_ref(), true, accel)
}

fn check<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: impl AsRef<str>,
    accel: Option<&str>,
) -> tauri::Result<CheckMenuItem<R>> {
    CheckMenuItem::with_id(app, id, text.as_ref(), true, false, accel)
}

pub fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
    let sep = || PredefinedMenuItem::separator(app);
    let about_meta = AboutMetadata {
        name: Some("BGM Deck".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("© 2026 Hajime Sugie".into()),
        comments: Some("Pad-style background music player for live events.".into()),
        website: Some(RELEASES_URL.into()),
        website_label: Some("Release notes".into()),
        ..Default::default()
    };

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "BGM Deck",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About BGM Deck"), Some(about_meta.clone()))?,
            &sep()?,
            &item(app, "app.settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &item(app, "app.quit", "Quit BGM Deck", Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    // ---- File ----
    let reveal_deck = item(
        app,
        "file.reveal",
        if cfg!(target_os = "macos") { "Show in Finder" } else { "Show in File Manager" },
        None,
    )?;
    reveal_deck.set_enabled(false)?;
    let mut file_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![
        Box::new(item(app, "file.new", "New Deck", Some("CmdOrCtrl+N"))?),
        Box::new(item(app, "file.open", "Open Deck…", Some("CmdOrCtrl+O"))?),
        Box::new(sep()?),
        Box::new(item(app, "file.save", "Save", Some("CmdOrCtrl+S"))?),
        Box::new(item(app, "file.saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?),
        Box::new(sep()?),
        Box::new(reveal_deck.clone()),
    ];
    if cfg!(target_os = "macos") {
        file_items.push(Box::new(sep()?));
        file_items.push(Box::new(PredefinedMenuItem::close_window(app, Some("Close Window"))?));
    } else {
        file_items.push(Box::new(sep()?));
        file_items.push(Box::new(item(app, "app.quit", "Exit", None)?));
    }
    let file_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        file_items.iter().map(|i| i.as_ref()).collect();
    let file_menu = Submenu::with_items(app, "File", true, &file_refs)?;

    // ---- Edit ----
    let undo = item(app, "edit.undo", "Undo", Some("CmdOrCtrl+Z"))?;
    let redo = item(app, "edit.redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?;
    let pad_rename = item(app, "pad.rename", hint("Rename Pad", "Enter"), None)?;
    let pad_choose = item(app, "pad.choose", "Choose Audio File for Pad…", None)?;
    let pad_clear = item(app, "pad.clear", hint("Clear Pad", "Del"), None)?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &item(app, "edit.selectAll", "Select All", Some("CmdOrCtrl+A"))?,
            &sep()?,
            &pad_rename,
            &pad_choose,
            &pad_clear,
            &sep()?,
            &item(app, "bank.add", "Add Bank", Some("CmdOrCtrl+Shift+N"))?,
            &item(app, "bank.rename", "Rename Bank…", None)?,
            &item(app, "bank.delete", "Delete Bank", None)?,
        ],
    )?;

    // ---- View ----
    let tab_pads = check(app, "view.pads", "Pads", Some("CmdOrCtrl+1"))?;
    let tab_settings = check(app, "view.settings", "Settings", Some("CmdOrCtrl+2"))?;
    let waveforms = check(app, "view.waveforms", "Show Waveforms", None)?;
    let mut view_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![
        Box::new(tab_pads.clone()),
        Box::new(tab_settings.clone()),
        Box::new(item(app, "view.toggleSettings", hint("Toggle Pads / Settings", "Tab"), None)?),
        Box::new(sep()?),
        Box::new(waveforms.clone()),
    ];
    if cfg!(target_os = "macos") {
        view_items.push(Box::new(sep()?));
        view_items.push(Box::new(PredefinedMenuItem::fullscreen(app, None)?));
    }
    let view_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        view_items.iter().map(|i| i.as_ref()).collect();
    let view_menu = Submenu::with_items(app, "View", true, &view_refs)?;

    // ---- Deck ----
    let stop = item(app, "deck.stop", hint("Stop (Fade)", "Space"), None)?;
    let stop_now = item(app, "deck.stopNow", hint("Stop Now", "Shift+Space"), None)?;
    let duck = check(app, "deck.duck", hint("Duck", "D"), None)?;
    let mut play_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    for n in 1..=10 {
        let key = if n == 10 { "0".to_string() } else { n.to_string() };
        play_items.push(Box::new(item(
            app,
            &format!("deck.play.{n}"),
            hint(&format!("Pad {n}"), &key),
            None,
        )?));
    }
    let play_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        play_items.iter().map(|i| i.as_ref()).collect();
    let play_menu = Submenu::with_items(app, "Play Pad", true, &play_refs)?;
    let deck_menu = Submenu::with_items(
        app,
        "Deck",
        true,
        &[
            &play_menu,
            &sep()?,
            &stop,
            &stop_now,
            &sep()?,
            &duck,
            &sep()?,
            &item(app, "bank.prev", hint("Previous Bank", "["), None)?,
            &item(app, "bank.next", hint("Next Bank", "]"), None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
        ],
    )?;

    // ---- Help ----
    let mut help_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![
        Box::new(item(app, "help.shortcuts", hint("Keyboard Shortcuts", "?"), None)?),
        Box::new(item(app, "help.remote", "OSC / MIDI Reference", None)?),
        Box::new(item(app, "help.docs", "Online Manual", None)?),
        Box::new(sep()?),
        Box::new(item(app, "help.logs", "Open Log Folder", None)?),
        Box::new(sep()?),
        Box::new(item(app, "help.checkUpdates", "Check for Updates…", None)?),
        Box::new(item(app, "help.releases", "Release Notes", None)?),
    ];
    if !cfg!(target_os = "macos") {
        help_items.push(Box::new(sep()?));
        help_items.push(Box::new(PredefinedMenuItem::about(
            app,
            Some("About BGM Deck"),
            Some(about_meta),
        )?));
    }
    let help_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        help_items.iter().map(|i| i.as_ref()).collect();
    let help_menu = Submenu::with_items(app, "Help", true, &help_refs)?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &deck_menu, &window_menu, &help_menu],
    )?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &deck_menu, &help_menu])?;

    Ok((
        menu,
        MenuHandles {
            undo,
            redo,
            stop,
            stop_now,
            reveal_deck,
            pad_rename,
            pad_choose,
            pad_clear,
            duck,
            waveforms,
            tab_pads,
            tab_settings,
        },
    ))
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let (menu, handles) = build(app)?;
    #[cfg(target_os = "macos")]
    app.set_menu(menu)?;
    #[cfg(not(target_os = "macos"))]
    if let Some(main) = app.get_webview_window("main") {
        main.set_menu(menu)?;
    }
    app.manage(handles);
    app.on_menu_event(on_event);
    log::info!("Native menu installed");
    Ok(())
}

fn on_event(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    match id {
        "app.quit" => match app.get_webview_window("main") {
            Some(w) => {
                let _ = w.close();
            }
            None => app.exit(0),
        },
        "help.logs" => {
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                open_path(app, dir.display().to_string());
            }
        }
        "help.releases" => open_url(app, RELEASES_URL),
        "help.docs" => open_url(app, DOCS_URL),
        _ => {
            let _ = app.emit_to("main", "menu-command", id);
        }
    }
}

pub fn open_path(app: &AppHandle, path: String) {
    if let Err(e) = app.opener().open_path(&path, None::<&str>) {
        log::warn!("Could not open {path}: {e}");
    }
}

pub fn open_url(app: &AppHandle, url: &str) {
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        log::warn!("Could not open {url}: {e}");
    }
}

pub fn sync(h: &MenuHandles, s: &MenuState) -> tauri::Result<()> {
    h.undo.set_enabled(s.can_undo)?;
    h.redo.set_enabled(s.can_redo)?;
    h.stop.set_enabled(s.playing)?;
    h.stop_now.set_enabled(s.playing)?;
    h.reveal_deck.set_enabled(s.has_deck_path)?;
    h.pad_rename.set_enabled(s.pad_selected)?;
    h.pad_choose.set_enabled(s.pad_selected)?;
    h.pad_clear.set_enabled(s.pad_selected)?;
    h.duck.set_checked(s.duck_on)?;
    h.waveforms.set_checked(s.show_waveforms)?;
    h.tab_pads.set_checked(s.tab == "pads")?;
    h.tab_settings.set_checked(s.tab == "settings")?;
    Ok(())
}
