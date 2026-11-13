import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { message, open, save } from '@tauri-apps/plugin-dialog'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import type { Bridge } from '../../shared/api'
import { capOutput, outputAllowed, redact, shouldRemember } from '../../shared/history'

/**
 * The renderer's way to the backend: the `Bridge` interface from
 * src/shared/api.ts over Tauri commands (src-tauri/src/lib.rs) and events.
 * The backend puts the platform and a few facts in window.__BYNDERY__
 * before the page loads.
 */

declare global {
  interface Window {
    __BYNDERY__: { platform: NodeJS.Platform; sys: { windowsBuild?: number; home: string; handoff: boolean } }
  }
}

const boot = window.__BYNDERY__ ?? { platform: 'linux' as NodeJS.Platform, sys: { home: '/', handoff: false } }
const me = getCurrentWebviewWindow()
const on = <T>(event: string, cb: (payload: T) => void): void => void me.listen<T>(event, (e) => cb(e.payload))
const native = (p: string): string => (boot.platform === 'win32' ? p.replace(/\//g, '\\') : p)

// Links open in the user's browser, never inside the app.
window.open = ((url?: string | URL) => {
  const u = String(url ?? '')
  if (/^https?:/i.test(u)) void openUrl(u)
  return null
}) as typeof window.open

export const api: Bridge = {
  platform: boot.platform,
  sys: { ...boot.sys, windowsBuild: boot.sys.windowsBuild ?? undefined },
  win: {
    minimize: () => void invoke('win_minimize'),
    toggleMaximize: () => void invoke('win_toggle_maximize'),
    close: () => void invoke('win_close'),
    setTitleBarColors: (bg) => void invoke('win_background', { color: bg }),
    onMaximized: (cb) => on<boolean>('win:maximized', cb),
    ready: () => void invoke('win_ready')
  },
  workspace: {
    initial: () => invoke('ws_initial'),
    pick: async () => {
      const dir = await open({ directory: true })
      if (typeof dir !== 'string') return null
      const ws = dir.replace(/\\/g, '/')
      void invoke('ws_save', { dir: ws })
      return ws
    },
    saveAs: async (defaultPath) => {
      const p = await save({ defaultPath: native(defaultPath) })
      return p ? p.replace(/\\/g, '/') : null
    }
  },
  term: {
    create: (cwd, cols, rows, profile, run) => invoke('term_create', { args: { cwd, cols, rows, profile, run } }),
    write: (id, data) => void invoke('term_write', { id, data }),
    ack: (id, n) => void invoke('term_ack', { id, n }),
    resize: (id, cols, rows) => void invoke('term_resize', { id, cols, rows }),
    kill: (id) => void invoke('term_kill', { id }),
    onData: (cb) => on<[number, string]>('term:data', ([id, d]) => cb(id, d)),
    onExit: (cb) => on<[number, number]>('term:exit', ([id, code]) => cb(id, code)),
    attach: (id, cols, rows) => invoke('term_attach', { id, cols, rows }),
    handoffs: () => invoke('term_handoffs'),
    onHandoff: (cb) => on<number>('term:handoff', cb)
  },
  fs: {
    list: (dir) => invoke('fs_list', { dir }),
    read: (path) => invoke('fs_read', { path }),
    write: (path, text) => invoke('fs_write', { path, text }),
    stat: (path) => invoke('fs_stat', { path }),
    watch: (root) => invoke('fs_watch', { root }),
    onChange: (cb) => on('fs:change', cb),
    reveal: (p) => void revealItemInDir(native(p)),
    openExternal: (p) => void openPath(native(p)),
    drives: () => invoke('fs_drives'),
    find: (root) => invoke('fs_find', { root }),
    rename: (from, to) => invoke('fs_rename', { from, to }),
    trash: (path) => invoke('fs_trash', { path }),
    create: (path, dir) => invoke('fs_create', { path, dir }),
    // Files dropped from the system carry no path in a web view.
    pathForFile: () => ''
  },
  git: {
    status: (root) => invoke('git_status', { root }),
    show: (path) => invoke('git_show', { path })
  },
  clipboard: {
    write: (t) => void writeText(t),
    read: async () => (await readText().catch(() => '')) ?? ''
  },
  history: {
    // Secrets are taken out here, before anything leaves the page.
    record: (r) => {
      if (!shouldRemember(r.command)) return
      const out = outputAllowed(r.command) ? capOutput(redact(r.output)) : { text: '', capped: false }
      void invoke('history_record', {
        record: { ...r, command: redact(r.command), output: out.text, truncated: r.truncated || out.capped }
      })
    },
    search: (query) => invoke('history_search', { query }),
    output: (id) => invoke('history_output', { id }),
    remove: (id) => invoke('history_remove', { id }),
    clear: () => invoke('history_clear')
  },
  settings: {
    get: () => invoke('settings_get'),
    set: (path, value) => invoke('settings_set', { path, value }),
    reset: (path) => invoke('settings_reset', { path }),
    onChange: (cb) => on('settings:changed', cb),
    explain: (line) => invoke('settings_explain', { line })
  },
  updates: {
    get: () => invoke('updates_get'),
    check: () => invoke('updates_check'),
    setEnabled: (enabled) => invoke('updates_set_enabled', { enabled }),
    install: () => invoke('updates_install'),
    onChange: (cb) => on('updates:changed', cb)
  },
  defaultTerminal: {
    get: () => invoke('defterm_get'),
    set: (enabled) => invoke('defterm_set', { enabled })
  },
  tools: {
    status: () => invoke('tools_status'),
    repair: () => invoke('tools_repair'),
    onProgress: (cb) => on<number>('tools:progress', cb)
  },
  fileUrl: (abs) => {
    const path = encodeURI(abs.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
    const rooted = path.startsWith('/') ? path : '/' + path
    return boot.platform === 'win32' ? `http://byndery-file.localhost${rooted}` : `byndery-file://localhost${rooted}`
  },
  menu: (items) => invoke('menu_popup', { items }),
  confirm: async (text, detail, buttons) => {
    // Two buttons or three (Save, Don't Save, Cancel); closing the box is the last one.
    const [first, second = 'Cancel', third] = buttons
    const choice = await message(detail ? `${text}\n\n${detail}` : text, {
      title: 'byndery',
      kind: 'warning',
      buttons: third ? { yes: first, no: second, cancel: third } : { ok: first, cancel: second }
    })
    const i = buttons.indexOf(choice)
    if (i >= 0) return i
    if (choice === 'Ok' || choice === 'Yes') return 0
    if (choice === 'No' && third) return 1
    return buttons.length - 1
  },
  devtools: () => void invoke('win_devtools')
}

export const isMac = api.platform === 'darwin'

/** Tiny event emitter, enough for the handful of app-wide events. */
export class Emitter<T> {
  private fns = new Set<(v: T) => void>()
  on(fn: (v: T) => void): () => void {
    this.fns.add(fn)
    return () => this.fns.delete(fn)
  }
  emit(v: T): void {
    for (const fn of this.fns) fn(v)
  }
}

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text != null) el.textContent = text
  return el
}

export const icon = (paths: string, viewBox = '0 0 16 16'): SVGSVGElement => {
  const t = document.createElement('template')
  t.innerHTML = `<svg viewBox="${viewBox}" aria-hidden="true">${paths}</svg>`
  return t.content.firstElementChild as SVGSVGElement
}

export const ICON = {
  close: '<path d="m4.5 4.5 7 7m0-7-7 7" />',
  chevron: '<path d="m6 4 4 4-4 4" />'
}
