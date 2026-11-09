import './canvas-font-shim'
import { basename, fromMsys, isWindowsPath, join, normalize, relative } from '../../shared/paths'
import { api, isMac } from './bridge'
import { cssVar, onThemeChange } from './theme'
import { TerminalManager } from './terminal'
import { FileTree } from './tree'
import { EditorArea } from './editor'
import { Palette, type Command } from './palette'
import { SettingsSheet } from './settings'
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
let root = ''
let follow = prefs.follow !== false
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
  await tree.setRoot(root)
  void api.fs.watch(root)
  void refreshGit()
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
  if (t === terms.active) void tree.setCwd(t.cwd, follow)
})
terms.activeChanged.on((t) => {
  if (!t) void tree.setCwd(null, false)
})
terms.commandFinished.on(() => scheduleGit())
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
  follow = !follow
  prefs.follow = follow
  applyLayout()
  savePrefs()
  if (terms.active) void tree.setCwd(terms.active.cwd, follow)
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

function setFontSize(size: number): void {
  terms.fontSize = size
  document.documentElement.style.setProperty('--code-size', `${size}px`)
  for (const v of terms.views) v.xterm.options.fontSize = size
  terms.refit()
  editor.view.requestMeasure()
}
function zoom(delta: number): void {
  const size = delta === 0 ? 13 : Math.max(9, Math.min(24, terms.fontSize + delta))
  prefs.fontSize = size
  savePrefs()
  setFontSize(size)
}
if (typeof prefs.fontSize === 'number') setFontSize(prefs.fontSize)

const settingsSheet = new SettingsSheet()

const commands = (): Command[] => [
  { id: 'settings', label: 'Settings', key: 'Mod+,', run: () => void settingsSheet.open() },
  { id: 'open-folder', label: 'Open Folder…', key: 'Mod+O', run: () => void openFolder() },
  { id: 'new-term', label: 'New Terminal', key: 'Mod+Shift+`', run: () => terms.create() },
  { id: 'close-term', label: 'Close Terminal', run: () => terms.active && terms.close(terms.active) },
  { id: 'focus-term', label: 'Focus Terminal', key: 'Mod+`', run: () => (terms.active ?? terms.create()).focus() },
  { id: 'focus-tree', label: 'Focus File Tree', key: 'Mod+Shift+E', run: () => tree.focus() },
  { id: 'toggle-tree', label: 'Toggle File Tree', key: 'Mod+B', run: toggleSidebar },
  { id: 'follow', label: follow ? 'Stop Following Terminal Folder' : 'Follow Terminal Folder', run: toggleFollow },
  { id: 'collapse', label: 'Collapse Folders', run: () => tree.collapseAll() },
  { id: 'save', label: 'Save', key: 'Mod+S', run: () => void editor.save() },
  { id: 'close-tab', label: 'Close Editor Tab', key: 'Mod+W', run: () => void editor.close() },
  { id: 'hide-editor', label: 'Hide Editor', run: () => editor.hide() },
  { id: 'md-source', label: 'Toggle Markdown Source', key: 'Mod+E', run: () => editor.toggleSource() },
  { id: 'send', label: 'Send Selection to Terminal', key: 'Mod+L', run: sendSelection },
  { id: 'reveal', label: 'Reveal Active File in Tree', run: () => editor.active && void tree.reveal(editor.active.path) },
  { id: 'reveal-os', label: isMac ? 'Reveal Active File in Finder' : 'Reveal Active File in File Explorer', run: () => editor.active && api.fs.reveal(editor.active.path) },
  { id: 'copy-path', label: 'Copy Active File Path', run: () => editor.active && api.clipboard.write(editor.active.path) },
  { id: 'zoom-in', label: 'Increase Font Size', key: 'Mod+=', run: () => zoom(1) },
  { id: 'zoom-out', label: 'Decrease Font Size', key: 'Mod+-', run: () => zoom(-1) },
  { id: 'zoom-reset', label: 'Reset Font Size', key: 'Mod+0', run: () => zoom(0) },
  { id: 'reload', label: 'Reload Window', run: () => location.reload() },
  { id: 'devtools', label: 'Toggle Developer Tools', run: () => api.devtools() }
]

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
      else {
        await setWorkspace(path)
        terms.create(path)
      }
    })
})

// Keyboard. Editor-only shortcuts apply when focus is in the editor, so Ctrl+W
// and Ctrl+E keep their readline meaning in the terminal.
window.addEventListener(
  'keydown',
  (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (!mod || e.altKey) return
    const k = e.key.toLowerCase()
    const inEditor = !!document.activeElement?.closest('#editor')
    const inTerm = !!document.activeElement?.closest('#terminals')
    let handled = true
    if (k === ',') settingsSheet.toggle()
    else if (k === 'p' && e.shiftKey) palette.show('>')
    else if (k === 'p') palette.show('')
    else if (k === 'o') void openFolder()
    else if (k === 'b') toggleSidebar()
    else if (e.code === 'Backquote' && e.shiftKey) terms.create()
    else if (e.code === 'Backquote') toggleFocus()
    else if (k === 'e' && e.shiftKey) tree.focus()
    else if (k === '=' || k === '+') zoom(1)
    else if (k === '-') zoom(-1)
    else if (k === '0') zoom(0)
    else if ((k === 'tab' || k === 'pagedown' || k === 'pageup') && inTerm)
      terms.cycle(k === 'pageup' || (k === 'tab' && e.shiftKey) ? -1 : 1)
    else if (k === 'tab' || k === 'pagedown' || k === 'pageup') editor.cycle(k === 'pageup' || (k === 'tab' && e.shiftKey) ? -1 : 1)
    else if (k === 's' && editor.active) void editor.save()
    else if (k === 'w' && inEditor) void editor.close()
    else if (k === 'e' && inEditor) editor.toggleSource()
    else if (k === 'l' && inEditor) sendSelection()
    else if (k === 'g' && inEditor) palette.show(':')
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true
)

$('#ws-button').addEventListener('click', () => void openFolder())
$('#search-button').addEventListener('click', () => palette.show(''))
$('#new-term').addEventListener('click', () => terms.create())
$('#follow-button').addEventListener('click', toggleFollow)
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
  await setWorkspace(await api.workspace.initial())
  terms.create(root)
})()

// Handles for the end-to-end tests and for poking at the app from DevTools.
;(window as unknown as { __byndery: unknown }).__byndery = { terms, tree, editor, palette, settings: settingsSheet }
