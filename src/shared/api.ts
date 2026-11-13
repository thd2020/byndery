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
  /** The WSL distribution, for wsl.exe profiles: their paths are /mnt/c/... */
  wsl?: string
  /** Shown on the tab instead of the folder: set for a console Windows handed to byndery. */
  title?: string
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

export interface UpdateState {
  currentVersion: string
  availableVersion: string | null
  releasePage: string | null
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  progress: number
  canCheck: boolean
  supportsAutoUpdate: boolean
  installSupported: boolean
  canInstall: boolean
  autoEnabled: boolean
  error: string | null
}

/** byndery as the host for console programs started outside it (Windows 11). */
export interface DefaultTerminalState {
  /** This build includes byndery-handoff.exe. */
  available: boolean
  /** Windows 11 22H2 or later. */
  supported: boolean
  enabled: boolean
  /** Windows Terminal, which provides the console server and the COM proxy, is installed. */
  terminalProxy: boolean
  error: string | null
}

/** byndery's own MSYS2 and its links to the rest of Windows (Settings > Tools). */
export interface ToolsStatus {
  /** This build carries the MSYS2 archive (Windows x64). */
  bundled: boolean
  installed: boolean
  healthy: boolean
  /** Critical files that are gone. */
  missing: string[]
  path: string
  /** Packages added with pacman on top of byndery's base. */
  added: string[]
  integration: { explorerMenu: boolean; gitBashForApps: boolean; gitBashPath: string | null; bash: string | null }
}

export interface Bridge {
  platform: NodeJS.Platform
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    setTitleBarColors(bg: string, fg: string): void
    onMaximized(cb: (max: boolean) => void): void
    /** The page has drawn; the window shows. */
    ready(): void
  }
  workspace: {
    initial(): Promise<string>
    pick(): Promise<string | null>
    /** Native Save As dialog; the chosen path, normalized, or null. */
    saveAs(defaultPath: string): Promise<string | null>
  }
  term: {
    /** Starts a terminal from a profile, or the default profile when none is given; `run` is a first command for zsh. */
    create(cwd: string, cols: number, rows: number, profile?: string, run?: string): Promise<TermInfo>
    write(id: number, data: string): void
    ack(id: number, chars: number): void
    resize(id: number, cols: number, rows: number): void
    kill(id: number): void
    onData(cb: (id: number, data: string) => void): void
    onExit(cb: (id: number, code: number) => void): void
    /** Shows a handed-over console in this window; null when it is gone or already shown. */
    attach(id: number, cols: number, rows: number): Promise<TermInfo | null>
    /** Says this window can take consoles, and returns the ones waiting for a window. */
    handoffs(): Promise<number[]>
    /** A console Windows handed to byndery, for this window to attach. */
    onHandoff(cb: (id: number) => void): void
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
  updates: {
    get(): Promise<UpdateState>
    check(): Promise<UpdateState>
    setEnabled(enabled: boolean): Promise<UpdateState>
    install(): Promise<UpdateState>
    onChange(cb: (state: UpdateState) => void): void
  }
  defaultTerminal: {
    get(): Promise<DefaultTerminalState>
    set(enabled: boolean): Promise<DefaultTerminalState>
  }
  tools: {
    status(): Promise<ToolsStatus>
    /** Unpacks byndery's base again over its MSYS2: restores damaged files, keeps added packages. */
    repair(): Promise<ToolsStatus>
    onProgress(cb: (fraction: number) => void): void
  }
  /** A URL the page can load a local file from (images in rendered Markdown). */
  fileUrl(path: string): string
  menu(items: MenuItem[]): Promise<string | null>
  /** Native message box; resolves to the index of the button pressed. */
  confirm(message: string, detail: string, buttons: string[]): Promise<number>
  devtools(): void
  /** handoff: Windows started this copy to show a console (byndery-handoff.exe passes --handoff). */
  sys: { windowsBuild?: number; home: string; handoff: boolean }
}

export interface MenuItem {
  id?: string
  label?: string
  /** Shown beside the label, in Electron accelerator syntax, e.g. "CmdOrCtrl+C". */
  accel?: string
  enabled?: boolean
  separator?: boolean
}
