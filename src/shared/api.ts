// The contract between the renderer and the main process. The preload script
// exposes an object of type `Bridge` as `window.byndery`.

import type { MsysMounts } from './paths'
import type { CommandRecord, HistoryEntry, HistoryQuery } from './history'
import type { SettingsState } from './settings'

export interface TermInfo {
  id: number
  shell: string
  /** The profile it was started from. */
  profile: string
  profileName: string
  cwd: string
  integrated: boolean
  msys?: MsysMounts
}

export interface DirEntry {
  name: string
  path: string
  dir: boolean
  symlink: boolean
}

/** One file's state in `git status`: M modified, A added, D deleted, R renamed, U untracked, C conflicted. */
export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

export interface GitState {
  root: string | null
  branch: string | null
  ahead: number
  behind: number
  /** Absolute normalized path to status code. */
  files: Record<string, GitCode>
  /** Ignored paths that are directories or files at the top of an ignored subtree. */
  ignored: string[]
}

export interface FileChange {
  kind: 'change' | 'rename'
  path: string
}

export interface ReadResult {
  text: string | null
  /** Set when the file is binary or too large to open as text. */
  reason?: 'binary' | 'too-large' | 'missing'
  size: number
  mtime: number
}

export interface Bridge {
  platform: NodeJS.Platform
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    setTitleBarColors(bg: string, fg: string): void
    onMaximized(cb: (max: boolean) => void): void
  }
  workspace: {
    initial(): Promise<string>
    pick(): Promise<string | null>
    /** Native Save As dialog; the chosen path, normalized, or null. */
    saveAs(defaultPath: string): Promise<string | null>
  }
  term: {
    /** Starts a terminal from a profile, or the default profile when none is given. */
    create(cwd: string, cols: number, rows: number, profile?: string): Promise<TermInfo>
    write(id: number, data: string): void
    ack(id: number, chars: number): void
    resize(id: number, cols: number, rows: number): void
    kill(id: number): void
    onData(cb: (id: number, data: string) => void): void
    onExit(cb: (id: number, code: number) => void): void
  }
  fs: {
    list(dir: string): Promise<DirEntry[]>
    read(path: string): Promise<ReadResult>
    write(path: string, text: string): Promise<number>
    stat(path: string): Promise<{ dir: boolean; size: number; mtime: number } | null>
    watch(root: string): Promise<void>
    onChange(cb: (changes: FileChange[]) => void): void
    reveal(path: string): void
    openExternal(path: string): void
    /** Drive roots on Windows (C:/, D:/), or "/" elsewhere. */
    drives(): Promise<string[]>
    /** Files under root whose relative path matches, for quick open. Capped and ignore-aware. */
    find(root: string): Promise<string[]>
    rename(from: string, to: string): Promise<void>
    trash(path: string): Promise<void>
    create(path: string, dir: boolean): Promise<void>
    /** Absolute path of a file dropped from the operating system. */
    pathForFile(file: File): string
  }
  git: {
    status(root: string): Promise<GitState>
    show(path: string): Promise<string | null>
  }
  clipboard: {
    write(text: string): void
    read(): Promise<string>
  }
  history: {
    record(r: CommandRecord): void
    search(q: HistoryQuery): Promise<HistoryEntry[]>
    output(id: number): Promise<{ text: string; truncated: boolean } | null>
    remove(id: number): Promise<void>
    clear(): Promise<void>
  }
  settings: {
    get(): Promise<SettingsState>
    /** Sets one value in the user's settings.json, by key path. */
    set(path: string[], value: unknown): Promise<SettingsState>
    /** Removes a value from the user's layer, so the inherited one applies again. */
    reset(path: string[]): Promise<SettingsState>
    onChange(cb: (s: SettingsState) => void): void
    /** Which system the byndery prompt would run a line in, and the rule behind it. */
    explain(line: string): Promise<{ system: string; reason: string } | null>
  }
  menu(items: MenuItem[]): Promise<string | null>
  /** Native message box; resolves to the index of the button pressed. */
  confirm(message: string, detail: string, buttons: string[]): Promise<number>
  devtools(): void
  sys: { windowsBuild?: number; home: string }
}

export interface MenuItem {
  id?: string
  label?: string
  /** Shown beside the label, in Electron accelerator syntax, e.g. "CmdOrCtrl+C". */
  accel?: string
  enabled?: boolean
  separator?: boolean
}
