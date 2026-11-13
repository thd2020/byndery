//! The file tree's filesystem calls, and one recursive watcher per window.

use crate::paths::{native, normalize, normalize_path};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const MAX_TEXT: u64 = 8 * 1024 * 1024;
const FIND_CAP: usize = 50_000;
const HIDDEN: [&str; 6] = [".git", ".hg", ".svn", "CVS", ".DS_Store", "Thumbs.db"];
const SKIP_DIRS: [&str; 10] = [".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", "dist", "out", "build", "target"];

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    dir: bool,
    symlink: bool,
}

fn join(dir: &str, name: &str) -> String {
    let d = normalize(dir);
    if d.ends_with('/') {
        format!("{d}{name}")
    } else {
        format!("{d}/{name}")
    }
}

fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Natural order, as Intl.Collator with numeric: a2 before a10, case ignored.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n1 = String::new();
                while let Some(c) = x.peek().copied().filter(|c| c.is_ascii_digit()) {
                    n1.push(c);
                    x.next();
                }
                let mut n2 = String::new();
                while let Some(c) = y.peek().copied().filter(|c| c.is_ascii_digit()) {
                    n2.push(c);
                    y.next();
                }
                let (t1, t2) = (n1.trim_start_matches('0'), n2.trim_start_matches('0'));
                let o = t1.len().cmp(&t2.len()).then(t1.cmp(t2));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

pub fn list(dir: &str) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(native(dir)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let ft = e.file_type().map_err(|e| e.to_string())?;
        let link = ft.is_symlink();
        let is_dir = if link { std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false) } else { ft.is_dir() };
        out.push(DirEntry { path: join(dir, &name), name, dir: is_dir, symlink: link });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(out)
}

pub fn read(path: &str) -> Value {
    let p = native(path);
    let Ok(m) = std::fs::metadata(&p) else {
        return json!({ "text": null, "reason": "missing", "size": 0, "mtime": 0 });
    };
    let (size, mtime) = (m.len(), mtime_ms(&m));
    if size > MAX_TEXT {
        return json!({ "text": null, "reason": "too-large", "size": size, "mtime": mtime });
    }
    let Ok(buf) = std::fs::read(&p) else {
        return json!({ "text": null, "reason": "missing", "size": 0, "mtime": 0 });
    };
    // A NUL byte in the first 8 KB is how git decides a file is binary, too.
    if buf[..buf.len().min(8192)].contains(&0) {
        return json!({ "text": null, "reason": "binary", "size": size, "mtime": mtime });
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    json!({ "text": text, "size": size, "mtime": mtime })
}

pub fn write(path: &str, text: &str) -> Result<f64, String> {
    let p = native(path);
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(std::fs::metadata(&p).map(|m| mtime_ms(&m)).unwrap_or(0.0))
}

pub fn stat(path: &str) -> Value {
    match std::fs::metadata(native(path)) {
        Ok(m) => json!({ "dir": m.is_dir(), "size": m.len(), "mtime": mtime_ms(&m) }),
        Err(_) => Value::Null,
    }
}

pub fn create(path: &str, dir: bool) -> Result<(), String> {
    let p = native(path);
    if dir {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(p).map(|_| ()).map_err(|e| e.to_string())
    }
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    std::fs::rename(native(from), native(to)).map_err(|e| e.to_string())
}

pub fn trash(path: &str) -> Result<(), String> {
    trash::delete(native(path)).map_err(|e| e.to_string())
}

/// Every file under root, relative. Uses git's list in a repository, so ignores are honoured.
pub fn find(root: &str) -> Vec<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).current_dir(native(root));
    if let Ok(out) = crate::shell::quiet(&mut cmd).output() {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout).split('\0').filter(|s| !s.is_empty()).take(FIND_CAP).map(String::from).collect();
        }
    }
    let mut out = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([String::new()]);
    while let Some(rel) = queue.pop_front() {
        if out.len() >= FIND_CAP {
            break;
        }
        let dir = if rel.is_empty() { native(root) } else { native(&join(root, &rel)) };
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back(r);
                }
            } else {
                out.push(r);
            }
        }
    }
    out
}

/// Drive roots on Windows (C:/, D:/), or "/" elsewhere.
pub fn drives() -> Vec<String> {
    if !cfg!(windows) {
        return vec!["/".into()];
    }
    (b'A'..=b'Z').map(|l| format!("{}:/", l as char)).filter(|d| Path::new(d).exists()).collect()
}

/// One watcher per window. Events are coalesced for 60 ms because an agent
/// writing a file produces several in a row.
#[derive(Default, Clone)]
pub struct Watchers {
    map: Arc<Mutex<HashMap<String, notify::RecommendedWatcher>>>,
}

impl Watchers {
    pub fn watch(&self, app: &AppHandle, label: &str, root: &str) {
        self.unwatch(label);
        let base = normalize(root);
        let pending: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
        let timer_on = Arc::new(Mutex::new(false));
        let (app2, label2, base2) = (app.clone(), label.to_string(), base.clone());
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            let kind = match ev.kind {
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
                EventKind::Modify(_) => "change",
                _ => return,
            };
            for p in ev.paths {
                let path = normalize_path(&p);
                let rel = path.strip_prefix(&base2).unwrap_or(&path).trim_start_matches('/');
                // Inside .git only what changes `git status` matters.
                if rel.starts_with(".git/") && !(rel == ".git/index" || rel == ".git/HEAD" || rel.starts_with(".git/refs/")) {
                    continue;
                }
                if rel.starts_with("node_modules/") || rel.contains("/node_modules/") {
                    continue;
                }
                pending.lock().unwrap().insert(path.clone(), json!({ "kind": kind, "path": path }));
            }
            let mut on = timer_on.lock().unwrap();
            if !*on && !pending.lock().unwrap().is_empty() {
                *on = true;
                let (pending, timer_on, app, label) = (pending.clone(), timer_on.clone(), app2.clone(), label2.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(60));
                    *timer_on.lock().unwrap() = false;
                    let batch: Vec<Value> = pending.lock().unwrap().drain().map(|(_, v)| v).collect();
                    if !batch.is_empty() {
                        let _ = app.emit_to(label.as_str(), "fs:change", batch);
                    }
                });
            }
        };
        let Ok(mut w) = notify::recommended_watcher(handler) else { return };
        if w.watch(&native(&base), RecursiveMode::Recursive).is_ok() {
            self.map.lock().unwrap().insert(label.to_string(), w);
        }
    }

    pub fn unwatch(&self, label: &str) {
        self.map.lock().unwrap().remove(label);
    }
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering::*;

    #[test]
    fn natural() {
        assert_eq!(natural_cmp("a2", "a10"), Less);
        assert_eq!(natural_cmp("B", "a"), Greater);
        assert_eq!(natural_cmp("file", "File"), Greater);
    }
}
