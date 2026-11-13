//! byndery's backend: windows, terminals, files, settings, history, updates
//! and Windows integration. The renderer reaches it through the commands
//! below, wrapped in src/renderer/src/bridge.ts as the `Bridge` interface.

mod files;
mod git;
mod handoff;
mod history;
mod integrate;
mod msys;
mod paths;
mod pty;
mod redact;
mod settings;
mod shell;
mod updater;

use paths::{normalize, Dirs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

struct App {
    dirs: Dirs,
    settings: Arc<settings::Store>,
    sessions: pty::Sessions,
    watchers: files::Watchers,
    history: history::History,
    updater: updater::Updater,
    /// Windows that said they can take handed-over consoles.
    handoff_windows: Mutex<HashSet<String>>,
    waiting_handoffs: Mutex<Vec<u32>>,
    launched_for_handoff: bool,
    initial_folder: Option<String>,
    menu: Mutex<Option<(u64, tokio::sync::oneshot::Sender<Option<String>>)>>,
    menu_seq: Mutex<u64>,
    window_seq: Mutex<u32>,
}

type R<T> = Result<T, String>;

// Window state: bounds, maximized and the last workspace, in the data folder.

fn state_path(dirs: &Dirs) -> std::path::PathBuf {
    dirs.data.join("state.json")
}

fn load_state(dirs: &Dirs) -> Value {
    std::fs::read_to_string(state_path(dirs)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}))
}

fn save_state(dirs: &Dirs, patch: Value) {
    let mut s = load_state(dirs);
    if let (Some(o), Some(p)) = (s.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            o.insert(k.clone(), v.clone());
        }
    }
    let _ = std::fs::write(state_path(dirs), s.to_string());
}

fn windows_build() -> Option<u32> {
    #[cfg(windows)]
    {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
        let b: String = key.get_value("CurrentBuildNumber").ok()?;
        return b.parse().ok();
    }
    #[cfg(not(windows))]
    None
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn create_window(app: &AppHandle) -> R<WebviewWindow> {
    let st: State<App> = app.state();
    let label = {
        let mut n = st.window_seq.lock().unwrap();
        *n += 1;
        if *n == 1 { "main".to_string() } else { format!("w{}", *n) }
    };
    let saved = load_state(&st.dirs);
    let init = format!(
        "window.__BYNDERY__ = {};",
        json!({ "platform": platform(), "sys": { "windowsBuild": windows_build(), "home": paths::home(), "handoff": st.launched_for_handoff } })
    );
    let nav_app = app.clone();
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("byndery")
        .inner_size(saved["bounds"]["width"].as_f64().unwrap_or(1280.0), saved["bounds"]["height"].as_f64().unwrap_or(800.0))
        .min_inner_size(560.0, 360.0)
        .visible(false)
        .disable_drag_drop_handler()
        .initialization_script(&init)
        .on_navigation(move |url| {
            let internal = url.scheme() == "tauri" || matches!(url.host_str(), Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1"));
            if !internal && (url.scheme() == "http" || url.scheme() == "https") {
                use tauri_plugin_opener::OpenerExt;
                let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            }
            internal
        });
    if let (Some(x), Some(y)) = (saved["bounds"]["x"].as_f64(), saved["bounds"]["y"].as_f64()) {
        b = b.position(x, y);
    }
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(12.0, 18.0));
    }
    #[cfg(not(target_os = "macos"))]
    {
        b = b.decorations(false);
    }
    let w = b.build().map_err(|e| e.to_string())?;
    if saved["maximized"] == json!(true) {
        let _ = w.maximize();
    }
    // The page shows the window once it has drawn; if the page never gets that far, show it anyway.
    let late = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if !late.is_visible().unwrap_or(true) {
            let _ = late.show();
        }
    });
    apply_theme(app, &st.settings.get());
    Ok(w)
}

fn apply_theme(app: &AppHandle, s: &Value) {
    let theme = match s["general"]["theme"].as_str() {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    };
    for w in app.webview_windows().values() {
        let _ = w.set_theme(theme);
    }
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    let st: State<App> = app.state();
    let label = window.label().to_string();
    match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            let max = window.is_maximized().unwrap_or(false);
            let _ = app.emit_to(label.as_str(), "win:maximized", max);
            if label == "main" {
                if max {
                    save_state(&st.dirs, json!({ "maximized": true }));
                } else if let (Ok(pos), Ok(size), Ok(scale)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                    let (p, s) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
                    if s.width > 100.0 {
                        save_state(&st.dirs, json!({ "maximized": false, "bounds": { "x": p.x, "y": p.y, "width": s.width, "height": s.height } }));
                    }
                }
            }
        }
        WindowEvent::Destroyed => {
            st.sessions.kill_owned(&label);
            st.watchers.unwatch(&label);
            st.handoff_windows.lock().unwrap().remove(&label);
        }
        _ => {}
    }
}

// Commands. Each mirrors a method of the Bridge interface in src/shared/api.ts.

#[tauri::command]
fn win_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_close(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn win_ready(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn win_background(window: WebviewWindow, color: String) {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(v) = u32::from_str_radix(hex, 16) {
            let _ = window.set_background_color(Some(tauri::window::Color((v >> 16) as u8, (v >> 8) as u8, v as u8, 255)));
        }
    }
}

#[tauri::command]
fn win_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[tauri::command]
fn ws_initial(st: State<App>) -> String {
    let saved = load_state(&st.dirs);
    for c in [st.initial_folder.clone(), saved["workspace"].as_str().map(String::from)].into_iter().flatten() {
        if paths::native(&c).is_dir() {
            return normalize(&c);
        }
    }
    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            return paths::normalize_path(&cwd);
        }
    }
    paths::home()
}

#[tauri::command]
fn ws_save(st: State<App>, dir: String) {
    save_state(&st.dirs, json!({ "workspace": dir }));
}

#[derive(Deserialize)]
struct CreateArgs {
    cwd: String,
    cols: u16,
    rows: u16,
    profile: Option<String>,
    /// A command for the new shell to run first (Settings > Tools).
    run: Option<String>,
}

#[tauri::command]
fn term_create(window: WebviewWindow, st: State<App>, args: CreateArgs) -> R<Value> {
    save_state(&st.dirs, json!({ "workspace": args.cwd }));
    let s = st.settings.get();
    let profiles = shell::resolve_profiles(&st.dirs, &s);
    let want = args.profile.clone().or_else(|| if args.run.is_some() { Some("zsh".into()) } else { None });
    let default = s["general"]["defaultProfile"].as_str().unwrap_or("").to_string();
    let visible = |p: &&Value| p["hidden"] != json!(true);
    let p = profiles
        .iter()
        .find(|p| want.as_deref().map(|w| p["id"] == json!(w)).unwrap_or(false))
        .or_else(|| profiles.iter().filter(visible).find(|p| p["id"] == json!(default)))
        .or_else(|| profiles.iter().find(visible))
        .or_else(|| profiles.first())
        .cloned()
        .ok_or("No shell was found.")?;
    let mut start = args.cwd.clone();
    match p["startIn"].as_str() {
        Some("~") => start = paths::home(),
        Some(dir) if !dir.is_empty() && paths::native(dir).is_dir() => start = normalize(dir),
        _ => {}
    }
    let spec = shell::spec_for(&st.dirs, &p);
    let info = json!({
        "shell": spec.name, "profile": p["id"], "profileName": p["name"], "cwd": start,
        "integrated": spec.integrated, "msys": spec.msys, "wsl": spec.wsl
    });
    let (id, slot, info) = st.sessions.add(Some(window.label().to_string()), info, args.cols.max(2), args.rows.max(1));
    let mut extra: Vec<(String, String)> = Vec::new();
    if let Some(run) = args.run.filter(|r| !r.trim().is_empty()) {
        extra.push(("BYNDERY_RUN".into(), run));
    }
    // byndery's own MSYS2 is unpacked the first time zsh starts, if the installer has not done it.
    let needs_msys = cfg!(windows) && spec.msys.as_ref().map(|m| m.root == paths::normalize_path(&st.dirs.msys())).unwrap_or(false) && msys::missing(&st.dirs.msys()).len() > 0;
    let (sessions, dirs) = (st.sessions.clone(), st.dirs.clone());
    if needs_msys {
        std::thread::spawn(move || {
            sessions.output(id, "\r\n  byndery is setting up its Linux tools. This happens once.\r\n");
            let s2 = sessions.clone();
            let res = msys::ensure(&dirs, &move |f| s2.output(id, &msys::bar(f)));
            sessions.output(id, "\r\n\r\n");
            match res.and_then(|_| pty::spawn(&sessions, id, &slot, &spec, &start, &extra)) {
                Ok(()) => {}
                Err(e) => {
                    sessions.output(id, &format!("\x1b[31m{e}\x1b[0m\r\n"));
                    sessions.exited(id, 1);
                }
            }
        });
    } else if let Err(e) = pty::spawn(&sessions, id, &slot, &spec, &start, &extra) {
        st.sessions.kill(id);
        return Err(e);
    }
    Ok(info)
}

#[tauri::command]
fn term_write(st: State<App>, id: u32, data: String) {
    st.sessions.write(id, &data);
}

#[tauri::command]
fn term_ack(st: State<App>, id: u32, n: usize) {
    st.sessions.ack(id, n);
}

#[tauri::command]
fn term_resize(st: State<App>, id: u32, cols: u16, rows: u16) {
    st.sessions.resize(id, cols, rows);
}

#[tauri::command]
fn term_kill(st: State<App>, id: u32) {
    st.sessions.kill(id);
}

#[tauri::command]
fn term_attach(window: WebviewWindow, st: State<App>, id: u32, cols: u16, rows: u16) -> Option<Value> {
    st.sessions.attach(window.label(), id, cols, rows)
}

#[tauri::command]
fn term_handoffs(window: WebviewWindow, st: State<App>) -> Vec<u32> {
    st.handoff_windows.lock().unwrap().insert(window.label().to_string());
    std::mem::take(&mut *st.waiting_handoffs.lock().unwrap())
}

/// A console Windows handed over: to the focused window that can take it, or queued.
fn receive_console(app: &AppHandle, id: u32) {
    let st: State<App> = app.state();
    let ready: Vec<WebviewWindow> = {
        let labels = st.handoff_windows.lock().unwrap();
        app.webview_windows().into_values().filter(|w| labels.contains(w.label())).collect()
    };
    let target = ready.iter().find(|w| w.is_focused().unwrap_or(false)).or(ready.first()).cloned();
    match target {
        Some(w) => {
            let _ = app.emit_to(w.label(), "term:handoff", id);
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            st.waiting_handoffs.lock().unwrap().push(id);
            if app.webview_windows().is_empty() {
                let _ = create_window(app);
            }
        }
    }
}

#[tauri::command]
fn fs_list(dir: String) -> R<Vec<files::DirEntry>> {
    files::list(&dir)
}

#[tauri::command]
fn fs_read(path: String) -> Value {
    files::read(&path)
}

#[tauri::command]
fn fs_write(path: String, text: String) -> R<f64> {
    files::write(&path, &text)
}

#[tauri::command]
fn fs_stat(path: String) -> Value {
    files::stat(&path)
}

#[tauri::command]
fn fs_watch(app: AppHandle, window: WebviewWindow, st: State<App>, root: String) {
    st.watchers.watch(&app, window.label(), &root);
}

#[tauri::command]
fn fs_drives() -> Vec<String> {
    files::drives()
}

#[tauri::command]
async fn fs_find(root: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || files::find(&root)).await.unwrap_or_default()
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> R<()> {
    files::rename(&from, &to)
}

#[tauri::command]
fn fs_trash(path: String) -> R<()> {
    files::trash(&path)
}

#[tauri::command]
fn fs_create(path: String, dir: bool) -> R<()> {
    files::create(&path, dir)
}

#[tauri::command]
async fn git_status(root: String) -> Value {
    tauri::async_runtime::spawn_blocking(move || git::status(&root)).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn git_show(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || git::show(&path)).await.ok().flatten()
}

#[tauri::command]
fn history_record(st: State<App>, record: history::Record) -> R<()> {
    if st.settings.get()["history"]["enabled"] == json!(false) {
        return Ok(());
    }
    st.history.record(record)
}

#[tauri::command]
fn history_search(st: State<App>, query: history::Query) -> R<Vec<Value>> {
    st.history.search(query)
}

#[tauri::command]
fn history_output(st: State<App>, id: i64) -> R<Value> {
    st.history.output(id)
}

#[tauri::command]
fn history_remove(st: State<App>, id: i64) -> R<()> {
    st.history.remove(id)
}

#[tauri::command]
fn history_clear(st: State<App>) -> R<()> {
    st.history.clear()
}

fn settings_state(st: &App) -> Value {
    let s = st.settings.get();
    json!({
        "effective": s, "user": st.settings.user(), "profiles": shell::resolve_profiles(&st.dirs, &s),
        "file": paths::normalize_path(&st.settings.file()), "error": st.settings.error()
    })
}

/// Settings changed, from the window or the file: everything that depends on them follows.
fn settings_changed(app: &AppHandle) {
    let st: State<App> = app.state();
    let s = st.settings.get();
    apply_theme(app, &s);
    let dirs = st.dirs.clone();
    std::thread::spawn(move || integrate::apply(&dirs, &s));
    let _ = app.emit("settings:changed", settings_state(&st));
}

#[tauri::command]
fn settings_get(st: State<App>) -> Value {
    settings_state(&st)
}

#[tauri::command]
fn settings_set(app: AppHandle, st: State<App>, path: Vec<String>, value: Value) -> Value {
    st.settings.set(&path, value);
    settings_changed(&app);
    settings_state(&st)
}

#[tauri::command]
fn settings_reset(app: AppHandle, st: State<App>, path: Vec<String>) -> Value {
    st.settings.reset(&path);
    settings_changed(&app);
    settings_state(&st)
}

#[tauri::command]
async fn settings_explain(app: AppHandle, line: String) -> Value {
    let dirs = app.state::<App>().dirs.clone();
    let r = tauri::async_runtime::spawn_blocking(move || shell::explain_route(&dirs, &line)).await.ok().flatten();
    match r {
        Some((system, reason)) => json!({ "system": system, "reason": reason }),
        None => Value::Null,
    }
}

#[tauri::command]
fn updates_get(st: State<App>) -> Value {
    st.updater.get()
}

#[tauri::command]
async fn updates_check(app: AppHandle) -> Value {
    app.state::<App>().updater.check(&app).await
}

#[tauri::command]
fn updates_set_enabled(app: AppHandle, st: State<App>, enabled: bool) -> Value {
    let v = st.updater.set_enabled(&app, enabled);
    if enabled {
        let a = app.clone();
        tauri::async_runtime::spawn(async move {
            a.state::<App>().updater.check(&a).await;
        });
    }
    v
}

#[tauri::command]
async fn updates_install(app: AppHandle) -> Value {
    app.state::<App>().updater.install_now(&app).await
}

#[tauri::command]
async fn defterm_get(app: AppHandle) -> Value {
    let dirs = app.state::<App>().dirs.clone();
    tauri::async_runtime::spawn_blocking(move || handoff::state(&dirs)).await.unwrap_or(Value::Null)
}

#[tauri::command]
async fn defterm_set(app: AppHandle, enabled: bool) -> Value {
    let dirs = app.state::<App>().dirs.clone();
    tauri::async_runtime::spawn_blocking(move || handoff::set(&dirs, enabled)).await.unwrap_or(Value::Null)
}

/// Settings > Tools: byndery's MSYS2, the packages added to it, and the Windows integration.
#[tauri::command]
async fn tools_status(app: AppHandle) -> Value {
    let dirs = app.state::<App>().dirs.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = msys::status(&dirs);
        s["added"] = json!(if s["healthy"] == json!(true) { msys::added_packages(&dirs) } else { vec![] });
        s["integration"] = integrate::status(&dirs);
        s
    })
    .await
    .unwrap_or(Value::Null)
}

/// Unpacks byndery's base over its MSYS2: restores missing or damaged files, keeps added packages.
#[tauri::command]
async fn tools_repair(app: AppHandle) -> R<Value> {
    let dirs = app.state::<App>().dirs.clone();
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || msys::unpack(&dirs, &|f| {
        let _ = a.emit("tools:progress", f);
    }))
    .await
    .map_err(|e| e.to_string())??;
    Ok(tools_status(app).await)
}

#[derive(Deserialize)]
struct MenuItemSpec {
    id: Option<String>,
    label: Option<String>,
    accel: Option<String>,
    enabled: Option<bool>,
    separator: Option<bool>,
}

/// A native context menu; resolves with the chosen item's id, or null.
#[tauri::command]
async fn menu_popup(app: AppHandle, window: WebviewWindow, items: Vec<MenuItemSpec>) -> R<Option<String>> {
    let st: State<App> = app.state();
    let seq = {
        let mut n = st.menu_seq.lock().unwrap();
        *n += 1;
        *n
    };
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    for it in items {
        if it.separator == Some(true) {
            menu.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            continue;
        }
        let id = format!("ctx:{seq}:{}", it.id.unwrap_or_default());
        let mut b = MenuItemBuilder::with_id(id, it.label.unwrap_or_default()).enabled(it.enabled != Some(false));
        if let Some(a) = it.accel.filter(|a| !a.is_empty()) {
            b = b.accelerator(a);
        }
        menu.append(&b.build(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    // A new menu answers the previous one with nothing chosen.
    if let Some((_, old)) = st.menu.lock().unwrap().replace((seq, tx)) {
        let _ = old.send(None);
    }
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    // Windows and macOS menus are modal: the choice, if any, arrives right after they close.
    let wait = if cfg!(target_os = "linux") { 600 } else { 120 };
    Ok(tokio::time::timeout(std::time::Duration::from_secs(wait), rx).await.ok().and_then(|r| r.ok()).flatten())
}

fn on_menu_event(app: &AppHandle, id: &str) {
    let Some(rest) = id.strip_prefix("ctx:") else { return };
    let mut parts = rest.splitn(2, ':');
    let seq: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let item = parts.next().unwrap_or("").to_string();
    let st: State<App> = app.state();
    let mut g = st.menu.lock().unwrap();
    if g.as_ref().map(|(s, _)| *s == seq).unwrap_or(false) {
        if let Some((_, tx)) = g.take() {
            let _ = tx.send(if item.is_empty() { None } else { Some(item) });
        }
    }
}

fn watch_settings(app: &AppHandle) {
    let st: State<App> = app.state();
    let dir = st.dirs.data.clone();
    let a = app.clone();
    std::thread::spawn(move || {
        use notify::Watcher;
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut w) = notify::recommended_watcher(tx) else { return };
        if w.watch(&dir, notify::RecursiveMode::NonRecursive).is_err() {
            return;
        }
        while let Ok(ev) = rx.recv() {
            let Ok(ev) = ev else { continue };
            if !ev.paths.iter().any(|p| p.file_name().map(|n| n == "settings.json").unwrap_or(false)) {
                continue;
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
            while rx.try_recv().is_ok() {}
            if a.state::<App>().settings.read() {
                settings_changed(&a);
            }
        }
    });
}

/// Folders and helpers for command-line runs, which have no window: resources sit beside the exe.
fn cli_dirs() -> Dirs {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let base = |d: Option<std::path::PathBuf>| d.unwrap_or_else(std::env::temp_dir).join("byndery");
    Dirs {
        data: base(dirs::config_dir()),
        local: paths::local_dir(),
        integration: exe_dir.join("shell"),
        vendor: exe_dir.join("vendor"),
        helpers: exe_dir.join("handoff"),
        temp: std::env::temp_dir().join("byndery-shell"),
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Installer steps: no window, exit code only.
    if args.iter().any(|a| a == "--seed-msys") {
        std::process::exit(match msys::ensure(&cli_dirs(), &|_| {}) {
            Ok(_) => 0,
            Err(_) => 1,
        });
    }
    if args.iter().any(|a| a == "--unintegrate") {
        integrate::remove_all(&cli_dirs());
        std::process::exit(0);
    }
    let launched_for_handoff = args.iter().any(|a| a == "--handoff");
    let initial_folder = args.iter().find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir()).cloned();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("byndery-file", |_ctx, request, responder| {
            // byndery-file://localhost/C:/path/img.png serves local files to rendered Markdown.
            let raw = request.uri().path().to_string();
            std::thread::spawn(move || {
                let mut p = percent_decode(&raw);
                if p.len() > 3 && p.as_bytes()[0] == b'/' && p.as_bytes()[2] == b':' {
                    p.remove(0);
                }
                let resp = match std::fs::read(paths::native(&p)) {
                    Ok(bytes) => tauri::http::Response::builder().header("Content-Type", mime(&p)).header("Access-Control-Allow-Origin", "*").body(bytes),
                    Err(_) => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                responder.respond(resp.unwrap());
            });
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let dirs = Dirs::new(&handle);
            let store = Arc::new(settings::Store::new(dirs.clone()));
            store.read();
            let sessions = pty::Sessions::new(handle.clone());
            app.manage(App {
                history: history::History::new(dirs.data.join("history.db")),
                updater: updater::Updater::new(dirs.data.clone()),
                dirs: dirs.clone(),
                settings: store.clone(),
                sessions: sessions.clone(),
                watchers: files::Watchers::default(),
                handoff_windows: Mutex::new(HashSet::new()),
                waiting_handoffs: Mutex::new(Vec::new()),
                launched_for_handoff,
                initial_folder: initial_folder.clone(),
                menu: Mutex::new(None),
                menu_seq: Mutex::new(0),
                window_seq: Mutex::new(0),
            });
            #[cfg(windows)]
            {
                let h = handle.clone();
                handoff::server::start(sessions, move |id, _header| receive_console(&h, id));
            }
            #[cfg(not(windows))]
            let _ = (sessions, receive_console as fn(&AppHandle, u32));
            watch_settings(&handle);
            create_window(&handle).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let h = handle.clone();
            std::thread::spawn(move || {
                let st: State<App> = h.state();
                integrate::apply(&st.dirs, &st.settings.get());
                if !cfg!(debug_assertions) {
                    handoff::refresh(&st.dirs);
                }
            });
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                loop {
                    h.state::<App>().updater.check(&h).await;
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                }
            });
            Ok(())
        })
        .on_window_event(on_window_event)
        .on_menu_event(|app, ev| on_menu_event(app, ev.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            win_minimize, win_toggle_maximize, win_close, win_ready, win_background, win_devtools,
            ws_initial, ws_save,
            term_create, term_write, term_ack, term_resize, term_kill, term_attach, term_handoffs,
            fs_list, fs_read, fs_write, fs_stat, fs_watch, fs_drives, fs_find, fs_rename, fs_trash, fs_create,
            git_status, git_show,
            history_record, history_search, history_output, history_remove, history_clear,
            settings_get, settings_set, settings_reset, settings_explain,
            updates_get, updates_check, updates_set_enabled, updates_install,
            defterm_get, defterm_set,
            tools_status, tools_repair,
            menu_popup
        ])
        .build(tauri::generate_context!())
        .expect("byndery could not start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let st: State<App> = app.state();
                st.sessions.kill_all();
                st.updater.install_on_quit();
            }
        });
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}
