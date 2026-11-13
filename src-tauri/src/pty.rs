//! Terminal sessions. Output is coalesced for a few milliseconds before it
//! crosses to the renderer, and reading stops while the renderer has more
//! than HIGH_WATER characters it has not parsed (the xterm.js flow-control
//! watermarks). A session's process is a pty child, a console Windows handed
//! over, or nothing yet while byndery sets up MSYS2.

use crate::shell::ShellSpec;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const BATCH: Duration = Duration::from_millis(5);
const HIGH_WATER: usize = 512 * 1024;
const LOW_WATER: usize = 64 * 1024;

/// What a session drives: keystrokes in, size changes, and ending it.
pub trait Proc: Send + Sync {
    fn write(&self, data: &[u8]);
    fn resize(&self, cols: u16, rows: u16);
    fn kill(&self);
}

/// The process behind a session; empty until it starts.
pub struct Slot {
    inner: Mutex<Option<Box<dyn Proc>>>,
    size: Mutex<(u16, u16)>,
}

impl Slot {
    fn new(cols: u16, rows: u16) -> Arc<Slot> {
        Arc::new(Slot { inner: Mutex::new(None), size: Mutex::new((cols, rows)) })
    }
    pub fn fill(&self, p: Box<dyn Proc>) {
        let (c, r) = *self.size.lock().unwrap();
        p.resize(c, r);
        *self.inner.lock().unwrap() = Some(p);
    }
}

struct Session {
    owner: Option<String>,
    slot: Arc<Slot>,
    info: Value,
    pending: String,
    unacked: usize,
    exit_code: Option<i32>,
    closed: bool,
}

#[derive(Clone)]
pub struct Sessions {
    inner: Arc<(Mutex<State>, Condvar)>,
    app: AppHandle,
}

struct State {
    map: HashMap<u32, Session>,
    next: u32,
    dirty: bool,
}

/// Turns bytes into text, keeping a UTF-8 sequence split across reads for the next one.
#[derive(Default)]
pub struct Utf8Stream {
    rest: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.rest.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.rest) {
                Ok(s) => {
                    out.push_str(s);
                    self.rest.clear();
                    break;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.rest[..good]).unwrap());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            self.rest.drain(..good + n);
                        }
                        None => {
                            self.rest.drain(..good);
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

impl Sessions {
    pub fn new(app: AppHandle) -> Sessions {
        let s = Sessions { inner: Arc::new((Mutex::new(State { map: HashMap::new(), next: 1, dirty: false }), Condvar::new())), app };
        let flusher = s.clone();
        std::thread::spawn(move || flusher.flush_loop());
        s
    }

    /// A new session; `owner` is the window that shows it, if any yet.
    pub fn add(&self, owner: Option<String>, mut info: Value, cols: u16, rows: u16) -> (u32, Arc<Slot>, Value) {
        let (lock, _) = &*self.inner;
        let mut st = lock.lock().unwrap();
        let id = st.next;
        st.next += 1;
        info["id"] = Value::from(id);
        let slot = Slot::new(cols, rows);
        st.map.insert(id, Session { owner, slot: slot.clone(), info: info.clone(), pending: String::new(), unacked: 0, exit_code: None, closed: false });
        (id, slot, info)
    }

    /// Output from the process. Blocks the caller while the renderer is behind.
    pub fn output(&self, id: u32, text: &str) {
        if text.is_empty() {
            return;
        }
        let (lock, cv) = &*self.inner;
        let mut st = lock.lock().unwrap();
        loop {
            match st.map.get(&id) {
                Some(s) if !s.closed && s.unacked > HIGH_WATER => st = cv.wait_timeout(st, Duration::from_millis(250)).unwrap().0,
                _ => break,
            }
        }
        if let Some(s) = st.map.get_mut(&id) {
            s.pending.push_str(text);
            s.unacked += text.encode_utf16().count();
            st.dirty = true;
            cv.notify_all();
        }
    }

    pub fn exited(&self, id: u32, code: i32) {
        self.flush_one(id);
        let (lock, cv) = &*self.inner;
        let mut st = lock.lock().unwrap();
        let Some(s) = st.map.get_mut(&id) else { return };
        match s.owner.clone() {
            // Kept until a window attaches, so its tab can show how it ended.
            None => s.exit_code = Some(code),
            Some(label) => {
                st.map.remove(&id);
                drop(st);
                let _ = self.app.emit_to(label.as_str(), "term:exit", (id, code));
            }
        }
        cv.notify_all();
    }

    pub fn ack(&self, id: u32, n: usize) {
        let (lock, cv) = &*self.inner;
        let mut st = lock.lock().unwrap();
        if let Some(s) = st.map.get_mut(&id) {
            s.unacked = s.unacked.saturating_sub(n);
            if s.unacked < LOW_WATER {
                cv.notify_all();
            }
        }
    }

    pub fn write(&self, id: u32, data: &str) {
        if let Some(slot) = self.slot(id) {
            if let Some(p) = slot.inner.lock().unwrap().as_ref() {
                p.write(data.as_bytes());
            }
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if cols < 2 || rows < 1 {
            return;
        }
        if let Some(slot) = self.slot(id) {
            *slot.size.lock().unwrap() = (cols, rows);
            if let Some(p) = slot.inner.lock().unwrap().as_ref() {
                p.resize(cols, rows);
            }
        }
    }

    pub fn kill(&self, id: u32) {
        let (lock, cv) = &*self.inner;
        let slot = {
            let mut st = lock.lock().unwrap();
            let s = st.map.remove(&id);
            cv.notify_all();
            s.map(|s| s.slot)
        };
        if let Some(slot) = slot {
            if let Some(p) = slot.inner.lock().unwrap().as_ref() {
                p.kill();
            }
        }
    }

    /// Every session a window showed, when the window goes away.
    pub fn kill_owned(&self, label: &str) {
        let ids: Vec<u32> = {
            let st = self.inner.0.lock().unwrap();
            st.map.iter().filter(|(_, s)| s.owner.as_deref() == Some(label)).map(|(id, _)| *id).collect()
        };
        for id in ids {
            self.kill(id);
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self.inner.0.lock().unwrap().map.keys().copied().collect();
        for id in ids {
            self.kill(id);
        }
    }

    /// Shows an adopted session in a window: what it printed so far, and its exit if it ended.
    pub fn attach(&self, label: &str, id: u32, cols: u16, rows: u16) -> Option<Value> {
        let info = {
            let mut st = self.inner.0.lock().unwrap();
            let s = st.map.get_mut(&id)?;
            if s.owner.is_some() {
                return None;
            }
            s.owner = Some(label.to_string());
            s.info.clone()
        };
        self.resize(id, cols, rows);
        let me = self.clone();
        std::thread::spawn(move || {
            // After the renderer has registered the id.
            std::thread::sleep(Duration::from_millis(30));
            me.flush_one(id);
            let code = me.inner.0.lock().unwrap().map.get(&id).and_then(|s| s.exit_code);
            if let Some(code) = code {
                me.exited(id, code);
            }
        });
        Some(info)
    }

    fn slot(&self, id: u32) -> Option<Arc<Slot>> {
        self.inner.0.lock().unwrap().map.get(&id).map(|s| s.slot.clone())
    }

    fn flush_one(&self, id: u32) {
        let (label, text) = {
            let mut st = self.inner.0.lock().unwrap();
            let Some(s) = st.map.get_mut(&id) else { return };
            let Some(label) = s.owner.clone() else { return };
            if s.pending.is_empty() {
                return;
            }
            (label, std::mem::take(&mut s.pending))
        };
        let _ = self.app.emit_to(label.as_str(), "term:data", (id, text));
    }

    fn flush_loop(&self) {
        let (lock, cv) = &*self.inner;
        loop {
            {
                let mut st = lock.lock().unwrap();
                while !st.dirty {
                    st = cv.wait(st).unwrap();
                }
                st.dirty = false;
            }
            std::thread::sleep(BATCH);
            let ids: Vec<u32> = lock.lock().unwrap().map.iter().filter(|(_, s)| s.owner.is_some() && !s.pending.is_empty()).map(|(id, _)| *id).collect();
            for id in ids {
                self.flush_one(id);
            }
        }
    }
}

struct PtyProc {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Proc for PtyProc {
    fn write(&self, data: &[u8]) {
        let mut w = self.writer.lock().unwrap();
        let _ = w.write_all(data);
        let _ = w.flush();
    }
    fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    fn kill(&self) {
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// Starts `spec` in a pty and wires it to session `id`.
pub fn spawn(sessions: &Sessions, id: u32, slot: &Arc<Slot>, spec: &ShellSpec, cwd: &str, extra_env: &[(String, String)]) -> Result<(), String> {
    let (cols, rows) = *slot.size.lock().unwrap();
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&spec.file);
    cmd.args(&spec.args);
    let dir = crate::paths::native(cwd);
    if dir.is_dir() {
        cmd.cwd(dir);
    }
    for (k, v) in &spec.env {
        if v.is_empty() {
            cmd.env_remove(k);
        } else {
            cmd.env(k, v);
        }
    }
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.env("TERM_PROGRAM", "byndery");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not start {}: {e}", spec.file))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    slot.fill(Box::new(PtyProc { master: Mutex::new(pair.master), writer: Mutex::new(writer), killer: Mutex::new(killer) }));

    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let out = sessions.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut utf8 = Utf8Stream::default();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.output(id, &utf8.push(&buf[..n])),
            }
        }
        let _ = done_tx.send(());
    });
    let waiter = sessions.clone();
    let slot = slot.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
        // Let the last output through; ConPTY only ends the reader once the pty closes.
        if done_rx.recv_timeout(Duration::from_millis(300)).is_err() {
            *slot.inner.lock().unwrap() = None;
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
        }
        waiter.exited(id, code);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    #[test]
    fn split_utf8() {
        let mut u = Utf8Stream::default();
        let bytes = "héllo 世界".as_bytes();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&u.push(&[*b]));
        }
        assert_eq!(out, "héllo 世界");
        assert_eq!(u.push(&[0xff, b'a']), "\u{FFFD}a");
    }
}
