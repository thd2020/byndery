//! Every command with its output, folder, exit code and timing, in SQLite.
//! Search uses an FTS5 index with the trigram tokenizer, so any substring of
//! three characters or more matches, in any script. Records arrive already
//! redacted and capped by the renderer (src/shared/history.ts). The schema is
//! the one 0.0.1 used, so its history.db opens as it is.

use rusqlite::{params, params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_ROWS: i64 = 100_000;
const OUTPUT_BUDGET: i64 = 512 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    command: String,
    cwd: String,
    exit: Option<i64>,
    started_at: f64,
    duration_ms: f64,
    output: String,
    truncated: bool,
    shell: String,
    session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    text: String,
    scope: String,
    cwd: Option<String>,
    session: Option<String>,
    root: Option<String>,
    failed_only: Option<bool>,
    limit: Option<i64>,
}

pub struct History {
    path: PathBuf,
    db: Mutex<Option<Connection>>,
    since_check: Mutex<u32>,
    host: String,
}

const SCHEMA: &str = "
    pragma journal_mode = wal;
    pragma synchronous = normal;
    create table if not exists history (
      id integer primary key,
      uuid text not null unique,
      started_at integer not null,
      duration_ms integer not null default 0,
      exit integer,
      command text not null,
      cwd text not null default '',
      session text not null default '',
      host text not null default '',
      shell text not null default '',
      output text not null default '',
      output_truncated integer not null default 0,
      deleted_at integer
    );
    create index if not exists history_started on history(started_at);
    create index if not exists history_cwd on history(cwd);
    create virtual table if not exists history_fts using fts5(
      command, output, content='history', content_rowid='id', tokenize='trigram'
    );
    create trigger if not exists history_ai after insert on history begin
      insert into history_fts(rowid, command, output) values (new.id, new.command, new.output);
    end;
    create trigger if not exists history_ad after delete on history begin
      insert into history_fts(history_fts, rowid, command, output) values ('delete', old.id, old.command, old.output);
    end;
";

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl History {
    pub fn new(path: PathBuf) -> History {
        History { path, db: Mutex::new(None), since_check: Mutex::new(0), host: gethostname::gethostname().to_string_lossy().into_owned() }
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut g = self.db.lock().unwrap();
        if g.is_none() {
            let fresh = !self.path.exists();
            let conn = Connection::open(&self.path).map_err(|e| e.to_string())?;
            conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
            if fresh {
                import_shell_history(&conn, &self.host);
            }
            *g = Some(conn);
        }
        f(g.as_ref().unwrap()).map_err(|e| e.to_string())
    }

    pub fn record(&self, r: Record) -> Result<(), String> {
        let host = self.host.clone();
        self.with(|d| {
            d.execute(
                "insert into history (uuid, started_at, duration_ms, exit, command, cwd, session, host, shell, output, output_truncated)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![uuid(), r.started_at as i64, r.duration_ms.max(0.0).round() as i64, r.exit, r.command.trim(), r.cwd, r.session, host, r.shell, r.output, r.truncated as i64],
            )
            .map(|_| ())
        })?;
        let mut n = self.since_check.lock().unwrap();
        *n += 1;
        if *n < 200 {
            return Ok(());
        }
        *n = 0;
        self.with(|d| {
            let rows: i64 = d.query_row("select count(*) from history", [], |r| r.get(0))?;
            if rows > MAX_ROWS {
                d.execute("delete from history where id in (select id from history order by started_at limit ?1)", [rows - MAX_ROWS])?;
            }
            let mut total: i64 = d.query_row("select coalesce(sum(length(output)), 0) from history", [], |r| r.get(0))?;
            if total > OUTPUT_BUDGET {
                let mut st = d.prepare("select id, length(output) from history where output != '' order by started_at")?;
                let old: Vec<(i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.flatten().collect();
                for (id, len) in old {
                    if total <= OUTPUT_BUDGET * 9 / 10 {
                        break;
                    }
                    d.execute("update history set output = '', output_truncated = 1 where id = ?1", [id])?;
                    total -= len;
                }
            }
            Ok(())
        })
    }

    pub fn search(&self, q: Query) -> Result<Vec<Value>, String> {
        let escape = |s: &str| s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let text = q.text.trim().to_string();
        let mut wh = vec!["h.deleted_at is null".to_string()];
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let mut from = "history h";
        if text.chars().count() >= 3 {
            from = "history_fts f join history h on h.id = f.rowid";
            wh.push("history_fts match ?".into());
            args.push(format!("\"{}\"", text.replace('"', "\"\"")).into());
        } else if !text.is_empty() {
            wh.push("h.command like ? escape '\\'".into());
            args.push(format!("%{}%", escape(&text)).into());
        }
        match (q.scope.as_str(), &q.root, &q.cwd, &q.session) {
            ("workspace", Some(root), _, _) if !root.is_empty() => {
                wh.push("(h.cwd = ? or h.cwd like ? escape '\\')".into());
                args.push(root.clone().into());
                args.push(format!("{}/%", escape(root)).into());
            }
            ("folder", _, Some(cwd), _) if !cwd.is_empty() => {
                wh.push("h.cwd = ?".into());
                args.push(cwd.clone().into());
            }
            ("session", _, _, Some(s)) if !s.is_empty() => {
                wh.push("h.session = ?".into());
                args.push(s.clone().into());
            }
            _ => {}
        }
        if q.failed_only.unwrap_or(false) {
            wh.push("h.exit is not null and h.exit != 0".into());
        }
        args.push(q.limit.unwrap_or(200).into());
        let sql = format!(
            "select h.id, h.command, h.cwd, h.exit, h.started_at, h.duration_ms, h.session, h.host,
                    substr(h.output, 1, 300), length(h.output)
             from {from} where {} order by h.started_at desc limit ?",
            wh.join(" and ")
        );
        let rows: Vec<(i64, String, String, Option<i64>, i64, i64, String, String, String, i64)> = self.with(|d| {
            let mut st = d.prepare(&sql)?;
            let it = st.query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
            })?;
            Ok(it.flatten().collect())
        })?;
        // The same command run many times shows once, at its latest run, as Atuin does.
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (id, command, cwd, exit, started, dur, session, host, head, bytes) in rows {
            let key = if text.is_empty() { command.clone() } else { id.to_string() };
            if !seen.insert(key) {
                continue;
            }
            let preview = head.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
            out.push(json!({
                "id": id, "command": command, "cwd": cwd, "exit": exit, "startedAt": started, "durationMs": dur,
                "session": session, "host": host, "preview": preview, "outputBytes": bytes
            }));
        }
        Ok(out)
    }

    pub fn output(&self, id: i64) -> Result<Value, String> {
        self.with(|d| {
            let r = d.query_row("select output, output_truncated from history where id = ?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)));
            Ok(match r {
                Ok((text, t)) => json!({ "text": text, "truncated": t != 0 }),
                Err(_) => Value::Null,
            })
        })
    }

    pub fn remove(&self, id: i64) -> Result<(), String> {
        self.with(|d| d.execute("delete from history where id = ?1", [id]).map(|_| ()))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with(|d| d.execute_batch("delete from history; vacuum;"))
    }
}

/// Commands typed with a leading space, and empty ones, are not kept.
fn should_remember(c: &str) -> bool {
    !c.trim().is_empty() && !c.starts_with(char::is_whitespace)
}

/// Extended zsh history: ": 1731130000:0;command", with backslash-newline continuations.
pub fn parse_zsh_history(text: &str) -> Vec<(i64, i64, String)> {
    let text = text.replace("\\\n", "\n");
    let mut rows: Vec<(i64, i64, String)> = Vec::new();
    for line in text.split('\n') {
        let parsed = line.strip_prefix(": ").and_then(|rest| {
            let (ts, rest) = rest.split_once(':')?;
            let (dur, cmd) = rest.split_once(';')?;
            Some((ts.parse::<i64>().ok()? * 1000, dur.parse::<i64>().ok()? * 1000, cmd.to_string()))
        });
        match parsed {
            Some(r) => rows.push(r),
            // A continuation line of the previous command.
            None => {
                if let Some(last) = rows.last_mut() {
                    last.2.push('\n');
                    last.2.push_str(line);
                }
            }
        }
    }
    for r in rows.iter_mut() {
        r.2 = r.2.trim_end_matches('\n').to_string();
    }
    if rows.is_empty() {
        return text.lines().filter(|l| !l.trim().is_empty()).map(|l| (0, 0, l.to_string())).collect();
    }
    rows
}

/// On first run, earlier commands come in from ~/.zsh_history and ~/.bash_history, without output.
fn import_shell_history(d: &Connection, host: &str) {
    let home = dirs::home_dir().unwrap_or_default();
    let histfile = std::env::var("HISTFILE").ok().map(|h| {
        let b = h.as_bytes();
        if b.len() > 2 && b[0] == b'/' && b[2] == b'/' && b[1].is_ascii_alphabetic() {
            format!("{}:{}", (b[1] as char).to_ascii_uppercase(), &h[2..])
        } else {
            h
        }
    });
    let mut rows: Vec<(i64, i64, String)> = Vec::new();
    let zsh = histfile.clone().map(PathBuf::from).unwrap_or_else(|| home.join(".zsh_history"));
    if let Ok(bytes) = std::fs::read(&zsh) {
        rows.extend(parse_zsh_history(&String::from_utf8_lossy(&bytes)));
    }
    if histfile.is_none() {
        if let Ok(text) = std::fs::read_to_string(home.join(".bash_history")) {
            let mut at = 0i64;
            for line in text.lines() {
                if let Some(ts) = line.strip_prefix('#').filter(|t| t.len() >= 9 && t.chars().all(|c| c.is_ascii_digit())) {
                    at = ts.parse::<i64>().unwrap_or(0) * 1000;
                } else if !line.trim().is_empty() {
                    rows.push((at, 0, line.to_string()));
                }
            }
        }
    }
    if rows.is_empty() {
        return;
    }
    let _ = d.execute_batch("begin");
    for (i, (at, dur, cmd)) in rows.iter().enumerate() {
        if !should_remember(cmd) {
            continue;
        }
        // Commands imported from files have not been through the renderer's redaction.
        let cmd = crate::redact::redact(cmd.trim());
        let at = if *at == 0 { i as i64 } else { *at };
        let _ = d.execute(
            "insert into history (uuid, started_at, duration_ms, exit, command, cwd, session, host, shell, output, output_truncated)
             values (?1, ?2, ?3, null, ?4, '', 'imported', ?5, '', '', 0)",
            params![uuid(), at, dur, cmd, host],
        );
    }
    let _ = d.execute_batch("commit");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zsh_extended() {
        let rows = parse_zsh_history(": 100:2;ls -la\n: 200:0;echo a\\\nb\n: 300:0;pwd\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], (100_000, 2000, "ls -la".to_string()));
        assert_eq!(rows[1].2, "echo a\nb");
        let plain = parse_zsh_history("ls\npwd\n");
        assert_eq!(plain.len(), 2);
    }

    #[test]
    fn fts_trigram_search() {
        let dir = std::env::temp_dir().join(format!("byndery-hist-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let h = History { path: dir.join("h.db"), db: Mutex::new(None), since_check: Mutex::new(0), host: "t".into() };
        // A fresh database imports shell history; start from an existing file instead.
        Connection::open(&h.path).unwrap().execute_batch(SCHEMA).unwrap();
        let rec = |c: &str, o: &str, at: f64| Record {
            command: c.into(), cwd: "C:/w".into(), exit: Some(0), started_at: at, duration_ms: 5.0,
            output: o.into(), truncated: false, shell: "zsh".into(), session: "s".into(),
        };
        h.record(rec("Get-Date", "2026年十一月13日", 1.0)).unwrap();
        h.record(rec("ls", "a.txt", 2.0)).unwrap();
        let q = |t: &str| Query { text: t.into(), scope: "all".into(), cwd: None, session: None, root: None, failed_only: None, limit: None };
        let found = h.search(q("十一月")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["command"], "Get-Date");
        assert_eq!(h.search(q("")).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
