import './canvas-font-shim'
import { basename, dirname, fromMsys, isWindowsPath, join, normalize, relative, shellQuote, toMsys } from '../../shared/paths'
import { api, isMac } from './bridge'
import { cssVar, onThemeChange } from './theme'
import { TerminalManager } from './terminal'
import { FileTree } from './tree'
import { EditorArea } from './editor'
import { Palette, type Command } from './palette'
import { SettingsSheet } from './settings'
import { HistoryPanel } from './history-panel'
import { Keymap, focusScope, type Action } from './keymap'
import { PathBar } from './pathbar'
import type { SettingsState } from '../../shared/settings'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/source-serif-4/opsz-italic.css'
import './editor.css'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T
if (isMac) document.body.classList.add('mac')

// Persisted per-viewer layout: pane widths and toggles.
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('layout') ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
})()
const savePrefs = (): void => {
  try {
    localStorage.setItem('layout', JSON.stringify(prefs))
  } catch {
    // Storage unavailable; layout just will not persist.
  }
}

const terms = new TerminalManager($('#term-host'), $('#term-tabs .tabs'))
const tree = new FileTree($('#tree'))
const editor = new EditorArea($('#editor'), $('#editor-tabs .tabs'), $('#editor-host'), $('#editor-notice'), $('#editor-empty'), $('#md-toggle'))
const pathBar = new PathBar($('#tree-path'))
const keymap = new Keymap()
let root = ''
/** Tree and terminal folder sync, both ways, as in Dolphin's terminal panel. Off until switched on. */
let follow = false
let settings: SettingsState | null = null
let files: string[] | null = null

// Title bar colours follow the theme so the system caption buttons blend in.
function syncChrome(): void {
  api.win.setTitleBarColors(cssVar('--bg-chrome'), cssVar('--text-2'))
}
onThemeChange(syncChrome)
syncChrome()

async function setWorkspace(dir: string): Promise<void> {
  root = normalize(dir)
  files = null
  terms.root = root
  editor.root = root
  $('#ws-name').textContent = basename(root) || root
  $('#ws-button').title = `${root}\nOpen folder (Ctrl+O)`
  document.title = `${basename(root)} — byndery`
  pathBar.set(root)
  await tree.setRoot(root)
  // A whole drive is too much to watch; folders open in the tree still reload when revisited.
  if (!/^([A-Z]:)?\/$/.test(root)) void api.fs.watch(root)
  void refreshGit()
}

// Folder history for the tree, as in a file manager: Alt+Left, Alt+Right, Alt+Up.
const back: string[] = []
const forward: string[] = []

/** Shows `dir` as the tree's root. When syncing, the terminal goes there too. */
async function navigate(dir: string, opts: { history?: 'push' | 'back' | 'forward'; fromTerminal?: boolean } = {}): Promise<void> {
  const to = normalize(dir)
  if (samePath(to, root)) return
  if (opts.history !== 'back' && opts.history !== 'forward') forward.length = 0
  if (opts.history === 'back') forward.push(root)
  else back.push(root)
  if (back.length > 100) back.shift()
  await setWorkspace(to)
  if (follow && !opts.fromTerminal) cdTerminal(to)
  if (terms.active) void tree.setCwd(terms.active.cwd, follow)
}

function goBack(): void {
  const to = back.pop()
  if (to) void navigate(to, { history: 'back' })
}
function goForward(): void {
  const to = forward.pop()
  if (to) void navigate(to, { history: 'forward' })
}

/** Alt+Up. At a drive's root the other drives are offered instead. */
async function goUp(): Promise<void> {
  const up = dirname(root)
  if (!samePath(up, root)) return navigate(up)
  const drives = await api.fs.drives()
  if (drives.length < 2) return
  const id = await api.menu(drives.map((d) => ({ id: d, label: d.replace(/\/$/, ''), enabled: !samePath(d, root) })))
  if (id) void navigate(id)
}

const samePath = (a: string, b: string): boolean =>
  api.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)

/** The folder the tree last sent the terminal to, so its own cd does not echo back. */
let sentCd: string | null = null

/**
 * Sends the active terminal to `dir` the way Dolphin does: only at an idle
 * prompt, after clearing whatever is typed there, with a leading space so the
 * shell keeps the cd out of its history.
 */
function cdTerminal(dir: string): void {
  const t = terms.active
  if (!t?.info || !t.info.integrated || t.status === 'busy' || t.status === 'exited') return
  // A double click sends the first click's cd before the shell has moved; one is enough.
  if (samePath(t.cwd, dir) || (sentCd != null && samePath(sentCd, dir))) return
  sentCd = normalize(dir)
  const shell = t.info.shell.toLowerCase()
  const win = dir.replace(/\//g, '\\')
  let line: string
  if (shell.includes('pwsh') || shell.includes('powershell')) line = `\x1b Set-Location -LiteralPath '${win.replace(/'/g, "''")}'`
  else if (shell === 'cmd') line = `\x1b cd /d "${win}"`
  else line = `\x05\x15 cd -- ${shellQuote(t.info.msys ? toMsys(dir) : dir)}`
  api.term.write(t.info.id, line + '\r')
}

// Git status refreshes after file changes settle. One run at a time; a change
// during a run queues exactly one more.
let gitRunning = false
let gitQueued = false
async function refreshGit(): Promise<void> {
  if (gitRunning) {
    gitQueued = true
    return
  }
  gitRunning = true
  try {
    const s = await api.git.status(root)
    tree.setGit(s)
    const b = $('#branch')
    if (s.branch) {
      b.hidden = false
      const sync = [s.ahead ? `↑${s.ahead}` : '', s.behind ? `↓${s.behind}` : ''].filter(Boolean).join(' ')
      b.textContent = sync ? `${s.branch}  ${sync}` : s.branch
      b.title = 'Branch'
    } else b.hidden = true
  } finally {
    gitRunning = false
    if (gitQueued) {
      gitQueued = false
      void refreshGit()
    }
  }
}
let gitTimer = 0
const scheduleGit = (): void => {
  clearTimeout(gitTimer)
  gitTimer = window.setTimeout(() => void refreshGit(), 250)
}

api.fs.onChange((changes) => {
  const paths = changes.map((c) => c.path)
  if (changes.some((c) => c.kind === 'rename')) files = null
  const visible = paths.filter((p) => !p.includes('/.git/'))
  if (visible.length) {
    void tree.changed(visible)
    void editor.diskChanged(new Set(visible))
  }
  scheduleGit()
})

// The coupling between panes.

terms.cwdChanged.on((t) => {
  if (t !== terms.active) return
  const own = sentCd != null && samePath(sentCd, t.cwd)
  sentCd = null
  if (follow && relative(root, t.cwd) == null) {
    void navigate(t.cwd, { fromTerminal: true })
    return
  }
  // A cd the tree sent keeps the folder as the click left it, open or closed.
  void tree.setCwd(t.cwd, follow, !own)
})
terms.activeChanged.on((t) => {
  if (!t) void tree.setCwd(null, false)
})
terms.commandFinished.on(() => {
  // A cd that did not move the shell (a folder it cannot enter) is no longer pending.
  sentCd = null
  scheduleGit()
})
terms.openRequest.on((r) => {
  if (r.dir) {
    if (tree.root && relative(tree.root, r.path) != null) {
      void tree.reveal(r.path).then(() => tree.toggle(r.path, true))
    }
    return
  }
  void editor.open(r.path, { line: r.line, col: r.col, pin: true })
})
tree.open.on(({ path, pin }) => void editor.open(path, { pin }))
tree.folderClicked.on((dir) => {
  if (follow) cdTerminal(dir)
})
tree.enter.on((dir) => void navigate(dir))
tree.terminalHere.on((dir) => terms.create(dir))
pathBar.navigate.on((dir) => void navigate(dir))
tree.sendToTerminal.on((paths) => {
  const t = terms.active ?? terms.create()
  void t.send(paths.map((p) => t.pathForShell(p)).join(' ') + ' ')
  t.focus()
})
editor.activeChanged.on((p) => {
  if (p) void tree.reveal(p)
})
editor.visibilityChanged.on(() => terms.refit())

/** Ctrl+L: the editor's file and selection go to the terminal as an @-mention for the agent. */
function sendSelection(): void {
  const t = terms.active ?? terms.create()
  const ref = editor.reference(t.cwd)
  if (!ref) return
  void t.send(ref + ' ')
  t.focus()
}

// Layout: draggable sashes, persisted widths.

function applyLayout(): void {
  const body = document.body
  if (typeof prefs.sidebar === 'number') body.style.setProperty('--sidebar-w', `${prefs.sidebar}px`)
  if (typeof prefs.editor === 'number') body.style.setProperty('--editor-w', `${prefs.editor}px`)
  body.classList.toggle('no-sidebar', prefs.sidebarHidden === true)
  $('#follow-button').setAttribute('aria-pressed', String(follow))
}
applyLayout()

for (const sash of document.querySelectorAll<HTMLElement>('.sash')) {
  sash.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    sash.setPointerCapture(e.pointerId)
    sash.classList.add('dragging')
    const which = sash.dataset.sash
    const layout = $('#layout').getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      if (which === 'sidebar') {
        const w = Math.max(160, Math.min(ev.clientX - layout.left, layout.width * 0.5))
        prefs.sidebar = Math.round(w)
      } else {
        const w = Math.max(280, Math.min(layout.right - ev.clientX, layout.width - 320))
        prefs.editor = Math.round(w)
      }
      applyLayout()
    }
    const up = (): void => {
      sash.classList.remove('dragging')
      sash.removeEventListener('pointermove', move)
      sash.removeEventListener('pointerup', up)
      savePrefs()
      terms.refit()
    }
    sash.addEventListener('pointermove', move)
    sash.addEventListener('pointerup', up)
  })
  sash.addEventListener('dblclick', () => {
    if (sash.dataset.sash === 'sidebar') delete prefs.sidebar
    else delete prefs.editor
    document.body.style.removeProperty(sash.dataset.sash === 'sidebar' ? '--sidebar-w' : '--editor-w')
    applyLayout()
    savePrefs()
    terms.refit()
  })
}

function toggleSidebar(): void {
  prefs.sidebarHidden = !prefs.sidebarHidden
  applyLayout()
  savePrefs()
  terms.refit()
}

function toggleFollow(): void {
  void api.settings.set(['files', 'sync'], !follow)
}

/** Sync was switched on or off, from the button or from Settings. */
function syncChanged(): void {
  applyLayout()
  // Switching sync on brings the tree to the terminal's folder.
  const t = terms.active
  if (!t) return
  if (follow && relative(root, t.cwd) == null) void navigate(t.cwd, { fromTerminal: true })
  else void tree.setCwd(t.cwd, follow)
}

/** Ctrl+`: from anywhere to the terminal, and from the terminal back to the editor. */
function toggleFocus(): void {
  const inTerm = document.activeElement?.closest('#terminals')
  if (inTerm && editor.active && editor.visible) editor.focus()
  else (terms.active ?? terms.create()).focus()
}

async function openFolder(): Promise<void> {
  const dir = await api.workspace.pick()
  if (!dir) return
  await setWorkspace(dir)
  terms.create(dir)
}

// Ctrl+= and Ctrl+- zoom the terminals and the editor together, for this
// window; the sizes themselves are settings.
let zoomBy = typeof prefs.zoom === 'number' ? prefs.zoom : 0
function applyZoom(): void {
  terms.zoom = zoomBy
  const size = (settings?.effective.editor.fontSize ?? 13) + zoomBy
  document.documentElement.style.setProperty('--code-size', `${Math.max(6, size)}px`)
  for (const v of terms.views) v.applySettings()
  editor.view.requestMeasure()
}
function zoom(delta: number): void {
  zoomBy = delta === 0 ? 0 : Math.max(-6, Math.min(12, zoomBy + delta))
  prefs.zoom = zoomBy
  delete prefs.fontSize
  savePrefs()
  applyZoom()
}

const settingsSheet = new SettingsSheet(keymap)
settingsSheet.openFile.on((file) => void editor.open(file, { pin: true }).then(() => editor.focus()))

/** Settings arrived or changed: every part of the window takes its share. */
function applySettings(s: SettingsState): void {
  const was = settings
  settings = s
  terms.applySettings(s)
  keymap.setOverrides(s.effective.keys)
  editor.configure(s.effective.editor)
  applyZoom()
  if (was && was.effective.files.sync === s.effective.files.sync) return
  follow = s.effective.files.sync
  if (was) syncChanged()
  else applyLayout()
}
api.settings.onChange(applySettings)
const historyPanel = new HistoryPanel()

/** Ctrl+K: the command memory, for the active terminal. */
function openHistory(): void {
  const t = terms.active ?? terms.create()
  void historyPanel.open({
    cwd: t.cwd,
    root,
    session: t.session,
    put: (text, run) => {
      // Ctrl+U clears whatever is on the line in zsh and bash, then the
      // command goes in as a paste so a multi-line one stays one command.
      api.term.write(t.info.id, '\x15')
      void t.send(text).then(() => {
        if (run) api.term.write(t.info.id, '\r')
        t.focus()
      })
    }
  })
}

/** Ctrl+W in a terminal. A command still running is confirmed first, as VS Code and Windows Terminal do. */
async function closeTerminal(): Promise<void> {
  const t = terms.active
  if (!t) return
  if (t.status === 'busy' && settings?.effective.general.confirmClose !== false) {
    const choice = await api.confirm('Close this terminal?', 'A command is still running in it.', ['Close', 'Cancel'])
    if (choice !== 0) return t.focus()
  }
  terms.close(t)
}

const actions: Action[] = [
  { id: 'palette.files', label: 'Go to File', keys: ['Mod+P'], scope: 'window', run: () => palette.show('') },
  { id: 'palette.commands', label: 'Show All Commands', keys: ['Mod+Shift+P', 'F1'], scope: 'window', run: () => palette.show('>'), hidden: true },
  { id: 'settings', label: 'Settings', keys: ['Mod+,'], scope: 'window', run: () => settingsSheet.toggle() },
  { id: 'history', label: 'Search Command History', keys: ['Mod+K'], scope: 'window', run: openHistory },
  { id: 'folder.open', label: 'Open Folder…', keys: ['Mod+O'], scope: 'window', run: () => void openFolder() },
  { id: 'term.new', label: 'New Terminal', keys: ['Mod+T', 'Mod+Shift+`'], scope: 'window', run: () => terms.create() },
  { id: 'term.close', label: 'Close Terminal', keys: ['Mod+W'], scope: 'terminal', run: () => void closeTerminal() },
  { id: 'term.prevCommand', label: 'Previous Command', keys: ['Mod+Up'], scope: 'terminal', run: () => terms.active?.jumpToPrompt(-1) },
  { id: 'term.nextCommand', label: 'Next Command', keys: ['Mod+Down'], scope: 'terminal', run: () => terms.active?.jumpToPrompt(1) },
  { id: 'term.next', label: 'Next Terminal', keys: ['Mod+Tab', 'Mod+PageDown'], scope: 'terminal', run: () => terms.cycle(1) },
  { id: 'term.prev', label: 'Previous Terminal', keys: ['Mod+Shift+Tab', 'Mod+PageUp'], scope: 'terminal', run: () => terms.cycle(-1) },
  { id: 'focus.toggle', label: 'Move Between Terminal and Editor', keys: ['Mod+`'], scope: 'window', run: toggleFocus },
  { id: 'tree.focus', label: 'Focus File Tree', keys: ['Mod+Shift+E'], scope: 'window', run: () => tree.focus() },
  { id: 'tree.toggle', label: 'Show or Hide File Tree', keys: ['Mod+B'], scope: 'window', run: toggleSidebar },
  { id: 'tree.follow', label: 'Sync File Tree and Terminal Folder', keys: [], scope: 'window', run: toggleFollow },
  { id: 'tree.collapse', label: 'Collapse Folders', keys: [], scope: 'window', run: () => tree.collapseAll() },
  { id: 'tree.up', label: 'Go to Parent Folder', keys: ['Alt+Up'], scope: 'tree', run: () => void goUp() },
  { id: 'tree.back', label: 'Go Back', keys: ['Alt+Left'], scope: 'tree', run: goBack },
  { id: 'tree.forward', label: 'Go Forward', keys: ['Alt+Right'], scope: 'tree', run: goForward },
  { id: 'tree.editPath', label: 'Type a Folder Path', keys: ['Mod+Shift+L'], scope: 'tree', run: () => pathBar.edit() },
  { id: 'editor.new', label: 'New File', keys: ['Mod+T', 'Mod+N'], scope: 'editor', run: () => editor.newFile() },
  { id: 'editor.save', label: 'Save', keys: ['Mod+S'], scope: 'window', run: () => void editor.save() },
  { id: 'editor.close', label: 'Close Editor Tab', keys: ['Mod+W'], scope: 'window', run: () => void editor.close() },
  { id: 'editor.next', label: 'Next Editor Tab', keys: ['Mod+Tab', 'Mod+PageDown'], scope: 'window', run: () => editor.cycle(1) },
  { id: 'editor.prev', label: 'Previous Editor Tab', keys: ['Mod+Shift+Tab', 'Mod+PageUp'], scope: 'window', run: () => editor.cycle(-1) },
  { id: 'editor.hide', label: 'Hide Editor', keys: [], scope: 'window', run: () => editor.hide() },
  { id: 'editor.source', label: 'Switch Markdown Preview and Source', keys: ['Mod+E'], scope: 'editor', run: () => editor.toggleSource() },
  { id: 'editor.send', label: 'Send Selection to Terminal', keys: ['Mod+L'], scope: 'editor', run: sendSelection },
  { id: 'editor.gotoLine', label: 'Go to Line', keys: ['Mod+G'], scope: 'editor', run: () => palette.show(':') },
  { id: 'editor.reveal', label: 'Reveal Active File in Tree', keys: [], scope: 'window', run: () => editor.active && void tree.reveal(editor.active.path) },
  { id: 'editor.revealOs', label: isMac ? 'Reveal Active File in Finder' : 'Reveal Active File in File Explorer', keys: [], scope: 'window', run: () => editor.active && api.fs.reveal(editor.active.path) },
  { id: 'editor.copyPath', label: 'Copy Active File Path', keys: [], scope: 'window', run: () => editor.active && api.clipboard.write(editor.active.path) },
  { id: 'zoom.in', label: 'Increase Font Size', keys: ['Mod+='], scope: 'window', run: () => zoom(1) },
  { id: 'zoom.out', label: 'Decrease Font Size', keys: ['Mod+-'], scope: 'window', run: () => zoom(-1) },
  { id: 'zoom.reset', label: 'Reset Font Size', keys: ['Mod+0'], scope: 'window', run: () => zoom(0) },
  { id: 'window.reload', label: 'Reload Window', keys: [], scope: 'window', run: () => location.reload() },
  { id: 'window.devtools', label: 'Toggle Developer Tools', keys: [], scope: 'window', run: () => api.devtools() }
]
keymap.define(actions)

const commands = (): Command[] =>
  keymap
    .all()
    .filter((a) => !a.hidden)
    .map((a) => ({ id: a.id, label: a.label, key: keymap.keysOf(a.id)[0], run: a.run }))

const palette = new Palette($('#palette'), $<HTMLInputElement>('#palette-input'), $<HTMLUListElement>('#palette-list'), {
  files: async () => (files ??= await api.fs.find(root)),
  commands,
  openFile: (rel) => void editor.open(join(root, rel), { pin: true }).then(() => editor.focus()),
  gotoLine: (n) => editor.goto(n),
  absolute: (input) => {
    let s = input.replace(/^["']|["']$/g, '')
    let line: number | undefined
    const pos = /:(\d+)(?::\d+)?$/.exec(s)
    if (pos) {
      line = Number(pos[1])
      s = s.slice(0, pos.index)
    }
    if (isWindowsPath(s)) return { path: normalize(s), line }
    if (/^\/[A-Za-z](\/|$)/.test(s) || (s.startsWith('/') && terms.active?.info?.msys)) {
      return { path: fromMsys(s, terms.active?.info?.msys), line }
    }
    if (s.startsWith('~/')) return { path: join(api.sys.home, s.slice(2)), line }
    return null
  },
  openPath: (path, line) =>
    void api.fs.stat(path).then(async (st) => {
      if (!st) return
      if (!st.dir) return editor.open(path, { pin: true, line }).then(() => editor.focus())
      if (relative(root, path) != null) await tree.reveal(path).then(() => tree.toggle(path, true))
      else await navigate(path)
    })
})

// Keyboard. The window listens first, in the capture phase, so an app key
// never reaches the shell; keys bound to nothing go on to the focused pane.
// A panel with its own keys (the command history) keeps them.
window.addEventListener(
  'keydown',
  (e) => {
    if ((document.activeElement as HTMLElement | null)?.closest('[data-own-keys]')) return
    const action = keymap.match(e, focusScope())
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    action.run()
  },
  true
)
terms.claimsKey = (e) => keymap.match(e, 'terminal') != null

$('#ws-button').addEventListener('click', () => void openFolder())
$('#search-button').addEventListener('click', () => palette.show(''))
$('#new-term').addEventListener('click', () => terms.create())
// The profiles menu beside +, as in Windows Terminal.
$('#new-term-menu').addEventListener('click', async () => {
  const s = settings
  if (!s) return
  const profiles = s.profiles.filter((p) => !p.hidden)
  const def = terms.defaultProfile()?.id
  const id = await api.menu([
    ...profiles.map((p) => ({ id: `p:${p.id}`, label: p.id === def ? `${p.name} (default)` : p.name })),
    { separator: true },
    { id: 'settings', label: 'Settings', accel: 'CmdOrCtrl+,' }
  ])
  if (id === 'settings') void settingsSheet.open()
  else if (id?.startsWith('p:')) terms.create(undefined, id.slice(2))
})
$('#follow-button').addEventListener('click', toggleFollow)
$('#tree-up').addEventListener('click', () => void goUp())
// Mouse back and forward buttons over the tree.
$('#sidebar').addEventListener('mouseup', (e) => {
  if (e.button === 3) goBack()
  if (e.button === 4) goForward()
})
$('#collapse-button').addEventListener('click', () => tree.collapseAll())
$('#term-tabs').addEventListener('dblclick', (e) => {
  if (e.target === $('#term-tabs') || e.target === $('#term-tabs .tabs')) terms.create()
})
$('#titlebar').addEventListener('dblclick', (e) => {
  if (e.target === $('#titlebar') && isMac) api.win.toggleMaximize()
})

window.addEventListener('beforeunload', () => {
  for (const v of terms.views) v.dispose()
})

void (async () => {
  applySettings(await api.settings.get())
  await setWorkspace(await api.workspace.initial())
  terms.create(root)
})()

// Handles for the end-to-end tests and for poking at the app from DevTools.
;(window as unknown as { __byndery: unknown }).__byndery = { terms, tree, editor, palette, settings: settingsSheet, history: historyPanel, keymap, navigate, get sync() { return follow } }
