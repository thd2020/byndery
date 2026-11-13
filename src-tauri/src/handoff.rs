#![cfg_attr(not(windows), allow(dead_code))]

//! byndery as the default terminal on Windows 11. byndery-handoff.exe
//! (src/handoff) is the COM class Windows hands consoles to; it passes each
//! one here over \\.\pipe\byndery-handoff-<user>. The wire format is in
//! src/shared/handoff.ts: one JSON line, then frames of a type byte, a
//! little-endian u32 length and the payload.

use crate::paths::Dirs;
use serde_json::{json, Value};

pub const FRAME_DATA: u8 = 1;
pub const FRAME_EXIT: u8 = 2;
pub const FRAME_RESIZE: u8 = 2;
pub const FRAME_CLOSE: u8 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub title: String,
    pub program: String,
    pub pid: u64,
    pub cols: u16,
    pub rows: u16,
    pub hidden: bool,
}

pub fn parse_header(line: &str) -> Option<Header> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["version"] != json!(1) {
        return None;
    }
    Some(Header {
        title: v["title"].as_str().unwrap_or("").into(),
        program: v["program"].as_str().unwrap_or("").into(),
        pid: v["pid"].as_u64().unwrap_or(0),
        cols: v["cols"].as_u64().unwrap_or(0) as u16,
        rows: v["rows"].as_u64().unwrap_or(0) as u16,
        hidden: v["hidden"].as_bool().unwrap_or(false),
    })
}

/// The tab label: the shortcut or program the console started as.
pub fn label(h: &Header) -> String {
    let t = h.title.trim();
    if !t.is_empty() {
        return t.rsplit(['\\', '/']).next().unwrap_or(t).to_string();
    }
    if h.program.is_empty() {
        "Console".into()
    } else {
        h.program.clone()
    }
}

pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + payload.len());
    v.push(kind);
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

/// Splits a byte stream back into frames, however the chunks fall.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while self.buf.len() >= 5 {
            let size = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
            if self.buf.len() < 5 + size {
                break;
            }
            let kind = self.buf[0];
            let payload = self.buf[5..5 + size].to_vec();
            self.buf.drain(..5 + size);
            out.push((kind, payload));
        }
        out
    }
}

#[cfg(windows)]
pub mod server {
    use super::*;
    use crate::pty::{Proc, Sessions, Utf8Stream};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tokio::sync::mpsc;

    fn pipe_name() -> String {
        let user = std::env::var("USERNAME").unwrap_or_default();
        format!(r"\\.\pipe\byndery-handoff-{user}")
    }

    struct Handed {
        tx: mpsc::UnboundedSender<Vec<u8>>,
    }

    impl Proc for Handed {
        fn write(&self, data: &[u8]) {
            let _ = self.tx.send(frame(FRAME_DATA, data));
        }
        fn resize(&self, cols: u16, rows: u16) {
            let mut p = cols.to_le_bytes().to_vec();
            p.extend_from_slice(&rows.to_le_bytes());
            let _ = self.tx.send(frame(FRAME_RESIZE, &p));
        }
        fn kill(&self) {
            let _ = self.tx.send(frame(FRAME_CLOSE, &[]));
        }
    }

    /// Listens for consoles; `on_console` gets each one's session id and header.
    pub fn start(sessions: Sessions, on_console: impl Fn(u32, Header) + Send + Sync + Clone + 'static) {
        tauri::async_runtime::spawn(async move {
            loop {
                // Only one byndery process can own the pipe; the others try again later.
                let server = match ServerOptions::new().first_pipe_instance(true).create(pipe_name()) {
                    Ok(s) => s,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        continue;
                    }
                };
                accept_loop(server, sessions.clone(), on_console.clone()).await;
            }
        });
    }

    async fn accept_loop(mut server: NamedPipeServer, sessions: Sessions, on_console: impl Fn(u32, Header) + Send + Sync + Clone + 'static) {
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let conn = server;
            server = match ServerOptions::new().create(pipe_name()) {
                Ok(s) => s,
                Err(_) => return,
            };
            tauri::async_runtime::spawn(serve(conn, sessions.clone(), on_console.clone()));
        }
    }

    async fn serve(pipe: NamedPipeServer, sessions: Sessions, on_console: impl Fn(u32, Header) + Send + Sync + 'static) {
        let (mut rd, mut wr) = tokio::io::split(pipe);
        let mut head = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        let (header, rest) = loop {
            let Ok(n) = rd.read(&mut buf).await else { return };
            if n == 0 {
                return;
            }
            head.extend_from_slice(&buf[..n]);
            if let Some(i) = head.iter().position(|b| *b == b'\n') {
                let Some(h) = parse_header(&String::from_utf8_lossy(&head[..i])) else { return };
                break (h, head[i + 1..].to_vec());
            }
            if head.len() > 64 * 1024 {
                return;
            }
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tauri::async_runtime::spawn(async move {
            while let Some(f) = rx.recv().await {
                if wr.write_all(&f).await.is_err() {
                    break;
                }
            }
        });
        let hidden = header.hidden;
        let id = if hidden {
            None
        } else {
            let label = label(&header);
            let info = json!({
                "shell": if header.program.is_empty() { "console".to_string() } else { header.program.clone() },
                "profile": "", "profileName": label, "cwd": crate::paths::home(), "integrated": false, "title": label
            });
            let cols = if header.cols > 1 { header.cols } else { 120 };
            let rows = if header.rows > 0 { header.rows } else { 30 };
            let (id, slot, _) = sessions.add(None, info, cols, rows);
            slot.fill(Box::new(Handed { tx: tx.clone() }));
            on_console(id, header);
            Some(id)
        };
        let mut reader = FrameReader::default();
        let mut utf8 = Utf8Stream::default();
        let mut code = 1i32;
        let mut pending = rest;
        loop {
            for (kind, payload) in reader.push(&pending) {
                if kind == FRAME_DATA {
                    // A console started hidden runs without a tab; its output goes nowhere.
                    if let Some(id) = id {
                        let text = utf8.push(&payload);
                        let s = sessions.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || s.output(id, &text)).await;
                    }
                } else if kind == FRAME_EXIT && payload.len() >= 4 {
                    code = i32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                }
            }
            let Ok(n) = rd.read(&mut buf).await else { break };
            if n == 0 {
                break;
            }
            pending = buf[..n].to_vec();
        }
        if let Some(id) = id {
            sessions.exited(id, code);
        }
    }
}

// The registration, through byndery-handoff.exe.

fn helper(dirs: &Dirs) -> Option<std::path::PathBuf> {
    let p = dirs.helpers.join("byndery-handoff.exe");
    (cfg!(windows) && p.exists()).then_some(p)
}

fn run_helper(dirs: &Dirs, arg: &str) -> Option<(i32, String)> {
    let h = helper(dirs)?;
    let mut cmd = std::process::Command::new(h);
    cmd.arg(arg);
    let out = crate::shell::quiet(&mut cmd).output().ok()?;
    Some((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

pub fn state(dirs: &Dirs) -> Value {
    let unavailable = json!({ "available": false, "supported": false, "enabled": false, "terminalProxy": false, "error": null });
    let Some((code, out)) = run_helper(dirs, "--status") else { return unavailable };
    match serde_json::from_str::<Value>(&out) {
        Ok(s) if code == 0 => json!({
            "available": true, "supported": s["supported"] == json!(true), "enabled": s["enabled"] == json!(true),
            "terminalProxy": s["terminalProxy"] == json!(true), "error": null
        }),
        _ => json!({ "available": true, "supported": false, "enabled": false, "terminalProxy": false, "error": "Could not read the default terminal setting." }),
    }
}

pub fn set(dirs: &Dirs, enabled: bool) -> Value {
    let res = run_helper(dirs, if enabled { "--enable" } else { "--disable" });
    let mut s = state(dirs);
    if let Some((code, out)) = res {
        if code != 0 {
            s["error"] = json!(if out.is_empty() { "Could not change the default terminal.".to_string() } else { out });
        }
    }
    s
}

/// Keeps the registration pointing at this installation.
pub fn refresh(dirs: &Dirs) {
    let _ = run_helper(dirs, "--refresh");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_any_chunking() {
        let mut stream = frame(FRAME_DATA, "héllo".as_bytes());
        stream.extend(frame(FRAME_EXIT, &(-1073741510i32).to_le_bytes()));
        for size in 1..=stream.len() {
            let mut r = FrameReader::default();
            let mut got = Vec::new();
            for c in stream.chunks(size) {
                got.extend(r.push(c));
            }
            assert_eq!(got.len(), 2);
            assert_eq!(got[0].1, "héllo".as_bytes());
            assert_eq!(i32::from_le_bytes(got[1].1.clone().try_into().unwrap()), -1073741510);
        }
    }

    #[test]
    fn header() {
        let h = parse_header(r#"{"version":1,"title":"C:\\Windows\\System32\\cmd.exe","program":"cmd.exe","pid":42,"cols":120,"rows":30,"hidden":false}"#).unwrap();
        assert_eq!(label(&h), "cmd.exe");
        assert_eq!(label(&Header { title: "Windows PowerShell".into(), ..h.clone() }), "Windows PowerShell");
        assert!(parse_header(r#"{"version":2}"#).is_none());
    }
}
