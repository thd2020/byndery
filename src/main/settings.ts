import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/api'

// Settings live in Electron's userData folder. The part the shell needs is
// also written as a one-line file the shell reads on every Enter: zsh reads a
// file with $(<file) without starting a process, so a change in the settings
// applies to terminals that are already open.

let current: Settings = DEFAULT_SETTINGS
const file = (): string => join(app.getPath('userData'), 'settings.json')
export const routingFile = (): string => join(app.getPath('userData'), 'shell', 'routing')

export function load(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>
    current = { ...DEFAULT_SETTINGS, ...raw, commands: { ...DEFAULT_SETTINGS.commands, ...raw.commands } }
  } catch {
    current = DEFAULT_SETTINGS
  }
  writeRouting()
  return current
}

export const get = (): Settings => current

export function set(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch, commands: { ...current.commands, ...patch.commands } }
  try {
    writeFileSync(file(), JSON.stringify(current, null, 2))
  } catch {
    // The setting still applies for this session.
  }
  writeRouting()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', current)
  return current
}

function writeRouting(): void {
  const c = current.commands
  const line = `linux=${+c.linux} powershell=${+c.powershell} cmd=${+c.cmd}\n`
  try {
    mkdirSync(join(app.getPath('userData'), 'shell'), { recursive: true })
    writeFileSync(routingFile(), line)
  } catch {
    // Shells fall back to their built-in defaults.
  }
}
