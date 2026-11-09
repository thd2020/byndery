import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { app } from 'electron'
import { hostname, homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CommandRecord, HistoryEntry, HistoryQuery } from '../shared/history'
import { capOutput, outputAllowed, redact, shouldRemember } from '../shared/history'

// Every command with its output, folder, exit code and timing, in SQLite in
// Electron's userData folder. Search uses an FTS5 index with the trigram
// tokenizer, so any substring of three characters or more matches, in any
// script, including Chinese. Each row has a uuid so a later sync can merge
// histories from several devices.

const MAX_ROWS = 100_000
// Output beyond this total is dropped from the oldest commands first; the
// commands themselves stay.
const OUTPUT_BUDGET = 512 * 1024 * 1024
let sinceBudgetCheck = 0
let db: DatabaseSync | null = null
let insert: StatementSync
const host = hostname()

function open(): DatabaseSync {
  if (db) return db
  const fresh = !existsSync(join(app.getPath('userData'), 'history.db'))
  db = new DatabaseSync(join(app.getPath('userData'), 'history.db'))
  db.exec(`
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
  `)
  insert = db.prepare(`insert into history
    (uuid, started_at, duration_ms, exit, command, cwd, session, host, shell, output, output_truncated)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  if (fresh) importShellHistory(db)
  return db
}

export function record(r: CommandRecord): void {
  if (!shouldRemember(r.command)) return
  const d = open()
  const out = outputAllowed(r.command) ? capOutput(redact(r.output)) : { text: '', capped: false }
  insert.run(
    randomUUID(),
    r.startedAt,
    Math.max(0, Math.round(r.durationMs)),
    r.exit,
    redact(r.command.trim()),
    r.cwd,
    r.session,
    host,
    r.shell,
    out.text,
    r.truncated || out.capped ? 1 : 0
  )
  // Limits are checked every few hundred commands, not on every one.
  if (++sinceBudgetCheck < 200) return
  sinceBudgetCheck = 0
  const n = (d.prepare('select count(*) n from history').get() as { n: number }).n
  if (n > MAX_ROWS) {
    d.prepare('delete from history where id in (select id from history order by started_at limit ?)').run(n - MAX_ROWS)
  }
  let total = (d.prepare('select coalesce(sum(length(output)), 0) t from history').get() as { t: number }).t
  if (total > OUTPUT_BUDGET) {
    const old = d.prepare("select id, length(output) len from history where output != '' order by started_at").all() as {
      id: number
      len: number
    }[]
    const drop = d.prepare("update history set output = '', output_truncated = 1 where id = ?")
    for (const row of old) {
      if (total <= OUTPUT_BUDGET * 0.9) break
      drop.run(row.id)
      total -= row.len
    }
  }
}

export function search(q: HistoryQuery): HistoryEntry[] {
  const d = open()
  const where: string[] = ['h.deleted_at is null']
  const args: (string | number)[] = []
  let from = 'history h'
  const text = q.text.trim()
  if (text.length >= 3) {
    from = 'history_fts f join history h on h.id = f.rowid'
    where.push('history_fts match ?')
    args.push(`"${text.replace(/"/g, '""')}"`)
  } else if (text) {
    where.push("h.command like ? escape '\\'")
    args.push(`%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
  }
  if (q.scope === 'workspace' && q.root) {
    where.push("(h.cwd = ? or h.cwd like ? escape '\\')")
    args.push(q.root, `${q.root.replace(/[\\%_]/g, (c) => '\\' + c)}/%`)
  } else if (q.scope === 'folder' && q.cwd) {
    where.push('h.cwd = ?')
    args.push(q.cwd)
  } else if (q.scope === 'session' && q.session) {
    where.push('h.session = ?')
    args.push(q.session)
  }
  if (q.failedOnly) where.push('h.exit is not null and h.exit != 0')
  args.push(q.limit ?? 200)
  const rows = d
    .prepare(
      `select h.id, h.command, h.cwd, h.exit, h.started_at, h.duration_ms, h.session, h.host,
              substr(h.output, 1, 300) as head, length(h.output) as bytes
       from ${from} where ${where.join(' and ')}
       order by h.started_at desc limit ?`
    )
    .all(...args) as {
    id: number
    command: string
    cwd: string
    exit: number | null
    started_at: number
    duration_ms: number
    session: string
    host: string
    head: string
    bytes: number
  }[]
  // The same command run many times shows once, at its latest run, as Atuin does.
  const seen = new Set<string>()
  const out: HistoryEntry[] = []
  for (const r of rows) {
    const key = text ? `${r.id}` : r.command
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      exit: r.exit,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      session: r.session,
      host: r.host,
      preview: r.head.split('\n').find((l) => l.trim()) ?? '',
      outputBytes: r.bytes
    })
  }
  return out
}

export function output(id: number): { text: string; truncated: boolean } | null {
  const r = open().prepare('select output, output_truncated from history where id = ?').get(id) as
    | { output: string; output_truncated: number }
    | undefined
  return r ? { text: r.output, truncated: !!r.output_truncated } : null
}

export function remove(id: number): void {
  open().prepare('delete from history where id = ?').run(id)
}

export function clear(): void {
  const d = open()
  d.exec('delete from history; vacuum;')
}

// On first run, earlier commands from ~/.zsh_history and ~/.bash_history come
// in without output, the way `atuin import` brings them in.
function importShellHistory(d: DatabaseSync): void {
  const rows: { at: number; cmd: string; dur: number }[] = []
  // $HISTFILE wins when set, as in Atuin; under MSYS it may be written /c/Users/...
  const hist = process.env.HISTFILE?.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`)
  const zsh = hist ?? join(homedir(), '.zsh_history')
  if (existsSync(zsh)) {
    // Extended format: ": 1731130000:0;command", with backslash-newline continuations.
    const text = readFileSync(zsh, 'utf8').replace(/\\\n/g, '\n')
    for (const m of text.matchAll(/^: (\d+):(\d+);([\s\S]*?)(?=\n: \d+:\d+;|\n?$)/gm)) {
      rows.push({ at: Number(m[1]) * 1000, dur: Number(m[2]) * 1000, cmd: m[3] })
    }
    if (!rows.length) for (const line of text.split('\n')) if (line.trim()) rows.push({ at: 0, dur: 0, cmd: line })
  }
  const bash = join(homedir(), '.bash_history')
  if (!hist && existsSync(bash)) {
    let at = 0
    for (const line of readFileSync(bash, 'utf8').split(/\r?\n/)) {
      const ts = /^#(\d{9,})$/.exec(line)
      if (ts) at = Number(ts[1]) * 1000
      else if (line.trim()) rows.push({ at, dur: 0, cmd: line })
    }
  }
  if (!rows.length) return
  d.exec('begin')
  try {
    // Undated lines keep their order, placed before anything recorded with a date.
    rows.forEach((r, i) => {
      if (!shouldRemember(r.cmd)) return
      insert.run(randomUUID(), r.at || i, r.dur, null, redact(r.cmd.trim()), '', 'imported', host, '', '', 0)
    })
    d.exec('commit')
  } catch {
    d.exec('rollback')
  }
}
