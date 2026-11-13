//! byndery's tools for the rest of Windows (Settings > Integration):
//! "Open in byndery" in Explorer, byndery's bash for Claude Code
//! (CLAUDE_CODE_GIT_BASH_PATH), and the Linux tools on the user's PATH.
//! Everything is per-user (HKCU) and undone by `byndery --unintegrate`,
//! which the uninstaller runs.

use crate::paths::Dirs;
use serde_json::Value;

#[cfg(windows)]
mod win {
    use crate::paths::Dirs;
    use std::path::Path;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const MENU_KEYS: [&str; 3] = [r"Software\Classes\Directory\shell\byndery", r"Software\Classes\Directory\Background\shell\byndery", r"Software\Classes\Drive\shell\byndery"];
    const BASH_VAR: &str = "CLAUDE_CODE_GIT_BASH_PATH";
    const OURS: &str = r"Software\byndery\Integration";

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    pub fn explorer_menu(exe: &Path, on: bool) {
        for key in MENU_KEYS {
            if on {
                let Ok((k, _)) = hkcu().create_subkey(key) else { continue };
                let _ = k.set_value("", &"Open in byndery");
                let _ = k.set_value("Icon", &format!("\"{}\"", exe.display()));
                if let Ok((c, _)) = k.create_subkey("command") {
                    let arg = if key.contains("Background") { "%V" } else { "%1" };
                    let _ = c.set_value("", &format!("\"{}\" \"{}\"", exe.display(), arg));
                }
            } else {
                let _ = hkcu().delete_subkey_all(key);
            }
        }
    }

    fn env_key() -> Option<RegKey> {
        hkcu().open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE).ok()
    }

    fn ours() -> Option<RegKey> {
        hkcu().create_subkey(OURS).ok().map(|(k, _)| k)
    }

    /// Lets other programs see an environment change without signing out.
    fn announce() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let what: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, what.as_ptr() as isize, SMTO_ABORTIFHUNG, 2000, &mut result);
        }
    }

    /// Points Claude Code at byndery's bash, unless the user set the variable to something else.
    pub fn git_bash_for_apps(dirs: &Dirs, on: bool) {
        let (Some(env), Some(ours)) = (env_key(), ours()) else { return };
        let bash = dirs.msys().join("usr").join("bin").join("bash.exe").to_string_lossy().to_string();
        let current: Option<String> = env.get_value(BASH_VAR).ok();
        let mine: Option<String> = ours.get_value(BASH_VAR).ok();
        if on {
            if current.is_none() || current == mine {
                if current.as_deref() != Some(&bash) {
                    let _ = env.set_value(BASH_VAR, &bash);
                    let _ = ours.set_value(BASH_VAR, &bash);
                    announce();
                }
            }
        } else if current.is_some() && current == mine {
            let _ = env.delete_value(BASH_VAR);
            let _ = ours.delete_value(BASH_VAR);
            announce();
        }
    }

    /// Appends MSYS2's usr\bin to the user PATH, after everything else, so Windows' own tools win.
    pub fn tools_on_path(dirs: &Dirs, on: bool) {
        let (Some(env), Some(ours)) = (env_key(), ours()) else { return };
        let dir = dirs.msys().join("usr").join("bin").to_string_lossy().to_string();
        let path: String = env.get_value("Path").unwrap_or_default();
        let mut parts: Vec<String> = path.split(';').filter(|p| !p.is_empty()).map(String::from).collect();
        let has = parts.iter().any(|p| p.eq_ignore_ascii_case(&dir));
        if on && !has {
            parts.push(dir.clone());
            let _ = env.set_raw_value("Path", &winreg::RegValue { vtype: winreg::enums::REG_EXPAND_SZ, bytes: to_wide(&parts.join(";")) });
            let _ = ours.set_value("Path", &dir);
            announce();
        } else if !on && has {
            let mine: Option<String> = ours.get_value("Path").ok();
            if mine.as_deref().map(|m| m.eq_ignore_ascii_case(&dir)).unwrap_or(false) {
                parts.retain(|p| !p.eq_ignore_ascii_case(&dir));
                let _ = env.set_raw_value("Path", &winreg::RegValue { vtype: winreg::enums::REG_EXPAND_SZ, bytes: to_wide(&parts.join(";")) });
                let _ = ours.delete_value("Path");
                announce();
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u8> {
        s.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect()
    }

    pub fn status(dirs: &Dirs) -> serde_json::Value {
        let env = env_key();
        let bash: Option<String> = env.as_ref().and_then(|e| e.get_value(BASH_VAR).ok());
        serde_json::json!({
            "explorerMenu": hkcu().open_subkey(MENU_KEYS[0]).is_ok(),
            "gitBashForApps": bash.is_some(),
            "gitBashPath": bash,
            "bash": dirs.msys().join("usr").join("bin").join("bash.exe").to_string_lossy(),
        })
    }

    pub fn remove_all(dirs: &Dirs, exe: &Path) {
        explorer_menu(exe, false);
        git_bash_for_apps(dirs, false);
        tools_on_path(dirs, false);
        let _ = hkcu().delete_subkey_all(OURS);
    }
}

/// Brings the registry in line with Settings > Integration.
pub fn apply(dirs: &Dirs, settings: &Value) {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let i = &settings["integration"];
        win::explorer_menu(&exe, i["explorerMenu"].as_bool().unwrap_or(true));
        let msys_ready = dirs.msys().join("usr").join("bin").join("bash.exe").exists();
        win::git_bash_for_apps(dirs, msys_ready && i["gitBashForApps"].as_bool().unwrap_or(false));
        win::tools_on_path(dirs, msys_ready && i["toolsOnPath"].as_bool().unwrap_or(false));
    }
    #[cfg(not(windows))]
    let _ = (dirs, settings);
}

pub fn status(dirs: &Dirs) -> Value {
    #[cfg(windows)]
    return win::status(dirs);
    #[cfg(not(windows))]
    {
        let _ = dirs;
        serde_json::json!({ "explorerMenu": false, "gitBashForApps": false, "gitBashPath": null, "bash": null })
    }
}

/// Undoes everything; the uninstaller runs `byndery --unintegrate`.
pub fn remove_all(dirs: &Dirs) {
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        win::remove_all(dirs, &exe);
    }
    #[cfg(not(windows))]
    let _ = dirs;
}
