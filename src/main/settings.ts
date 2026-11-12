import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  SYSTEMS,
  deletePath,
  merge,
  migrate,
  routingFile as routingText,
  setPath,
  stripComments,
  type Profile,
  type Settings,
  type SettingsState
} from '../shared/settings'

// settings.json in Electron's userData folder holds only what the user
// changed; the defaults come from the code, as in VS Code and Windows
// Terminal. The file may have // and /* */ comments. When it is edited by
// hand and cannot be read, the last good settings stay in force and the
// settings window says what is wrong.
//
// The part the shell needs is also written to shell/routing, which zsh reads
// with $(<file) on every Enter, so routing changes reach open terminals.

let user: Record<string, unknown> = {}
let effective: Settings = DEFAULT_SETTINGS
let error: string | undefined
let lastText = ''
let watcher: FSWatcher | null = null
let profileSource: (s: Settings) => Profile[] = () => []
const listeners: ((s: Settings) => void)[] = []

/** Runs whenever the settings in force change, from the window or from the file. */
export function onApply(fn: (s: Settings) => void): void {
  listeners.push(fn)
}

export const file = (): string => join(app.getPath('userData'), 'settings.json')
export const routingFile = (): string => join(app.getPath('userData'), 'shell', 'routing')

/** Where the resolved profile list comes from; set once by the app. */
export function setProfileSource(fn: (s: Settings) => Profile[]): void {
  profileSource = fn
}

export function load(): void {
  read()
  watch()
}

export const get = (): Settings => effective

export function state(): SettingsState {
  return { effective, user, profiles: profileSource(effective), file: file().replace(/\\/g, '/'), error }
}

export function set(path: string[], value: unknown): SettingsState {
  setPath(user, path, value)
  save()
  return state()
}

export function reset(path: string[]): SettingsState {
  deletePath(user, path)
  save()
  return state()
}

function read(): boolean {
  let text: string
  try {
    text = readFileSync(file(), 'utf8')
  } catch {
    text = ''
  }
  if (text === lastText && lastText !== '') return false
  lastText = text
  if (!text.trim()) {
    user = {}
    error = undefined
  } else {
    try {
      const raw = JSON.parse(stripComments(text))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('the file must hold one { } object')
      user = migrate(raw as Record<string, unknown>)
      error = undefined
    } catch (e) {
      error = `settings.json could not be read: ${(e as Error).message}`
    }
  }
  apply()
  return true
}

function apply(): void {
  const s = merge(DEFAULT_SETTINGS, user)
  // Every system appears once in the order, whatever the file says.
  const order = (Array.isArray(s.commands.order) ? s.commands.order : []).filter((x, i, a) => SYSTEMS.includes(x) && a.indexOf(x) === i)
  s.commands.order = [...order, ...SYSTEMS.filter((x) => !order.includes(x))]
  effective = s
  for (const fn of listeners) fn(s)
  try {
    mkdirSync(dirname(routingFile()), { recursive: true })
    writeFileSync(routingFile(), routingText(s.commands))
  } catch {
    // Shells fall back to their built-in defaults.
  }
}

function save(): void {
  apply()
  error = undefined
  lastText = JSON.stringify(user, null, 2) + '\n'
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), lastText)
  } catch {
    // The setting still applies for this session.
  }
  broadcast()
}

function broadcast(): void {
  const s = state()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s)
}

// Edits made outside the settings window, in byndery's editor or any other,
// apply as soon as the file is saved.
function watch(): void {
  watcher?.close()
  let timer: NodeJS.Timeout | null = null
  try {
    mkdirSync(dirname(file()), { recursive: true })
    watcher = fsWatch(dirname(file()), (_event, name) => {
      if (name?.toString() !== 'settings.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (read()) broadcast()
      }, 120)
    })
  } catch {
    watcher = null
  }
}
