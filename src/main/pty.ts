import * as pty from 'node-pty'
import { release } from 'node:os'
import type { WebContents } from 'electron'
import type { ShellSpec } from './shell'
import type { TermInfo } from '../shared/api'

// Output is coalesced for a few milliseconds before crossing IPC, and the pty
// is paused while the renderer has more than HIGH_WATER characters it has not
// yet parsed. This is the watermark scheme the xterm.js flow-control guide
// describes; without it a `cat` of a large file freezes the window.
const BATCH_MS = 5
const HIGH_WATER = 512 * 1024
const LOW_WATER = 64 * 1024

interface Session {
  id: number
  proc: pty.IPty
  owner: WebContents
  pending: string
  timer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
  info: TermInfo
}

const sessions = new Map<number, Session>()
let conptyDllWorks = true
let nextId = 1

export function createTerminal(owner: WebContents, shell: ShellSpec, cwd: string, cols: number, rows: number, profile: { id: string; name: string }): TermInfo {
  const id = nextId++
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...shell.env }
  env.TERM_PROGRAM = 'byndery'
  env.COLORTERM = 'truecolor'
  env.TERM = 'xterm-256color'
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k]

  const proc = spawn(shell, cwd, cols, rows, env)
  const info: TermInfo = { id, shell: shell.name, profile: profile.id, profileName: profile.name, cwd, integrated: shell.integrated, msys: shell.msys }
  const s: Session = { id, proc, owner, pending: '', timer: null, unacked: 0, paused: false, info }
  sessions.set(id, s)

  proc.onData((data) => {
    s.pending += data
    s.unacked += data.length
    if (!s.paused && s.unacked > HIGH_WATER) {
      s.paused = true
      proc.pause()
    }
    if (!s.timer) s.timer = setTimeout(() => flush(s), BATCH_MS)
  })
  proc.onExit(({ exitCode }) => {
    flush(s)
    sessions.delete(id)
    if (!owner.isDestroyed()) owner.send('term:exit', id, exitCode)
  })
  owner.once('destroyed', () => kill(id))
  return info
}

function spawn(shell: ShellSpec, cwd: string, cols: number, rows: number, env: Record<string, string>): pty.IPty {
  const opts: pty.IWindowsPtyForkOptions = { name: 'xterm-256color', cols, rows, cwd, env }
  if (process.platform === 'win32' && conptyDllWorks) {
    // The conpty.dll and OpenConsole.exe bundled with node-pty are newer than
    // the copy in Windows 10, which still has resize and reflow bugs.
    try {
      return pty.spawn(shell.file, shell.args, { ...opts, useConptyDll: true })
    } catch {
      conptyDllWorks = false
    }
  }
  return pty.spawn(shell.file, shell.args, opts)
}

/** The Windows build number xterm.js needs to match ConPTY's reflow behaviour. */
export function windowsBuild(): number | undefined {
  if (process.platform !== 'win32') return undefined
  return Number(release().split('.')[2]) || undefined
}

function flush(s: Session): void {
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  if (!s.pending || s.owner.isDestroyed()) return
  s.owner.send('term:data', s.id, s.pending)
  s.pending = ''
}

export function write(id: number, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function ack(id: number, chars: number): void {
  const s = sessions.get(id)
  if (!s) return
  s.unacked = Math.max(0, s.unacked - chars)
  if (s.paused && s.unacked < LOW_WATER) {
    s.paused = false
    s.proc.resume()
  }
}

export function resize(id: number, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s || cols < 2 || rows < 1) return
  try {
    s.proc.resize(cols, rows)
  } catch {
    // The process may have exited between the renderer's resize and ours.
  }
}

export function kill(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.proc.kill()
  } catch {
    // Already gone.
  }
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id)
}
