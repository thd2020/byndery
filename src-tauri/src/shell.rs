//! The shells byndery can start: found on this computer, the way Windows
//! Terminal generates profiles, plus the user's own profiles from settings.

use crate::paths::{is_windows_path, normalize, normalize_path, to_msys, Dirs};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize)]
pub struct MsysMounts {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmp: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ShellSpec {
    /// Short name shown on the tab.
    pub name: String,
    pub file: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// Reports OSC 133 and OSC 7 through byndery's integration scripts.
    pub integrated: bool,
    pub msys: Option<MsysMounts>,
    /// The WSL distribution, for wsl.exe profiles.
    pub wsl: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Detected {
    pub id: String,
    pub name: String,
    pub spec: ShellSpec,
    pub routes: bool,
}

fn tmp_dir() -> Option<String> {
    std::env::var("TEMP").ok().map(|t| normalize(&t))
}

fn exists(p: &Path) -> bool {
    p.exists()
}

/// Hides console windows of helper processes on Windows.
pub fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// The first match of `exe` on PATH.
pub fn on_path(exe: &str) -> Option<String> {
    let tool = if cfg!(windows) { "where.exe" } else { "which" };
    let out = quiet(&mut Command::new(tool)).arg(exe).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).find(|l| !l.is_empty())
}

/// Git for Windows' bash.exe launcher.
pub fn find_git_bash() -> Option<PathBuf> {
    let env = |k: &str| std::env::var(k).ok().map(PathBuf::from);
    let home = dirs::home_dir().unwrap_or_default();
    let mut roots: Vec<PathBuf> = Vec::new();
    for k in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(p) = env(k) {
            roots.push(p.join("Git"));
        }
    }
    if let Some(p) = env("LOCALAPPDATA") {
        roots.push(p.join("Programs").join("Git"));
    }
    roots.push(home.join("scoop").join("apps").join("git").join("current"));
    roots.push(home.join("scoop").join("apps").join("git-with-openssh").join("current"));
    for r in roots {
        let bash = r.join("bin").join("bash.exe");
        if exists(&bash) {
            return Some(bash);
        }
    }
    let git = on_path("git")?;
    let bash = Path::new(&git).parent()?.parent()?.join("bin").join("bash.exe");
    exists(&bash).then_some(bash)
}

/// An MSYS2 tree with zsh: byndery's own first, then a system install.
pub fn find_msys2(dirs: &Dirs) -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [dirs.msys(), PathBuf::from("C:\\msys64"), home.join("scoop").join("apps").join("msys2").join("current")];
    candidates.into_iter().find(|r| exists(&r.join("usr").join("bin").join("zsh.exe")))
}

fn zsh_env(dirs: &Dirs) -> BTreeMap<String, String> {
    let zdot = normalize_path(&dirs.integration.join("zsh"));
    let mut env = BTreeMap::new();
    env.insert("ZDOTDIR".into(), zdot.clone());
    env.insert("BYNDERY_ZDOTDIR".into(), zdot);
    env.insert("BYNDERY_USER_ZDOTDIR".into(), std::env::var("ZDOTDIR").unwrap_or_default());
    env.insert("BYNDERY_ROUTING_FILE".into(), normalize_path(&dirs.routing_file()));
    env.insert("BYNDERY_MANAGED".into(), normalize_path(&dirs.managed_zsh()));
    let plugins = dirs.vendor.join("zsh-plugins");
    if exists(&plugins) {
        env.insert("BYNDERY_ZSH_PLUGINS".into(), normalize_path(&plugins));
    }
    let p10k = dirs.vendor.join("powerlevel10k");
    if exists(&p10k.join("powerlevel10k.zsh-theme")) {
        env.insert("BYNDERY_P10K".into(), normalize_path(&p10k));
        env.insert("GITSTATUS_CACHE_DIR".into(), normalize_path(&dirs.vendor.join("gitstatus")));
        env.insert("GITSTATUS_AUTO_INSTALL".into(), "0".into());
    }
    env
}

/// zsh under MSYS treats C:/x as relative, so paths go in their /c/x form.
fn msys_env(env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.into_iter().map(|(k, v)| if is_windows_path(&v) { (k, to_msys(&v)) } else { (k, v) }).collect()
}

fn msys_zsh(dirs: &Dirs, msys: &Path) -> ShellSpec {
    let mut env = zsh_env(dirs);
    // UCRT64 is the environment MSYS2 recommends; inheriting the Windows PATH
    // keeps node, claude, codex and every other Windows tool on hand.
    env.insert("MSYSTEM".into(), "UCRT64".into());
    env.insert("BYNDERY_TMP".into(), normalize_path(&dirs.temp));
    env.insert("MSYS2_PATH_TYPE".into(), "inherit".into());
    env.insert("CHERE_INVOKING".into(), "1".into());
    ShellSpec {
        name: "zsh".into(),
        file: msys.join("usr").join("bin").join("zsh.exe").to_string_lossy().into(),
        args: vec!["-l".into(), "-i".into()],
        env: msys_env(env),
        integrated: true,
        msys: Some(MsysMounts { root: normalize_path(msys), tmp: tmp_dir() }),
        wsl: None,
    }
}

fn bash_spec(dirs: &Dirs, file: &str, msys_root: Option<&Path>) -> ShellSpec {
    let script = dirs.integration.join("bash-integration.sh");
    let script = if msys_root.is_some() { normalize_path(&script) } else { script.to_string_lossy().into() };
    let mut env = BTreeMap::new();
    env.insert("BYNDERY_MANAGED_SH".into(), if msys_root.is_some() { to_msys(&normalize_path(&dirs.managed_sh())) } else { normalize_path(&dirs.managed_sh()) });
    if msys_root.is_some() {
        env.insert("BYNDERY_SHELL_LOGIN".into(), "1".into());
        env.insert("MSYSTEM".into(), "MINGW64".into());
        env.insert("CHERE_INVOKING".into(), "1".into());
    } else if cfg!(target_os = "macos") {
        env.insert("BYNDERY_SHELL_LOGIN".into(), "1".into());
    }
    ShellSpec {
        name: "bash".into(),
        file: file.into(),
        // --init-file only applies to a non-login shell; the script replays the login files itself.
        args: vec!["--init-file".into(), script, "-i".into()],
        env,
        integrated: true,
        msys: msys_root.map(|r| MsysMounts { root: normalize_path(r), tmp: tmp_dir() }),
        wsl: None,
    }
}

/// PowerShell with byndery's prompt hooks (OSC 133, 633;E and OSC 7).
fn pwsh_spec(dirs: &Dirs, name: &str, file: &str) -> ShellSpec {
    let script = dirs.integration.join("pwsh-integration.ps1");
    let (args, integrated) = if exists(&script) {
        let quoted = script.to_string_lossy().replace('\'', "''");
        (vec!["-NoLogo".into(), "-NoExit".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-Command".into(), format!(". '{quoted}'")], true)
    } else {
        (vec!["-NoLogo".into()], false)
    };
    ShellSpec { name: name.into(), file: file.into(), args, env: BTreeMap::new(), integrated, msys: None, wsl: None }
}

/// WSL distributions, from `wsl.exe -l -q` (which prints UTF-16).
fn wsl_distros() -> Vec<String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-l", "-q"]);
    let Ok(out) = quiet(&mut cmd).output() else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    parse_wsl_list(&out.stdout)
}

pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len() >= 2 && bytes.len() % 2 == 0 && bytes.iter().skip(1).step_by(2).all(|b| *b == 0) {
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

static DETECTED: OnceLock<std::sync::Mutex<Option<Vec<Detected>>>> = OnceLock::new();

/// Forgets the shells found so far, after MSYS2 was set up or repaired.
pub fn forget_detected() {
    if let Some(m) = DETECTED.get() {
        *m.lock().unwrap() = None;
    }
}

/// Shells on this computer, best first.
pub fn detect(dirs: &Dirs) -> Vec<Detected> {
    let cell = DETECTED.get_or_init(|| std::sync::Mutex::new(None));
    if let Some(d) = cell.lock().unwrap().as_ref() {
        return d.clone();
    }
    let mut out: Vec<Detected> = Vec::new();
    if cfg!(windows) {
        // byndery's own MSYS2 counts even before it is unpacked: starting zsh sets it up.
        let msys = find_msys2(dirs).or_else(|| crate::msys::bundled_archive(dirs).map(|_| dirs.msys()));
        if let Some(m) = msys {
            out.push(Detected { id: "zsh".into(), name: "zsh".into(), spec: msys_zsh(dirs, &m), routes: true });
        }
        if let Some(bash) = find_git_bash() {
            let root = bash.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf());
            out.push(Detected { id: "git-bash".into(), name: "Git Bash".into(), spec: bash_spec(dirs, &bash.to_string_lossy(), root.as_deref()), routes: false });
        }
        if let Some(pwsh) = on_path("pwsh.exe") {
            out.push(Detected { id: "pwsh".into(), name: "PowerShell".into(), spec: pwsh_spec(dirs, "pwsh", &pwsh), routes: false });
        }
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let ps = Path::new(&root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        out.push(Detected { id: "powershell".into(), name: "Windows PowerShell".into(), spec: pwsh_spec(dirs, "powershell", &ps.to_string_lossy()), routes: false });
        let cmd = Path::new(&root).join("System32").join("cmd.exe");
        for distro in wsl_distros() {
            out.push(Detected {
                id: format!("wsl-{}", distro.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-")),
                name: format!("{distro} (WSL)"),
                // wsl.exe starts in the Windows folder it is given, as /mnt/c/...
                spec: ShellSpec { name: "wsl".into(), file: "wsl.exe".into(), args: vec!["-d".into(), distro.clone()], env: BTreeMap::new(), integrated: false, msys: None, wsl: Some(distro) },
                routes: false,
            });
        }
        out.push(Detected {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            spec: ShellSpec { name: "cmd".into(), file: cmd.to_string_lossy().into(), args: vec![], env: BTreeMap::new(), integrated: false, msys: None, wsl: None },
            routes: false,
        });
    } else {
        let login = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut seen: Vec<String> = Vec::new();
        for file in [login.as_str(), "/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/fish", "/usr/bin/fish"] {
            if !exists(Path::new(file)) {
                continue;
            }
            let base = file.rsplit('/').next().unwrap_or("sh").to_string();
            if seen.contains(&base) {
                continue;
            }
            seen.push(base.clone());
            let spec = match base.as_str() {
                "zsh" => ShellSpec {
                    name: "zsh".into(),
                    file: file.into(),
                    args: if cfg!(target_os = "macos") { vec!["-l".into(), "-i".into()] } else { vec!["-i".into()] },
                    env: zsh_env(dirs),
                    integrated: true,
                    msys: None,
                    wsl: None,
                },
                "bash" => bash_spec(dirs, file, None),
                _ => ShellSpec { name: base.clone(), file: file.into(), args: vec!["-l".into()], env: BTreeMap::new(), integrated: false, msys: None, wsl: None },
            };
            out.push(Detected { id: base.clone(), name: base, spec, routes: false });
        }
    }
    *cell.lock().unwrap() = Some(out.clone());
    out
}

/// Detected shells and the user's profiles, with every field resolved.
pub fn resolve_profiles(dirs: &Dirs, s: &Value) -> Vec<Value> {
    let entries = s["profiles"].as_object().cloned().unwrap_or_default();
    let make = |id: &str, name: &str, detected: bool, routes: bool, fallback: &str| -> Value {
        let mut p = s["profileDefaults"].as_object().cloned().unwrap_or_default();
        let base: Map<String, Value> = json!({
            "name": name, "command": "", "program": "", "args": [], "startIn": "", "env": {},
            "hidden": false, "detected": detected, "routes": routes
        })
        .as_object()
        .cloned()
        .unwrap();
        p.extend(base);
        if let Some(Value::Object(e)) = entries.get(id) {
            for (k, v) in e {
                if !v.is_null() {
                    p.insert(k.clone(), v.clone());
                }
            }
        }
        p.insert("id".into(), json!(id));
        let command = p.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
        p.insert("program".into(), json!(if command.is_empty() { fallback.to_string() } else { command }));
        Value::Object(p)
    };
    let mut list: Vec<Value> = Vec::new();
    for d in detect(dirs) {
        list.push(make(&d.id, &d.name, true, d.routes, &d.spec.file));
    }
    for (id, e) in &entries {
        if !list.iter().any(|p| p["id"] == json!(id)) {
            let name = e.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).unwrap_or(id).to_string();
            list.push(make(id, &name, false, false, ""));
        }
    }
    list
}

/// How to start a profile. A detected profile keeps byndery's integration unless its command changed.
pub fn spec_for(dirs: &Dirs, p: &Value) -> ShellSpec {
    let id = p["id"].as_str().unwrap_or("");
    let command = p["command"].as_str().unwrap_or("");
    let args: Vec<String> = p["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let found = detect(dirs).into_iter().find(|d| d.id == id);
    let mut spec = match (&found, command.is_empty()) {
        (Some(f), true) => {
            let mut s = f.spec.clone();
            if !args.is_empty() {
                s.args = args.clone();
            }
            s
        }
        _ => {
            let file = if !command.is_empty() {
                command.to_string()
            } else if let Some(f) = &found {
                f.spec.file.clone()
            } else if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/sh".into()
            };
            let base = file.replace('\\', "/").rsplit('/').next().unwrap_or("").trim_end_matches(".exe").trim_end_matches(".EXE").to_lowercase();
            let mut s = if base == "zsh" && !cfg!(windows) {
                ShellSpec { name: "zsh".into(), file: file.clone(), args: vec!["-i".into()], env: zsh_env(dirs), integrated: true, msys: None, wsl: None }
            } else if base == "bash" && !cfg!(windows) {
                bash_spec(dirs, &file, None)
            } else if base == "pwsh" || base == "powershell" {
                pwsh_spec(dirs, &base, &file)
            } else {
                ShellSpec { name: base, file, args: vec![], env: BTreeMap::new(), integrated: false, msys: None, wsl: None }
            };
            if !args.is_empty() {
                s.args = args.clone();
            }
            s
        }
    };
    if spec.name == "zsh" {
        if p["promptStyle"] == json!("own") {
            spec.env.insert("BYNDERY_PROMPT".into(), "keep".into());
        } else if let Some(style) = p["promptStyle"].as_str() {
            spec.env.insert("BYNDERY_PROMPT_STYLE".into(), style.into());
        }
    }
    if let Some(env) = p["env"].as_object() {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                let v = if spec.msys.is_some() && is_windows_path(v) { to_msys(v) } else { v.to_string() };
                spec.env.insert(k.clone(), v);
            }
        }
    }
    spec
}

/// Which system the byndery prompt would run a line in, asked of the router itself.
pub fn explain_route(dirs: &Dirs, line: &str) -> Option<(String, String)> {
    let zsh = detect(dirs).into_iter().find(|d| d.routes)?.spec;
    if !Path::new(&zsh.file).exists() {
        return None;
    }
    let script = to_msys(&normalize_path(&dirs.integration.join("zsh").join("windows.zsh")));
    let mut cmd = Command::new(&zsh.file);
    cmd.args(["-f", "-c", "source \"$1\"; __byndery_explain \"$2\"", "zsh", &script, line]);
    cmd.envs(&zsh.env).env("BYNDERY_EXPLAIN", "1").env("MSYS2_ARG_CONV_EXCL", "*");
    let out = quiet(&mut cmd).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut parts = text.splitn(2, '\t');
    let system = parts.next().unwrap_or("").to_string();
    if system.is_empty() {
        return None;
    }
    Some((system, parts.next().unwrap_or("").to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn wsl_list() {
        let utf16: Vec<u8> = "Ubuntu\r\nDebian\r\ndocker-desktop\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(super::parse_wsl_list(&utf16), vec!["Ubuntu", "Debian"]);
        assert!(super::parse_wsl_list(b"").is_empty());
    }
}
