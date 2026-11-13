// The wire format between byndery-handoff.exe (src/handoff) and the main
// process. The helper first sends one line of JSON describing the console,
// then both sides send frames: a type byte, a 4-byte little-endian length and
// the payload.
//
//   helper -> byndery: data (console output), exit (int32 exit code)
//   byndery -> helper: data (keyboard input), resize (uint16 cols, uint16 rows), close

export const FRAME = { data: 1, exit: 2, resize: 2, close: 3 } as const

export interface HandoffHeader {
  /** The window title the program was started with: a shortcut's name or the program's path. */
  title: string
  /** The program's file name, such as cmd.exe. */
  program: string
  pid: number
  /** The size the program asked for, or 0. */
  cols: number
  rows: number
  /** Started with SW_HIDE: runs without a tab. */
  hidden: boolean
}

export function parseHeader(line: string): HandoffHeader | null {
  try {
    const h = JSON.parse(line) as Partial<HandoffHeader> & { version?: number }
    if (h.version !== 1) return null
    return {
      title: typeof h.title === 'string' ? h.title : '',
      program: typeof h.program === 'string' ? h.program : '',
      pid: Number(h.pid) || 0,
      cols: Number(h.cols) || 0,
      rows: Number(h.rows) || 0,
      hidden: h.hidden === true
    }
  } catch {
    return null
  }
}

/** The tab label for a handed-over console: the shortcut or program it was started as. */
export function handoffLabel(h: HandoffHeader): string {
  const title = h.title.trim()
  const base = (s: string): string => s.split(/[\\/]/).pop() ?? s
  if (title) return /[\\/]/.test(title) ? base(title) : title
  return h.program || 'Console'
}

export function frame(type: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt8(type, 0)
  head.writeUInt32LE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/** Splits a byte stream back into frames, however the chunks fall. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  private onFrame: (type: number, payload: Buffer) => void

  constructor(onFrame: (type: number, payload: Buffer) => void) {
    this.onFrame = onFrame
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 5) {
      const size = this.buffer.readUInt32LE(1)
      if (this.buffer.length < 5 + size) break
      const type = this.buffer.readUInt8(0)
      const payload = this.buffer.subarray(5, 5 + size)
      this.buffer = this.buffer.subarray(5 + size)
      this.onFrame(type, payload)
    }
  }
}
