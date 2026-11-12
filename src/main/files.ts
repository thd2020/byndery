import { promises as fsp, watch as fsWatch, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import type { WebContents } from 'electron'
import type { DirEntry, FileChange, ReadResult } from '../shared/api'
import { normalize, join } from '../shared/paths'

const MAX_TEXT = 8 * 1024 * 1024
const FIND_CAP = 50_000
// Version-control internals are never useful in the tree; VS Code hides the same set.
const HIDDEN = new Set(['.git', '.hg', '.svn', 'CVS', '.DS_Store', 'Thumbs.db'])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'dist', 'out', 'build', 'target'])

export async function list(dir: string): Promise<DirEntry[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue
    const path = join(dir, e.name)
    let isDir = e.isDirectory()
    const link = e.isSymbolicLink()
    if (link) {
      try {
        isDir = (await fsp.stat(path)).isDirectory()
      } catch {
        // Dangling link: show it as a file.
      }
    }
    out.push({ name: e.name, path, dir: isDir, symlink: link })
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  out.sort((a, b) => (a.dir === b.dir ? coll.compare(a.name, b.name) : a.dir ? -1 : 1))
  return out
}

export async function read(path: string): Promise<ReadResult> {
  let st
  try {
    st = await fsp.stat(path)
  } catch {
    return { text: null, reason: 'missing', size: 0, mtime: 0 }
  }
  if (st.size > MAX_TEXT) return { text: null, reason: 'too-large', size: st.size, mtime: st.mtimeMs }
  const buf = await fsp.readFile(path)
  // A NUL byte in the first 8 KB is how git decides a file is binary, too.
  if (buf.subarray(0, 8192).includes(0)) return { text: null, reason: 'binary', size: st.size, mtime: st.mtimeMs }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { text, size: st.size, mtime: st.mtimeMs }
}

export async function write(path: string, text: string): Promise<number> {
  await fsp.writeFile(path, text, 'utf8')
  return (await fsp.stat(path)).mtimeMs
}

export async function stat(path: string): Promise<{ dir: boolean; size: number; mtime: number } | null> {
  try {
    const st = await fsp.stat(path)
    return { dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

export async function create(path: string, dir: boolean): Promise<void> {
  if (dir) await fsp.mkdir(path, { recursive: true })
  else await fsp.writeFile(path, '', { flag: 'wx' })
}

export async function rename(from: string, to: string): Promise<void> {
  await fsp.rename(from, to)
}

/** Every file under root, relative. Uses git's own list when root is a repository, so ignores are honoured. */
export function find(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve(stdout.split('\0').filter(Boolean).slice(0, FIND_CAP))
        walk(root).then(resolve, () => resolve([]))
      }
    )
  })
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue = ['']
  while (queue.length && out.length < FIND_CAP) {
    const rel = queue.shift()!
    let entries
    try {
      entries = await fsp.readdir(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(r)
      } else out.push(r)
    }
  }
  return out
}

// One recursive watcher per window. Windows and macOS watch recursively in the
// kernel; Node emulates it on Linux. Events are coalesced for 60 ms because an
// agent writing a file produces several in a row.
const watchers = new Map<number, FSWatcher>()

export function watch(owner: WebContents, root: string): void {
  watchers.get(owner.id)?.close()
  const base = normalize(root)
  const pending = new Map<string, FileChange>()
  let timer: NodeJS.Timeout | null = null
  let w: FSWatcher
  try {
    w = fsWatch(base, { recursive: true }, (event, name) => {
      if (!name) return
      const rel = name.toString().replace(/\\/g, '/')
      // Inside .git only the files that change what `git status` reports matter.
      if (rel.startsWith('.git/') && !/^\.git\/(index|HEAD|refs\/)/.test(rel)) return
      if (/(^|\/)node_modules\//.test(rel)) return
      const path = join(base, rel)
      pending.set(path, { kind: event === 'rename' ? 'rename' : 'change', path })
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          if (owner.isDestroyed()) return
          owner.send('fs:change', [...pending.values()])
          pending.clear()
        }, 60)
      }
    })
  } catch {
    return
  }
  w.on('error', () => w.close())
  watchers.set(owner.id, w)
  owner.once('destroyed', () => {
    w.close()
    watchers.delete(owner.id)
  })
}

/** Drive roots on Windows (C:/, D:/), or "/" elsewhere. */
export async function drives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(letters.map((l) => fsp.access(l + ':/').then(() => l + ':/', () => null)))
  return found.filter((d): d is string => d !== null)
}
