// byndery as the default terminal on Windows 11.
//
// Windows hands a console program that starts on its own (from Start, Explorer
// or Run) to the class named in HKCU\Console\%%Startup DelegationTerminal.
// byndery-handoff.exe (src/handoff) is that class: COM starts it, it receives
// the console's pipes, and passes them here over a named pipe, one connection
// per console. This module listens on that pipe, turns each connection into a
// terminal session, and changes the registration through the same helper.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { DefaultTerminalState } from '../shared/api'
import { parseHeader, FrameReader, frame, FRAME, type HandoffHeader } from '../shared/handoff'
import type { TermProcess } from './pty'

export type { HandoffHeader }

const pipePath = (): string => `\\\\.\\pipe\\byndery-handoff-${userInfo().username}`

/** A console handed over by Windows, driven through byndery-handoff.exe. */
class HandedConsole implements TermProcess {
  private dataListeners: ((data: string) => void)[] = []
  private exitListeners: ((e: { exitCode: number }) => void)[] = []
  private decoder = new StringDecoder('utf8')
  private exited = false

  constructor(private socket: Socket) {}

  write(data: string): void {
    this.send(FRAME.data, Buffer.from(data, 'utf8'))
  }

  resize(cols: number, rows: number): void {
    const b = Buffer.alloc(4)
    b.writeUInt16LE(Math.max(1, Math.min(0xffff, cols)), 0)
    b.writeUInt16LE(Math.max(1, Math.min(0xffff, rows)), 2)
    this.send(FRAME.resize, b)
  }

  /** Ends the program, as closing its console window would. */
  kill(): void {
    this.send(FRAME.close, Buffer.alloc(0))
    setTimeout(() => this.socket.destroy(), 3000).unref()
  }

  pause(): void {
    this.socket.pause()
  }

  resume(): void {
    this.socket.resume()
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb)
  }

  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitListeners.push(cb)
  }

  output(bytes: Buffer): void {
    const text = this.decoder.write(bytes)
    if (text) for (const cb of this.dataListeners) cb(text)
  }

  exit(exitCode: number): void {
    if (this.exited) return
    this.exited = true
    const rest = this.decoder.end()
    if (rest) for (const cb of this.dataListeners) cb(rest)
    for (const cb of this.exitListeners) cb({ exitCode })
  }

  private send(type: number, payload: Buffer): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(frame(type, payload))
  }
}

function accept(socket: Socket, onConsole: (proc: TermProcess, header: HandoffHeader) => void): void {
  let header: HandoffHeader | null = null
  let handed: HandedConsole | null = null
  let head = Buffer.alloc(0)
  const reader = new FrameReader((type, payload) => {
    if (type === FRAME.data) handed?.output(payload)
    else if (type === FRAME.exit && payload.length >= 4) {
      handed?.exit(payload.readInt32LE(0))
      socket.end()
    }
  })
  socket.on('data', (chunk: Buffer) => {
    if (header) return reader.push(chunk)
    head = Buffer.concat([head, chunk])
    const newline = head.indexOf(10)
    if (newline < 0) {
      if (head.length > 64 * 1024) socket.destroy()
      return
    }
    header = parseHeader(head.subarray(0, newline).toString('utf8'))
    if (!header) return socket.destroy()
    handed = new HandedConsole(socket)
    onConsole(handed, header)
    reader.push(head.subarray(newline + 1))
  })
  socket.on('error', () => socket.destroy())
  // The helper went away without reporting an exit code.
  socket.on('close', () => handed?.exit(1))
}

let server: Server | null = null

/** Listens for consoles from byndery-handoff.exe. Only one byndery process listens; the others retry. */
export function startHandoffServer(onConsole: (proc: TermProcess, header: HandoffHeader) => void): void {
  if (process.platform !== 'win32' || server) return
  const s = createServer((socket) => accept(socket, onConsole))
  s.on('error', (error: NodeJS.ErrnoException) => {
    // Another byndery process has the pipe; take over if it closes.
    if (error.code === 'EADDRINUSE') setTimeout(() => s.listen(pipePath()), 10_000).unref()
  })
  s.listen(pipePath())
  server = s
}

// The registration, through byndery-handoff.exe.

function helperPath(): string | null {
  if (process.platform !== 'win32') return null
  const file = app.isPackaged
    ? join(process.resourcesPath, 'handoff', 'byndery-handoff.exe')
    : join(app.getAppPath(), 'build', 'handoff', 'byndery-handoff.exe')
  return existsSync(file) ? file : null
}

function runHelper(args: string[]): Promise<{ code: number; stdout: string }> {
  const helper = helperPath()
  if (!helper) return Promise.resolve({ code: -1, stdout: '' })
  return new Promise((resolve) => {
    execFile(helper, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      resolve({ code, stdout: String(stdout) })
    })
  })
}

const unavailable: DefaultTerminalState = { available: false, supported: false, enabled: false, terminalProxy: false, error: null }

export async function defaultTerminalState(): Promise<DefaultTerminalState> {
  if (!helperPath()) return { ...unavailable }
  const { code, stdout } = await runHelper(['--status'])
  try {
    if (code !== 0) throw new Error()
    const s = JSON.parse(stdout) as { supported: boolean; enabled: boolean; terminalProxy: boolean }
    return { available: true, supported: !!s.supported, enabled: !!s.enabled, terminalProxy: !!s.terminalProxy, error: null }
  } catch {
    return { ...unavailable, available: true, error: 'Could not read the default terminal setting.' }
  }
}

export async function setDefaultTerminal(enabled: boolean): Promise<DefaultTerminalState> {
  const { code, stdout } = await runHelper([enabled ? '--enable' : '--disable'])
  const state = await defaultTerminalState()
  return code === 0 ? state : { ...state, error: stdout.trim() || 'Could not change the default terminal.' }
}

/** Keeps the registration pointing at this installation, if byndery is the default terminal. */
export function refreshDefaultTerminal(): void {
  if (app.isPackaged) void runHelper(['--refresh'])
}
