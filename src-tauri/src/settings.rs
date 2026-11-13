//! settings.json: only what the user changed, over defaults kept in code, as
//! in VS Code and Windows Terminal. The file may have // and /* */ comments
//! and trailing commas. When a hand edit cannot be read, the last good
//! settings stay in force and Settings shows the error.
//!
//! The shape matches `src/shared/settings.ts`, which the renderer types.

use crate::paths::{to_msys, Dirs};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

pub const SYSTEMS: [&str; 3] = ["linux", "powershell", "cmd"];

/// The defaults, shared with the renderer (src/shared/default-settings.json).
pub fn defaults() -> Value {
    serde_json::from_str(include_str!("../../src/shared/default-settings.json")).expect("default-settings.json")
}

/// Objects merge key by key; arrays and scalars from `over` replace.
pub fn merge(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut out = b.clone();
            for (k, v) in o {
                let merged = match out.get(k) {
                    Some(existing) => merge(existing, v),
                    None => v.clone(),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        (_, Value::Null) => base.clone(),
        _ => over.clone(),
    }
}

pub fn set_path(obj: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        return;
    }
    if !obj.is_object() {
        *obj = Value::Object(Map::new());
    }
    let mut cur = obj;
    for k in &path[..path.len() - 1] {
        let map = cur.as_object_mut().unwrap();
        if !map.get(k).map(|v| v.is_object()).unwrap_or(false) {
            map.insert(k.clone(), Value::Object(Map::new()));
        }
        cur = map.get_mut(k).unwrap();
    }
    cur.as_object_mut().unwrap().insert(path[path.len() - 1].clone(), value);
}

/// Removes a value and any objects it leaves empty.
pub fn delete_path(obj: &mut Value, path: &[String]) {
    fn go(v: &mut Value, path: &[String]) {
        let Some(map) = v.as_object_mut() else { return };
        if path.len() == 1 {
            map.remove(&path[0]);
            return;
        }
        if let Some(child) = map.get_mut(&path[0]) {
            go(child, &path[1..]);
            if child.as_object().map(|m| m.is_empty()).unwrap_or(false) {
                map.remove(&path[0]);
            }
        }
    }
    if !path.is_empty() {
        go(obj, path);
    }
}

/// Settings files from before profiles.
pub fn migrate(mut raw: Value) -> Value {
    if let Some(map) = raw.as_object_mut() {
        if let Some(Value::Object(c)) = map.get("commands").cloned() {
            if let Some(Value::Bool(linux)) = c.get("linux") {
                let ps = c.get("powershell") != Some(&Value::Bool(false));
                let cmd = c.get("cmd") != Some(&Value::Bool(false));
                map.insert("commands".into(), json!({ "enabled": { "linux": linux, "powershell": ps, "cmd": cmd } }));
            }
        }
        if let Some(Value::Bool(m)) = map.remove("memory") {
            let mut h = map.get("history").cloned().filter(|v| v.is_object()).unwrap_or(json!({}));
            h["enabled"] = Value::Bool(m);
            map.insert("history".into(), h);
        }
    }
    raw
}

/// JSON with comments and trailing commas, as VS Code accepts.
pub fn strip_comments(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while i < c.len() {
        let ch = c[i];
        if in_string {
            out.push(ch);
            if ch == '\\' && i + 1 < c.len() {
                out.push(c[i + 1]);
                i += 1;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else if ch == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            out.push('\n');
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            i += 2;
            while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                if c[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 1;
        } else if ch == ',' && c[i + 1..].iter().find(|x| !x.is_whitespace()).map(|x| *x == '}' || *x == ']').unwrap_or(false) {
            // A trailing comma before } or ].
        } else {
            out.push(ch);
        }
        i += 1;
    }
    out
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// The routing file the byndery zsh reads on every Enter.
pub fn routing_text(commands: &Value) -> String {
    let order: Vec<String> = commands["order"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let on: Vec<&String> = order.iter().filter(|s| commands["enabled"][s.as_str()].as_bool().unwrap_or(true)).collect();
    let mut lines = vec![
        format!("order={}", order.join(" ")),
        format!("on={}", on.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")),
        format!("pssyntax={}", if commands["powershellSyntax"].as_bool().unwrap_or(true) { 1 } else { 0 }),
    ];
    for s in SYSTEMS {
        lines.push(format!("prefix.{}={}", s, str_of(&commands["prefixes"], s)));
    }
    if let Some(o) = commands["overrides"].as_object() {
        let name_ok = |n: &str| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || "_.+-".contains(c));
        for (name, sys) in o {
            if let Some(sys) = sys.as_str() {
                if name_ok(name) && SYSTEMS.contains(&sys) {
                    lines.push(format!("override.{}={}", name.to_lowercase(), sys));
                }
            }
        }
    }
    lines.join("\n") + "\n"
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && !n.starts_with(|c: char| c.is_ascii_digit()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_alias(n: &str) -> bool {
    !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || "_.+-".contains(c))
}

/// Settings → Shell as zsh (`zsh = true`) or bash: plugins, aliases, environment and PATH.
pub fn managed_shell(shell: &Value, zsh: bool) -> String {
    let mut out = vec!["# Written by byndery from Settings > Shell. Edit there; this file is replaced.".to_string()];
    if zsh {
        let names = [
            ("autosuggestions", "autosuggestions"),
            ("syntaxHighlighting", "syntax-highlighting"),
            ("completions", "completions"),
            ("historySubstringSearch", "history-substring-search"),
            ("gitAliases", "git-aliases"),
        ];
        let off: Vec<&str> = names.iter().filter(|(k, _)| shell["plugins"][*k].as_bool() == Some(false)).map(|(_, n)| *n).collect();
        out.push(format!("typeset -g BYNDERY_PLUGINS_OFF={}", sh_quote(&off.join(" "))));
        out.push(format!("typeset -g BYNDERY_OFFER_INSTALL={}", if shell["offerInstall"].as_bool() == Some(false) { 0 } else { 1 }));
    }
    if let Some(env) = shell["env"].as_object() {
        for (k, v) in env {
            if let (true, Some(v)) = (valid_name(k), v.as_str()) {
                let v = if cfg!(windows) && crate::paths::is_windows_path(v) { to_msys(v) } else { v.to_string() };
                out.push(format!("export {}={}", k, sh_quote(&v)));
            }
        }
    }
    if let Some(paths) = shell["path"].as_array() {
        for p in paths.iter().filter_map(|p| p.as_str()).filter(|p| !p.trim().is_empty()) {
            let p = if cfg!(windows) { to_msys(p.trim()) } else { p.trim().to_string() };
            // Idempotent: the file is read twice per zsh start.
            out.push(format!("case \":$PATH:\" in *:{q}:*) ;; *) export PATH=\"$PATH:\"{q} ;; esac", q = sh_quote(&p)));
        }
    }
    if let Some(aliases) = shell["aliases"].as_object() {
        for (k, v) in aliases {
            if let (true, Some(v)) = (valid_alias(k), v.as_str()) {
                out.push(format!("alias {}={}", k, sh_quote(v)));
            }
        }
    }
    out.join("\n") + "\n"
}

struct Inner {
    user: Value,
    effective: Value,
    error: Option<String>,
    last_text: String,
}

pub struct Store {
    inner: Mutex<Inner>,
    pub dirs: Dirs,
}

impl Store {
    pub fn new(dirs: Dirs) -> Store {
        let d = defaults();
        Store { inner: Mutex::new(Inner { user: json!({}), effective: d, error: None, last_text: String::new() }), dirs }
    }

    pub fn file(&self) -> std::path::PathBuf {
        self.dirs.data.join("settings.json")
    }

    pub fn get(&self) -> Value {
        self.inner.lock().unwrap().effective.clone()
    }

    pub fn user(&self) -> Value {
        self.inner.lock().unwrap().user.clone()
    }

    pub fn error(&self) -> Option<String> {
        self.inner.lock().unwrap().error.clone()
    }

    /// Reads settings.json; returns true when it changed.
    pub fn read(&self) -> bool {
        let text = std::fs::read_to_string(self.file()).unwrap_or_default();
        let mut g = self.inner.lock().unwrap();
        if text == g.last_text && !g.last_text.is_empty() {
            return false;
        }
        g.last_text = text.clone();
        if text.trim().is_empty() {
            g.user = json!({});
            g.error = None;
        } else {
            match serde_json::from_str::<Value>(&strip_comments(&text)) {
                Ok(v) if v.is_object() => {
                    g.user = migrate(v);
                    g.error = None;
                }
                Ok(_) => g.error = Some("settings.json could not be read: the file must hold one { } object".into()),
                Err(e) => g.error = Some(format!("settings.json could not be read: {e}")),
            }
        }
        let user = g.user.clone();
        g.effective = effective_of(&user);
        drop(g);
        self.write_shell_files();
        true
    }

    pub fn set(&self, path: &[String], value: Value) {
        let mut g = self.inner.lock().unwrap();
        set_path(&mut g.user, path, value);
        self.save(g);
    }

    pub fn reset(&self, path: &[String]) {
        let mut g = self.inner.lock().unwrap();
        delete_path(&mut g.user, path);
        self.save(g);
    }

    fn save(&self, mut g: std::sync::MutexGuard<Inner>) {
        let user = g.user.clone();
        g.effective = effective_of(&user);
        g.error = None;
        g.last_text = serde_json::to_string_pretty(&user).unwrap_or_default() + "\n";
        let text = g.last_text.clone();
        drop(g);
        let _ = std::fs::create_dir_all(&self.dirs.data);
        let _ = std::fs::write(self.file(), text);
        self.write_shell_files();
    }

    /// The routing file and Settings → Shell, which open shells read.
    fn write_shell_files(&self) {
        let s = self.get();
        let _ = std::fs::create_dir_all(self.dirs.data.join("shell"));
        let _ = std::fs::write(self.dirs.routing_file(), routing_text(&s["commands"]));
        let _ = std::fs::write(self.dirs.managed_zsh(), managed_shell(&s["shell"], true));
        let _ = std::fs::write(self.dirs.managed_sh(), managed_shell(&s["shell"], false));
    }
}

fn effective_of(user: &Value) -> Value {
    let mut s = merge(&defaults(), user);
    // Every system appears once in the order, whatever the file says.
    let mut order: Vec<String> = Vec::new();
    if let Some(a) = s["commands"]["order"].as_array() {
        for x in a.iter().filter_map(|x| x.as_str()) {
            if SYSTEMS.contains(&x) && !order.iter().any(|o| o == x) {
                order.push(x.to_string());
            }
        }
    }
    for x in SYSTEMS {
        if !order.iter().any(|o| o == x) {
            order.push(x.to_string());
        }
    }
    s["commands"]["order"] = json!(order);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_and_paths() {
        let d = defaults();
        let u = json!({ "general": { "theme": "dark" }, "commands": { "order": ["cmd"] } });
        let e = effective_of(&u);
        assert_eq!(e["general"]["theme"], "dark");
        assert_eq!(e["general"]["confirmClose"], true);
        assert_eq!(e["commands"]["order"], json!(["cmd", "linux", "powershell"]));
        let mut x = json!({});
        set_path(&mut x, &["a".into(), "b".into()], json!(1));
        assert_eq!(x, json!({ "a": { "b": 1 } }));
        delete_path(&mut x, &["a".into(), "b".into()]);
        assert_eq!(x, json!({}));
        assert!(d["shell"]["plugins"]["autosuggestions"].as_bool().unwrap());
    }

    #[test]
    fn comments() {
        let t = "{ // c\n \"a\": \"//x\", /* y */ \"b\": [1,2,], }";
        let v: Value = serde_json::from_str(&strip_comments(t)).unwrap();
        assert_eq!(v, json!({ "a": "//x", "b": [1, 2] }));
    }

    #[test]
    fn routing() {
        let r = routing_text(&defaults()["commands"]);
        assert!(r.contains("order=linux powershell cmd\n"));
        assert!(r.contains("override.dir=cmd\n"));
        assert!(r.contains("prefix.powershell=pwsh:\n"));
    }

    #[test]
    fn managed() {
        let s = json!({ "plugins": { "autosuggestions": false }, "aliases": { "gs": "git status", "bad name": "x" },
                        "env": { "EDITOR": "vim", "1X": "no" }, "path": ["/opt/bin"], "offerInstall": false });
        let z = managed_shell(&s, true);
        assert!(z.contains("BYNDERY_PLUGINS_OFF='autosuggestions'"));
        assert!(z.contains("alias gs='git status'"));
        assert!(!z.contains("bad name"));
        assert!(z.contains("export EDITOR='vim'"));
        assert!(!z.contains("1X"));
        assert!(z.contains("BYNDERY_OFFER_INSTALL=0"));
        let b = managed_shell(&s, false);
        assert!(!b.contains("PLUGINS_OFF"));
    }
}
