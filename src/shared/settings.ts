// byndery's settings, shared by the main process and the renderer.
//
// The model follows Windows Terminal and Konsole. Built-in defaults sit under
// the user's settings.json, which holds only what the user changed. Terminal
// settings live in profiles: every profile inherits from "Profile defaults"
// and can override any field, and Settings shows a reset button on each
// field a layer overrides.

import defaults from './default-settings.json' with { type: 'json' }

export type SystemId = 'linux' | 'powershell' | 'cmd'
export const SYSTEMS: SystemId[] = ['linux', 'powershell', 'cmd']

export type CursorStyle = 'bar' | 'block' | 'underline'
export type PromptStyle = 'rainbow' | 'lean' | 'own'

/** Terminal settings a profile can override. */
export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  fontWeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  colorScheme: string
  scrollback: number
  copyOnSelect: boolean
  rightClickPastes: boolean
  /** Powerlevel10k layout for zsh profiles; "own" leaves the user's prompt alone. */
  promptStyle: PromptStyle
}

/** A profile as stored: identity and command, plus overrides of the defaults. */
export interface ProfileEntry extends Partial<TerminalSettings> {
  name?: string
  /** Program to run; empty for a detected profile's own. */
  command?: string
  args?: string[]
  /** Folder a new terminal starts in: "" for the tree's folder, "~" for home, or a path. */
  startIn?: string
  env?: Record<string, string>
  hidden?: boolean
}

/** A profile ready to start: everything resolved. */
export interface Profile extends TerminalSettings {
  id: string
  name: string
  command: string
  /** The program that runs: the command, or the detected shell's own. */
  program: string
  args: string[]
  startIn: string
  env: Record<string, string>
  hidden: boolean
  /** Found on this computer rather than made by the user. */
  detected: boolean
  /** The byndery zsh, whose prompt also takes PowerShell and cmd lines. */
  routes: boolean
}

/** How the byndery zsh prompt picks a system for each line (Windows). */
export interface RoutingSettings {
  /** Earlier wins when a name exists in more than one system. */
  order: SystemId[]
  enabled: Record<SystemId, boolean>
  /** A line starting with a prefix always goes to that system. */
  prefixes: Record<SystemId, string>
  /** A command name that always goes to one system. */
  overrides: Record<string, SystemId>
  /** $env:, $x = 1, [Type]::, Verb-Noun: PowerShell, whatever the order says. */
  powershellSyntax: boolean
}

export interface Settings {
  general: {
    theme: 'system' | 'light' | 'dark'
    defaultProfile: string
    /** Ask before closing a terminal whose command is still running. */
    confirmClose: boolean
  }
  profileDefaults: TerminalSettings
  /** User-made profiles and overrides of detected ones, by id. */
  profiles: Record<string, ProfileEntry>
  commands: RoutingSettings
  files: {
    /** Tree and terminal follow each other's folder. */
    sync: boolean
  }
  editor: {
    fontSize: number
    tabSize: number
    wordWrap: boolean
    /** Markdown opens rendered; Ctrl+E shows the source. */
    markdownPreview: boolean
  }
  history: {
    /** Keep every command with its output. */
    enabled: boolean
  }
  /** Key bindings that differ from the defaults, by action id. */
  keys: Record<string, string[]>
  /** zsh and bash setup, written to a file the shells read (Settings > Shell). */
  shell: {
    plugins: Record<ShellPlugin, boolean>
    /** Offer to install a missing command with pacman (Windows). */
    offerInstall: boolean
    aliases: Record<string, string>
    env: Record<string, string>
    /** Folders added to the end of PATH. */
    path: string[]
  }
  /** byndery's tools for the rest of Windows (Settings > Tools). */
  integration: {
    /** "Open in byndery" in Explorer's folder menu. */
    explorerMenu: boolean
    /** Point Claude Code at byndery's bash (CLAUDE_CODE_GIT_BASH_PATH). */
    gitBashForApps: boolean
    /** Add byndery's Linux tools to the end of the user's PATH. */
    toolsOnPath: boolean
  }
}

export type ShellPlugin = 'autosuggestions' | 'syntaxHighlighting' | 'completions' | 'historySubstringSearch' | 'gitAliases'

export const SHELL_PLUGINS: [ShellPlugin, string, string][] = [
  ['autosuggestions', 'Suggestions as you type', 'Grey completions from your history; the right arrow accepts.'],
  ['syntaxHighlighting', 'Syntax colours', 'Commands, strings and errors coloured as you type.'],
  ['completions', 'Extra completions', 'Tab completion for hundreds more programs.'],
  ['historySubstringSearch', 'History search on the arrow keys', 'Up and down find earlier commands containing what you typed.'],
  ['gitAliases', 'Git aliases', 'Oh My Zsh\'s short forms: gst, gco, gp and the rest.']
]

// One file for the defaults, read by the renderer and built into the backend
// (src-tauri/src/settings.rs), so the two never disagree. `dir` is pinned to
// cmd: it is a GNU program too, but on Windows people mean cmd's.
export const DEFAULT_SETTINGS: Settings = defaults as Settings

export const SYSTEM_NAMES: Record<SystemId, string> = { linux: 'Linux', powershell: 'PowerShell', cmd: 'Command Prompt' }

/** What the settings window reads: the merged result and the user's own layer. */
export interface SettingsState {
  effective: Settings
  user: DeepPartial<Settings>
  profiles: Profile[]
  file: string
  /** Set when settings.json could not be read; the last good settings stay in force. */
  error?: string
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Objects merge key by key; arrays and scalars from `over` replace. */
export function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

export function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const k of path) {
    if (!isObject(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

/** Sets a value deep in a plain object, creating objects on the way. */
export function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObject(cur[k])) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]] = value
}

/** Removes a value and any objects it leaves empty. */
export function deletePath(obj: Record<string, unknown>, path: string[]): void {
  const stack: Record<string, unknown>[] = [obj]
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObject(cur[k])) return
    cur = cur[k] as Record<string, unknown>
    stack.push(cur)
  }
  delete cur[path[path.length - 1]]
  for (let i = stack.length - 1; i > 0; i--) {
    if (Object.keys(stack[i]).length) break
    delete stack[i - 1][path[i - 1]]
  }
}

/** Settings files from before profiles: { commands: { linux, powershell, cmd }, memory }. */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw }
  const c = out.commands
  if (isObject(c) && typeof c.linux === 'boolean') {
    out.commands = { enabled: { linux: c.linux, powershell: c.powershell !== false, cmd: c.cmd !== false } }
  }
  if (typeof out.memory === 'boolean') {
    out.history = { ...(isObject(out.history) ? out.history : {}), enabled: out.memory }
    delete out.memory
  }
  return out
}

/**
 * The routing file the byndery zsh reads on every Enter, one setting per
 * line, so a change applies to terminals that are already open.
 */
export function routingFile(r: RoutingSettings): string {
  const lines = [
    `order=${r.order.join(' ')}`,
    `on=${r.order.filter((s) => r.enabled[s]).join(' ')}`,
    `pssyntax=${r.powershellSyntax ? 1 : 0}`,
    ...SYSTEMS.map((s) => `prefix.${s}=${r.prefixes[s] ?? ''}`),
    ...Object.entries(r.overrides)
      .filter(([name, sys]) => /^[\w.+-]+$/.test(name) && SYSTEMS.includes(sys))
      .map(([name, sys]) => `override.${name.toLowerCase()}=${sys}`)
  ]
  return lines.join('\n') + '\n'
}

/** JSON with // and /* *\/ comments and trailing commas, as VS Code and Windows Terminal accept. */
export function stripComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n'
        i++
      }
      i++
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) {
      // A trailing comma before } or ].
    } else out += c
  }
  return out
}
