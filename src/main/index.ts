import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, screen, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { explainRoute, resolveProfiles, specFor, type ShellDirs } from './shell'
import * as term from './pty'
import * as files from './files'
import * as git from './git'
import * as settings from './settings'
import * as history from './history'
import { checkForUpdates, getUpdateState, installPendingOnQuit, installUpdateNow, setAutoUpdatesEnabled, startUpdater } from './updater'
import { defaultTerminalState, refreshDefaultTerminal, setDefaultTerminal, startHandoffServer } from './handoff'
import { normalize } from '../shared/paths'
import { handoffLabel, type HandoffHeader } from '../shared/handoff'

// Window state and the last workspace live in Electron's userData folder,
// never in the folder the user opened.
interface Saved {
  workspace?: string
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}
const statePath = (): string => join(app.getPath('userData'), 'state.json')
function loadState(): Saved {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}
let saved: Saved = {}
function saveState(patch: Partial<Saved>): void {
  saved = { ...saved, ...patch }
  try {
    writeFileSync(statePath(), JSON.stringify(saved))
  } catch {
    // Not worth interrupting the user over.
  }
}

// A temp folder for the shells, cleared at each start so files left by
// closed terminals do not pile up.
let shellTempDir: string | null = null
function shellTemp(): string {
  if (shellTempDir) return shellTempDir
  shellTempDir = join(app.getPath('temp'), 'byndery-shell')
  try {
    rmSync(shellTempDir, { recursive: true, force: true })
    mkdirSync(shellTempDir, { recursive: true })
  } catch {
    // Another byndery window may hold a file open; reuse the folder as it is.
  }
  return shellTempDir
}

// In a packaged build the shell scripts and the bundled MSYS2 sit in the app's
// resources folder; in development they come from the repository.
const shellDirs = (): ShellDirs =>
  app.isPackaged
    ? { integration: join(process.resourcesPath, 'shell'), vendor: join(process.resourcesPath, 'vendor'), routing: settings.routingFile(), temp: shellTemp() }
    : { integration: join(app.getAppPath(), 'resources', 'shell'), vendor: join(app.getAppPath(), 'vendor'), routing: settings.routingFile(), temp: shellTemp() }

function initialWorkspace(): string {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && a !== '.')
  for (const candidate of [arg, saved.workspace]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) return normalize(candidate)
  }
  return normalize(app.isPackaged ? homedir() : process.cwd())
}

const dark = (): boolean => nativeTheme.shouldUseDarkColors
const chrome = (): { bg: string; fg: string } => (dark() ? { bg: '#161514', fg: '#d9d6d0' } : { bg: '#f4f2ee', fg: '#3a3835' })

function createWindow(): BrowserWindow {
  const c = chrome()
  const b = saved.bounds
  const visible = b && screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })
  const win = new BrowserWindow({
    width: visible ? b!.width : 1280,
    height: visible ? b!.height : 800,
    x: visible ? b!.x : undefined,
    y: visible ? b!.y : undefined,
    minWidth: 560,
    minHeight: 360,
    show: false,
    backgroundColor: c.bg,
    title: 'byndery',
    icon: join(app.getAppPath(), 'README.assets', 'byndery-icon.png'),
    // The system draws the caption buttons, so they look and behave exactly
    // like every other window on the desktop, snap layouts included.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 36 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  if (saved.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  const remember = (): void => {
    if (win.isDestroyed()) return
    saveState({ maximized: win.isMaximized(), ...(win.isMaximized() ? {} : { bounds: win.getBounds() }) })
  }
  win.on('resized', remember)
  win.on('moved', remember)
  win.on('close', remember)
  win.on('maximize', () => win.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win.webContents.send('win:maximized', false))

  // Links in rendered Markdown open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

// Consoles Windows hands to byndery wait here until a window says it can take
// them (term:handoffs), then go to the focused window as new tabs.
const launchedForHandoff = process.argv.includes('--handoff')
const handoffWindows = new Set<number>()
const waitingHandoffs: number[] = []

function receiveConsole(proc: term.TermProcess, header: HandoffHeader): void {
  if (header.hidden) {
    // Started hidden: it runs without a tab until it exits, as in a hidden console window.
    proc.onData(() => {})
    return
  }
  const id = term.adoptTerminal(proc, {
    shell: header.program || 'console',
    profile: '',
    profileName: handoffLabel(header),
    cwd: normalize(homedir()),
    integrated: false,
    title: handoffLabel(header)
  })
  const ready = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && handoffWindows.has(w.webContents.id))
  const target = ready.find((w) => w.isFocused()) ?? ready[0]
  if (!target) {
    waitingHandoffs.push(id)
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    return
  }
  target.webContents.send('term:handoff', id)
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function registerIpc(): void {
  const sender = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on('win:minimize', (e) => sender(e)?.minimize())
  ipcMain.on('win:toggleMaximize', (e) => {
    const w = sender(e)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => sender(e)?.close())
  ipcMain.on('win:titleBarColors', (e, bg: string, fg: string) => {
    const w = sender(e)
    if (w && process.platform !== 'darwin') w.setTitleBarOverlay({ color: bg, symbolColor: fg })
    w?.setBackgroundColor(bg)
  })
  ipcMain.on('sys:info', (e) => {
    e.returnValue = { windowsBuild: term.windowsBuild(), home: normalize(homedir()), handoff: launchedForHandoff }
  })

  ipcMain.handle('dialog:saveAs', async (e, defaultPath: string) => {
    const native = process.platform === 'win32' ? defaultPath.replace(/\//g, '\\') : defaultPath
    const r = await dialog.showSaveDialog(sender(e)!, { defaultPath: native })
    return r.canceled || !r.filePath ? null : normalize(r.filePath)
  })
  ipcMain.handle('ws:initial', () => initialWorkspace())
  ipcMain.handle('ws:pick', async (e) => {
    const w = sender(e)
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const ws = normalize(r.filePaths[0])
    saveState({ workspace: ws })
    return ws
  })

  ipcMain.handle('term:create', (e, cwd: string, cols: number, rows: number, profileId?: string) => {
    saveState({ workspace: cwd })
    const dirs = shellDirs()
    const s = settings.get()
    const profiles = resolveProfiles(dirs, s)
    const p =
      profiles.find((x) => x.id === profileId) ??
      profiles.find((x) => x.id === s.general.defaultProfile && !x.hidden) ??
      profiles.find((x) => !x.hidden) ??
      profiles[0]
    // "" starts in the tree's folder, "~" at home, anything else in that folder if it exists.
    let start = cwd
    if (p.startIn === '~') start = normalize(homedir())
    else if (p.startIn && existsSync(p.startIn) && statSync(p.startIn).isDirectory()) start = normalize(p.startIn)
    return term.createTerminal(e.sender, specFor(dirs, p), start, cols, rows, { id: p.id, name: p.name })
  })
  ipcMain.on('term:write', (_e, id: number, data: string) => term.write(id, data))
  ipcMain.on('term:ack', (_e, id: number, n: number) => term.ack(id, n))
  ipcMain.on('term:resize', (_e, id: number, c: number, r: number) => term.resize(id, c, r))
  ipcMain.on('term:kill', (_e, id: number) => term.kill(id))
  ipcMain.handle('term:attach', (e, id: number, cols: number, rows: number) => term.attachTerminal(e.sender, id, cols, rows))
  ipcMain.handle('term:handoffs', (e) => {
    const contents = e.sender
    if (!handoffWindows.has(contents.id)) {
      handoffWindows.add(contents.id)
      contents.once('destroyed', () => handoffWindows.delete(contents.id))
    }
    return waitingHandoffs.splice(0)
  })

  ipcMain.handle('fs:list', (_e, dir: string) => files.list(dir))
  ipcMain.handle('fs:read', (_e, p: string) => files.read(p))
  ipcMain.handle('fs:write', (_e, p: string, text: string) => files.write(p, text))
  ipcMain.handle('fs:stat', (_e, p: string) => files.stat(p))
  ipcMain.handle('fs:watch', (e, root: string) => files.watch(e.sender, root))
  ipcMain.handle('fs:drives', () => files.drives())
  ipcMain.handle('fs:find', (_e, root: string) => files.find(root))
  ipcMain.handle('fs:rename', (_e, a: string, b: string) => files.rename(a, b))
  ipcMain.handle('fs:trash', (_e, p: string) => shell.trashItem(p.replace(/\//g, process.platform === 'win32' ? '\\' : '/')))
  ipcMain.handle('fs:create', (_e, p: string, dir: boolean) => files.create(p, dir))
  ipcMain.on('fs:reveal', (_e, p: string) => shell.showItemInFolder(p.replace(/\//g, process.platform === 'win32' ? '\\' : '/')))
  ipcMain.on('fs:openExternal', (_e, p: string) => shell.openPath(p))

  // The renderer sends every finished command; the setting decides whether it is kept.
  ipcMain.on('history:record', (_e, r) => {
    if (settings.get().history.enabled) history.record(r)
  })
  ipcMain.handle('history:search', (_e, q) => history.search(q))
  ipcMain.handle('history:output', (_e, id: number) => history.output(id))
  ipcMain.handle('history:remove', (_e, id: number) => history.remove(id))
  ipcMain.handle('history:clear', () => history.clear())
  ipcMain.handle('settings:get', () => settings.state())
  ipcMain.handle('settings:set', (_e, path: string[], value: unknown) => settings.set(path, value))
  ipcMain.handle('settings:reset', (_e, path: string[]) => settings.reset(path))
  ipcMain.handle('settings:explain', (_e, line: string) => explainRoute(shellDirs(), line))
  ipcMain.handle('updates:get', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:setEnabled', (_e, enabled: boolean) => setAutoUpdatesEnabled(enabled))
  ipcMain.handle('updates:install', () => installUpdateNow())
  ipcMain.handle('defterm:get', () => defaultTerminalState())
  ipcMain.handle('defterm:set', (_e, enabled: boolean) => setDefaultTerminal(enabled))

  ipcMain.handle('git:status', (_e, root: string) => git.status(root))
  ipcMain.handle('git:show', (_e, p: string) => git.show(p))

  ipcMain.on('clip:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('clip:read', () => clipboard.readText())
  ipcMain.handle('dialog:confirm', async (e, message: string, detail: string, buttons: string[]) => {
    const w = sender(e)
    const r = await dialog.showMessageBox(w!, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true })
    return r.response
  })
  ipcMain.on('win:devtools', (e) => e.sender.toggleDevTools())

  // Context menus are the system's own, so they match every other app on the desktop.
  ipcMain.handle('menu:popup', (e, items: MenuItemSpec[]) => {
    const w = sender(e)
    return new Promise<string | null>((resolve) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.separator
            ? { type: 'separator' as const }
            : { label: it.label, accelerator: it.accel, registerAccelerator: false, enabled: it.enabled !== false, click: () => (picked = it.id ?? null) }
        )
      )
      menu.popup({ window: w ?? undefined, callback: () => setTimeout(() => resolve(picked), 0) })
    })
  })
}

interface MenuItemSpec {
  id?: string
  label?: string
  accel?: string
  enabled?: boolean
  separator?: boolean
}

// byndery-file://local/C:/path/img.png serves local files to the renderer, so
// Markdown images resolve against the file's own folder without opening file://
// to the page.
protocol.registerSchemesAsPrivileged([
  { scheme: 'byndery-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

app.whenReady().then(() => {
  saved = loadState()
  settings.setProfileSource((s) => resolveProfiles(shellDirs(), s))
  // The theme setting drives Chromium's prefers-color-scheme and the system dialogs.
  settings.onApply((s) => (nativeTheme.themeSource = s.general.theme))
  settings.load()
  protocol.handle('byndery-file', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    return net.fetch(pathToFileURL(p).toString())
  })
  // On Windows and Linux every shortcut is handled in the renderer; macOS still
  // needs a menu for the system copy, paste and quit commands to work.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null
  )
  registerIpc()
  startHandoffServer(receiveConsole)
  createWindow()
  startUpdater()
  refreshDefaultTerminal()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  term.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', installPendingOnQuit)
