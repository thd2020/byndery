//! Where byndery keeps things, and the path forms shared with the renderer.
//!
//! Paths cross to the renderer in one canonical form: forward slashes and an
//! upper-case drive letter, as in `src/shared/paths.ts`.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The folders byndery uses on this machine.
#[derive(Clone, Debug)]
pub struct Dirs {
    /// Settings, history and window state. The same folder Electron builds used
    /// (%APPDATA%\byndery), so 0.0.1 settings and history carry over.
    pub data: PathBuf,
    /// Large per-machine files: the MSYS2 tree on Windows.
    pub local: PathBuf,
    /// byndery's shell integration scripts.
    pub integration: PathBuf,
    /// Bundled shell resources: Powerlevel10k, plugins, gitstatusd, and on
    /// Windows the MSYS2 archive.
    pub vendor: PathBuf,
    /// Helper programs shipped beside the app (byndery-handoff.exe).
    pub helpers: PathBuf,
    /// Scratch space for the shells, cleared at each start.
    pub temp: PathBuf,
}

impl Dirs {
    pub fn new(app: &AppHandle) -> Dirs {
        let base = |d: Option<PathBuf>| d.unwrap_or_else(std::env::temp_dir).join("byndery");
        let data = base(dirs::config_dir());
        let local = local_dir();
        let resources = app.path().resource_dir().ok();
        // Development runs use the repository's folders.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let pick = |packaged: &str, dev: PathBuf| -> PathBuf {
            if let Some(r) = &resources {
                let p = r.join(packaged);
                if p.exists() {
                    return p;
                }
            }
            dev
        };
        let integration = pick("shell", repo.join("resources").join("shell"));
        let vendor = pick("vendor", repo.join("vendor"));
        let helpers = pick("handoff", repo.join("build").join("handoff"));
        let temp = std::env::temp_dir().join("byndery-shell");
        let _ = std::fs::remove_dir_all(&temp);
        let _ = std::fs::create_dir_all(&temp);
        let _ = std::fs::create_dir_all(&data);
        Dirs { data, local, integration, vendor, helpers, temp }
    }

    pub fn routing_file(&self) -> PathBuf {
        self.data.join("shell").join("routing")
    }

    pub fn managed_zsh(&self) -> PathBuf {
        self.data.join("shell").join("managed.zsh")
    }

    pub fn managed_sh(&self) -> PathBuf {
        self.data.join("shell").join("managed.sh")
    }

    /// The MSYS2 tree byndery runs zsh from (Windows).
    pub fn msys(&self) -> PathBuf {
        self.local.join("msys64")
    }
}

/// Large per-machine files. Named after the bundle id: the install folder is
/// %LOCALAPPDATA%\byndery, and the uninstaller's "delete app data" box
/// removes this one.
pub fn local_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("com.holarky.byndery")
}

pub fn is_windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// Forward slashes, upper-case drive letter, no doubled or trailing slash.
pub fn normalize(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_lowercase() {
        s = s[..1].to_ascii_uppercase() + &s[1..];
    }
    // UNC paths (//server/share, //wsl.localhost/Ubuntu) keep their leading //.
    let unc = s.starts_with("//") && s.as_bytes().get(2).map(|c| *c != b'/').unwrap_or(false);
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if unc {
        s.insert(0, '/');
    }
    let drive_root = s.len() == 3 && s.as_bytes()[1] == b':' && s.ends_with('/');
    if s.len() > 1 && s.ends_with('/') && !drive_root {
        s.pop();
    }
    s
}

pub fn normalize_path(p: &Path) -> String {
    normalize(&p.to_string_lossy())
}

/// C:/Users/me -> /c/Users/me, the form MSYS shells take.
pub fn to_msys(p: &str) -> String {
    let s = normalize(p);
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let rest = &s[2..];
        return format!("/{}{}", (b[0] as char).to_ascii_lowercase(), rest);
    }
    s
}

/// A path from the renderer, in the platform's own form.
pub fn native(p: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(p.replace('/', "\\"))
    } else {
        PathBuf::from(p)
    }
}

pub fn home() -> String {
    dirs::home_dir().map(|h| normalize_path(&h)).unwrap_or_else(|| "/".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forms() {
        assert_eq!(normalize("c:\\Users\\me\\"), "C:/Users/me");
        assert_eq!(normalize("C:/"), "C:/");
        assert_eq!(normalize("/usr//bin/"), "/usr/bin");
        assert_eq!(normalize("\\\\wsl.localhost\\Ubuntu\\home\\"), "//wsl.localhost/Ubuntu/home");
        assert_eq!(to_msys("C:\\Users\\me"), "/c/Users/me");
        assert!(is_windows_path("d:\\x"));
        assert!(!is_windows_path("/c/x"));
    }
}
