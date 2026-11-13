//! Updates from GitHub Releases. Every download is checked against the
//! SHA-256 digest GitHub publishes, or the release's .sha256 file. Windows
//! installs and Linux AppImages update themselves; the other packages open
//! the release page. Asset names are the same as 0.0.1's, so its updater
//! finds this version's files too.

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const REPO: &str = "thd2020/byndery";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Nsis,
    AppImage,
    Manual,
}

pub fn target() -> (&'static str, &'static str, Kind) {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    if cfg!(windows) {
        let exe = std::env::current_exe().unwrap_or_default();
        let nsis = exe.parent().map(|d| d.join("uninstall.exe").exists()).unwrap_or(false);
        ("win", arch, if nsis { Kind::Nsis } else { Kind::Manual })
    } else if cfg!(target_os = "linux") {
        ("linux", arch, if std::env::var_os("APPIMAGE").is_some() { Kind::AppImage } else { Kind::Manual })
    } else {
        ("mac", arch, Kind::Manual)
    }
}

pub fn asset_name(version: &str, os: &str, arch: &str, kind: Kind) -> String {
    let ext = if kind == Kind::AppImage { "AppImage" } else if os == "win" { "exe" } else { "dmg" };
    // AppImages carry the Linux arch name: x86_64, arm64.
    let arch = if kind == Kind::AppImage && arch == "x64" { "x86_64" } else { arch };
    format!("byndery-{version}-{os}-{arch}.{ext}")
}

pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| s.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let o = x.get(i).unwrap_or(&0).cmp(y.get(i).unwrap_or(&0));
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    std::cmp::Ordering::Equal
}

pub struct Updater {
    state: Mutex<Value>,
    release: Mutex<Option<Value>>,
    installer: Mutex<Option<PathBuf>>,
    checking: tokio::sync::Mutex<()>,
    data: PathBuf,
}

fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

impl Updater {
    pub fn new(data: PathBuf) -> Updater {
        let (_, _, kind) = target();
        let packaged = !cfg!(debug_assertions);
        let auto = std::fs::read_to_string(data.join("update-settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|v| v["autoEnabled"] != json!(false))
            .unwrap_or(true);
        let state = json!({
            "currentVersion": version(), "availableVersion": null, "releasePage": null, "status": "idle", "progress": 0,
            "canCheck": packaged, "supportsAutoUpdate": packaged && kind != Kind::Manual, "installSupported": false,
            "canInstall": false, "autoEnabled": auto, "error": null
        });
        Updater { state: Mutex::new(state), release: Mutex::new(None), installer: Mutex::new(None), checking: tokio::sync::Mutex::new(()), data }
    }

    pub fn get(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn patch(&self, app: &AppHandle, p: Value) {
        let s = {
            let mut s = self.state.lock().unwrap();
            if let (Some(o), Some(n)) = (s.as_object_mut(), p.as_object()) {
                for (k, v) in n {
                    o.insert(k.clone(), v.clone());
                }
            }
            s.clone()
        };
        let _ = app.emit("updates:changed", s);
    }

    pub fn set_enabled(&self, app: &AppHandle, on: bool) -> Value {
        let _ = std::fs::create_dir_all(&self.data);
        let _ = std::fs::write(self.data.join("update-settings.json"), json!({ "autoEnabled": on }).to_string());
        self.patch(app, json!({ "autoEnabled": on }));
        self.get()
    }

    pub async fn check(&self, app: &AppHandle) -> Value {
        if cfg!(debug_assertions) {
            return self.get();
        }
        let Ok(_g) = self.checking.try_lock() else { return self.get() };
        self.patch(app, json!({ "status": "checking", "error": null, "progress": 0 }));
        match self.check_inner(app).await {
            Ok(()) => {}
            Err(e) => self.patch(app, json!({ "status": "error", "error": e })),
        }
        self.get()
    }

    async fn check_inner(&self, app: &AppHandle) -> Result<(), String> {
        let (os, arch, kind) = target();
        let release = fetch_release(os, arch, kind).await?;
        let tag = release["tag_name"].as_str().unwrap_or("").to_string();
        let ver = tag.trim_start_matches('v').to_string();
        let page = release["html_url"].clone();
        if compare(&ver, &version()) != std::cmp::Ordering::Greater {
            *self.release.lock().unwrap() = None;
            self.patch(app, json!({ "status": "idle", "availableVersion": null, "releasePage": page, "installSupported": false, "canInstall": false }));
            return Ok(());
        }
        let name = asset_name(&ver, os, arch, kind);
        let asset = release["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().map(|n| n.eq_ignore_ascii_case(&name)).unwrap_or(false)).cloned());
        *self.release.lock().unwrap() = Some(release.clone());
        let supported = kind != Kind::Manual && asset.is_some();
        self.patch(app, json!({ "availableVersion": ver, "releasePage": page, "installSupported": supported, "canInstall": false, "status": "idle", "progress": 0 }));
        if supported && self.get()["autoEnabled"] == json!(true) {
            self.download(app, &asset.unwrap(), &tag).await?;
        }
        Ok(())
    }

    async fn download(&self, app: &AppHandle, asset: &Value, tag: &str) -> Result<PathBuf, String> {
        let name = asset["name"].as_str().unwrap_or("").to_string();
        let url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
        let size = asset["size"].as_u64().unwrap_or(0);
        let expected = match asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")) {
            Some(d) => d.to_lowercase(),
            None => sidecar(&format!("https://github.com/{REPO}/releases/download/{tag}/{name}"), &name).await.ok_or(format!("No SHA-256 checksum was published for {name}"))?,
        };
        let dir = self.data.join("updates");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(&name);
        if file.exists() && sha256_file(&file) == expected {
            return Ok(self.ready(app, file));
        }
        let part = dir.join(format!("{name}.part"));
        let resp = client().get(&url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Could not download {name}"));
        }
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut got = 0u64;
        let mut last = 0f64;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            got += chunk.len() as u64;
            let p = if size > 0 { got as f64 / size as f64 } else { 0.0 };
            if p - last > 0.02 {
                last = p;
                self.patch(app, json!({ "status": "downloading", "progress": p.min(1.0) }));
            }
        }
        drop(out);
        if hex::encode(hasher.finalize()) != expected {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Checksum mismatch for {name}"));
        }
        std::fs::rename(&part, &file).map_err(|e| e.to_string())?;
        Ok(self.ready(app, file))
    }

    fn ready(&self, app: &AppHandle, file: PathBuf) -> PathBuf {
        *self.installer.lock().unwrap() = Some(file.clone());
        self.patch(app, json!({ "status": "ready", "canInstall": true, "progress": 1 }));
        file
    }

    pub async fn install_now(&self, app: &AppHandle) -> Value {
        let s = self.get();
        let (os, arch, kind) = target();
        if kind == Kind::Manual || s["installSupported"] != json!(true) {
            if let Some(page) = s["releasePage"].as_str() {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_url(page, None::<&str>);
            }
            return self.get();
        }
        if s["status"] != json!("ready") {
            let release = self.release.lock().unwrap().clone();
            let Some(release) = release else { return self.get() };
            let ver = s["availableVersion"].as_str().unwrap_or("").to_string();
            let name = asset_name(&ver, os, arch, kind);
            let asset = release["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == json!(name)).cloned());
            let Some(asset) = asset else {
                self.patch(app, json!({ "status": "error", "error": format!("The release has no installer for {os} {arch}") }));
                return self.get();
            };
            if let Err(e) = self.download(app, &asset, release["tag_name"].as_str().unwrap_or("")).await {
                self.patch(app, json!({ "status": "error", "error": e }));
                return self.get();
            }
        }
        match self.install(true) {
            Ok(()) => app.exit(0),
            Err(e) => self.patch(app, json!({ "status": "error", "error": e })),
        }
        self.get()
    }

    /// On quit, in automatic mode, a downloaded update installs without reopening byndery.
    pub fn install_on_quit(&self) {
        if self.get()["autoEnabled"] == json!(true) && self.get()["status"] == json!("ready") {
            let _ = self.install(false);
        }
    }

    fn install(&self, relaunch: bool) -> Result<(), String> {
        let file = self.installer.lock().unwrap().take().ok_or("Nothing to install")?;
        let (_, _, kind) = target();
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        match kind {
            Kind::Nsis => install_nsis(&file, &exe, relaunch),
            Kind::AppImage => {
                let dest = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("not an AppImage")?);
                let staged = dest.with_extension("new");
                std::fs::copy(&file, &staged).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
                }
                std::fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&file);
                if relaunch {
                    let _ = std::process::Command::new(&dest).spawn();
                }
                Ok(())
            }
            Kind::Manual => Err("The update cannot replace this installation.".into()),
        }
    }
}

/// Runs the installer silently: /UPDATE keeps the install folder and skips the
/// uninstall pass, /R reopens byndery afterwards. The installer waits for byndery to quit.
fn install_nsis(file: &Path, _exe: &Path, relaunch: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new(file);
    cmd.args(["/S", "/UPDATE"]);
    if relaunch {
        cmd.arg("/R");
    }
    crate::shell::quiet(&mut cmd).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent(format!("byndery/{}", version())).build().unwrap()
}

fn sha256_file(p: &Path) -> String {
    let Ok(mut f) = std::fs::File::open(p) else { return String::new() };
    let mut h = Sha256::new();
    if std::io::copy(&mut f, &mut h).is_err() {
        return String::new();
    }
    hex::encode(h.finalize())
}

async fn sidecar(url: &str, name: &str) -> Option<String> {
    let text = client().get(format!("{url}.sha256")).send().await.ok()?.text().await.ok()?;
    let mut it = text.split_whitespace();
    let (hash, file) = (it.next()?, it.next()?.trim_start_matches('*'));
    (hash.len() == 64 && file == name).then(|| hash.to_lowercase())
}

/// The latest release, from the API or, when it is rate-limited, from the release page and .sha256 files.
async fn fetch_release(os: &str, arch: &str, kind: Kind) -> Result<Value, String> {
    let api = client().get(format!("https://api.github.com/repos/{REPO}/releases/latest")).header("Accept", "application/vnd.github+json").send().await;
    if let Ok(r) = api {
        if r.status().is_success() {
            return r.json::<Value>().await.map_err(|e| e.to_string());
        }
    }
    let no_redirect = reqwest::Client::builder().user_agent(format!("byndery/{}", version())).redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let r = no_redirect.head(format!("https://github.com/{REPO}/releases/latest")).send().await.map_err(|e| e.to_string())?;
    let page = r.headers().get("location").and_then(|l| l.to_str().ok()).ok_or("GitHub could not be reached")?.to_string();
    let tag = page.rsplit('/').next().unwrap_or("").to_string();
    let ver = tag.trim_start_matches('v');
    let name = asset_name(ver, os, arch, kind);
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/{name}");
    let assets = match sidecar(&url, &name).await {
        Some(d) => json!([{ "name": name, "browser_download_url": url, "size": 0, "digest": format!("sha256:{d}") }]),
        None => json!([]),
    };
    Ok(json!({ "tag_name": tag, "html_url": page, "assets": assets }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_0_0_1() {
        assert_eq!(asset_name("0.0.2", "win", "x64", Kind::Nsis), "byndery-0.0.2-win-x64.exe");
        assert_eq!(asset_name("0.0.2", "linux", "x64", Kind::AppImage), "byndery-0.0.2-linux-x86_64.AppImage");
        assert_eq!(asset_name("0.0.2", "linux", "arm64", Kind::AppImage), "byndery-0.0.2-linux-arm64.AppImage");
        assert_eq!(asset_name("0.0.2", "mac", "arm64", Kind::Manual), "byndery-0.0.2-mac-arm64.dmg");
        assert_eq!(compare("0.0.10", "0.0.9"), std::cmp::Ordering::Greater);
        assert_eq!(compare("v0.0.2", "0.0.2"), std::cmp::Ordering::Equal);
    }
}
