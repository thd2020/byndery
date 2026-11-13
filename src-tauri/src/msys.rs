//! byndery's own MSYS2 (Windows). The installer carries it as one archive,
//! vendor/msys64.tar.zst, which is unpacked into
//! %LOCALAPPDATA%\com.holarky.byndery\msys64.
//! It lives outside the app folder so app updates never touch it: packages the
//! user adds with pacman stay. Repair unpacks the base again over the tree,
//! which restores missing or damaged files and keeps added packages.

use crate::paths::Dirs;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Files without which zsh, git or pacman cannot start.
const CRITICAL: [&str; 7] = [
    "usr/bin/msys-2.0.dll",
    "usr/bin/zsh.exe",
    "usr/bin/bash.exe",
    "usr/bin/git.exe",
    "usr/bin/pacman.exe",
    "etc/fstab",
    "etc/nsswitch.conf",
];
const STAMP: &str = ".byndery-base";

static BUSY: Mutex<()> = Mutex::new(());

pub fn bundled_archive(dirs: &Dirs) -> Option<PathBuf> {
    let p = dirs.vendor.join("msys64.tar.zst");
    p.exists().then_some(p)
}

fn bundled_stamp(dirs: &Dirs) -> String {
    std::fs::read_to_string(dirs.vendor.join("msys64.stamp")).unwrap_or_default().trim().to_string()
}

pub fn missing(root: &Path) -> Vec<String> {
    CRITICAL.iter().filter(|f| !root.join(f).exists()).map(|f| f.to_string()).collect()
}

/// Whether byndery's MSYS2 is unpacked, intact, and from this build's archive.
pub fn status(dirs: &Dirs) -> Value {
    let root = dirs.msys();
    let installed = root.join(STAMP).exists();
    let miss = if installed { missing(&root) } else { vec![] };
    let stamp = std::fs::read_to_string(root.join(STAMP)).unwrap_or_default().trim().to_string();
    json!({
        "bundled": bundled_archive(dirs).is_some(),
        "installed": installed,
        "healthy": installed && miss.is_empty(),
        "missing": miss,
        "path": crate::paths::normalize_path(&root),
        "base": stamp,
        "bundledBase": bundled_stamp(dirs),
    })
}

/// Unpacks the bundled archive into the MSYS2 folder, over what is there.
/// `progress` gets a fraction between 0 and 1 now and then.
pub fn unpack(dirs: &Dirs, progress: &dyn Fn(f64)) -> Result<(), String> {
    let _busy = BUSY.lock().unwrap();
    let archive = bundled_archive(dirs).ok_or("This build has no MSYS2 archive.")?;
    let total = std::fs::read_to_string(dirs.vendor.join("msys64.count")).ok().and_then(|t| t.trim().parse::<f64>().ok()).unwrap_or(20_000.0);
    let root = dirs.msys();
    let parent = root.parent().ok_or("bad MSYS2 folder")?.to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(decoder);
    tar.set_overwrite(true);
    tar.set_preserve_permissions(false);
    let mut done = 0f64;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        // Entries are msys64/..., so they land in <local>/msys64.
        let rel = entry.path().map_err(|e| e.to_string())?.into_owned();
        let dest = parent.join(&rel);
        if let Ok(m) = std::fs::symlink_metadata(&dest) {
            if !m.is_dir() {
                let mut perm = m.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(false);
                let _ = std::fs::set_permissions(&dest, perm);
                let _ = std::fs::remove_file(&dest);
            }
        }
        entry.unpack_in(&parent).map_err(|e| format!("{}: {e}", rel.display()))?;
        done += 1.0;
        if (done as u64) % 500 == 0 {
            progress((done / total).min(0.99));
        }
    }
    std::fs::write(root.join(STAMP), bundled_stamp(dirs) + "\n").map_err(|e| e.to_string())?;
    crate::shell::forget_detected();
    progress(1.0);
    Ok(())
}

/// Unpacks MSYS2 when it is missing or damaged. Used by the installer
/// (`byndery --seed-msys`) and before the first zsh starts.
pub fn ensure(dirs: &Dirs, progress: &dyn Fn(f64)) -> Result<bool, String> {
    if bundled_archive(dirs).is_none() {
        return Ok(false);
    }
    let root = dirs.msys();
    if root.join(STAMP).exists() && missing(&root).is_empty() {
        return Ok(false);
    }
    unpack(dirs, progress)?;
    Ok(true)
}

/// Package names in the bundled base, from vendor/msys2-packages.txt.
fn base_packages(dirs: &Dirs) -> std::collections::HashSet<String> {
    std::fs::read_to_string(dirs.vendor.join("msys2-packages.txt"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split('\t').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Packages the user added on top of byndery's base.
pub fn added_packages(dirs: &Dirs) -> Vec<String> {
    let pacman = dirs.msys().join("usr").join("bin").join("pacman.exe");
    if !pacman.exists() {
        return vec![];
    }
    let mut cmd = std::process::Command::new(pacman);
    cmd.arg("-Qqe");
    let Ok(out) = crate::shell::quiet(&mut cmd).output() else { return vec![] };
    let base = base_packages(dirs);
    let mut s = String::new();
    let _ = out.stdout.as_slice().read_to_string(&mut s);
    s.lines().map(|l| l.trim().to_string()).filter(|p| !p.is_empty() && !base.contains(p)).collect()
}

/// A one-line progress bar for the terminal while MSYS2 unpacks.
pub fn bar(fraction: f64) -> String {
    let width = 30usize;
    let filled = ((fraction * width as f64).round() as usize).min(width);
    format!("\r\x1b[2K  Setting up byndery's Linux tools  [{}{}] {:>3.0}%", "#".repeat(filled), " ".repeat(width - filled), fraction * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpack_over_and_keep_added() {
        let tmp = std::env::temp_dir().join(format!("byndery-msys-{}", uuid::Uuid::new_v4()));
        let vendor = tmp.join("vendor");
        std::fs::create_dir_all(&vendor).unwrap();
        // A tiny "MSYS2" archive with a hard link, as git-core has.
        let src = tmp.join("src").join("msys64");
        std::fs::create_dir_all(src.join("usr/bin")).unwrap();
        std::fs::create_dir_all(src.join("etc")).unwrap();
        for f in CRITICAL {
            std::fs::write(src.join(f), f).unwrap();
        }
        std::fs::hard_link(src.join("usr/bin/git.exe"), src.join("usr/bin/git-upload-pack.exe")).unwrap();
        let out = std::fs::File::create(vendor.join("msys64.tar.zst")).unwrap();
        let enc = zstd::stream::write::Encoder::new(out, 3).unwrap().auto_finish();
        let mut b = tar::Builder::new(enc);
        b.append_dir_all("msys64", &src).unwrap();
        b.into_inner().unwrap();
        std::fs::write(vendor.join("msys64.stamp"), "abc").unwrap();
        let dirs = Dirs { data: tmp.join("data"), local: tmp.join("local"), integration: tmp.clone(), vendor, helpers: tmp.clone(), temp: tmp.clone() };
        assert!(ensure(&dirs, &|_| {}).unwrap());
        assert_eq!(status(&dirs)["healthy"], true);
        assert!(!ensure(&dirs, &|_| {}).unwrap());
        // Damage the base and add a user file; repair restores one and keeps the other.
        std::fs::remove_file(dirs.msys().join("usr/bin/zsh.exe")).unwrap();
        std::fs::write(dirs.msys().join("usr/bin/jq.exe"), "user").unwrap();
        assert_eq!(status(&dirs)["healthy"], false);
        assert!(ensure(&dirs, &|_| {}).unwrap());
        assert!(dirs.msys().join("usr/bin/zsh.exe").exists());
        assert!(dirs.msys().join("usr/bin/jq.exe").exists());
        assert_eq!(std::fs::read_to_string(dirs.msys().join("usr/bin/git-upload-pack.exe")).unwrap(), "usr/bin/git.exe");
        let _ = std::fs::remove_dir_all(tmp);
    }
}
