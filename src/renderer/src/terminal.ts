import { Terminal, type IDecoration, type IMarker, type ILink, type IBufferLine } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TermInfo } from '../../shared/api'
import type { Profile, SettingsState } from '../../shared/settings'
import { findPaths } from '../../shared/links'
import { unescapeCommandLine } from '../../shared/history'

/** One id per window load; with the terminal id it names a session in the command memory. */
const RUN_ID = Math.random().toString(36).slice(2, 8)
import { basename, fromMsys, join, normalize, isWindowsPath, relativeFrom, shellQuote, toMsys } from '../../shared/paths'
import { api, Emitter, h, icon, ICON, isMac } from './bridge'
import { terminalTheme, onThemeChange } from './theme'

export interface OpenRequest {
  path: string
  line?: number
  col?: number
  dir: boolean
}

interface Mark {
  marker: IMarker
  deco?: IDecoration
  exit?: number
}

type Status = 'idle' | 'busy' | 'failed' | 'exited'

// Existence checks for link candidates are cached briefly: hovering over a
// screen of compiler output would otherwise stat the same files many times.
const statCache = new Map<string, { at: number; p: Promise<{ dir: boolean } | null> }>()
function statCached(p: string): Promise<{ dir: boolean } | null> {
  const hit = statCache.get(p)
  if (hit && performance.now() - hit.at < 4000) return hit.p
  const pr = api.fs.stat(p)
  statCache.set(p, { at: performance.now(), p: pr })
  return pr
}

/** The monospace fallbacks after a profile's own font. */
const monoFallback = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--font-mono').replace(/['"]/g, '').trim()

const familyFor = (font: string): string => [font.trim(), monoFallback()].filter(Boolean).join(', ')

// A canvas does not wait for a font the way the DOM does, so each face is
// loaded before the WebGL renderer draws its glyph atlas with it.
const loadedFonts = new Map<string, Promise<unknown>>()
function fontReady(font: string): Promise<unknown> {
  const first = font.split(',')[0].trim()
  let p = loadedFonts.get(first)
  if (!p) {
    p = Promise.all([document.fonts.load(`13px "${first}"`), document.fonts.load(`bold 13px "${first}"`)]).catch(() => undefined)
    loadedFonts.set(first, p)
  }
  return p
}

export class TermView {
  private disposed = false
  readonly el: HTMLDivElement
  readonly xterm: Terminal
  readonly tab: HTMLDivElement
  info!: TermInfo
  cwd: string
  status: Status = 'idle'
  private fit = new FitAddon()
  private marks: Mark[] = []
  /** The command in flight, between OSC 133 B and D. */
  private run: {
    promptEnd?: IMarker
    promptEndX?: number
    start?: IMarker
    startX?: number
    startedAt?: number
    cwd?: string
    command?: string
  } = {}
  private resizeTimer = 0
  private ready: Promise<void>

  /** The profile this terminal was started from. */
  profileId: string

  constructor(
    private mgr: TerminalManager,
    host: HTMLElement,
    startCwd: string,
    profileId?: string
  ) {
    this.profileId = profileId ?? mgr.defaultProfile()?.id ?? ''
    this.cwd = startCwd
    this.el = h('div', 'term')
    host.append(this.el)
    this.tab = h('div', 'tab')

    const build = api.sys.windowsBuild
    const p = mgr.profile(this.profileId)
    this.xterm = new Terminal({
      allowProposedApi: true,
      fontFamily: familyFor(p?.fontFamily ?? ''),
      fontSize: (p?.fontSize ?? 13) + mgr.zoom,
      lineHeight: p?.lineHeight ?? 1.25,
      cursorBlink: p?.cursorBlink ?? true,
      cursorStyle: p?.cursorStyle ?? 'bar',
      cursorInactiveStyle: 'outline',
      scrollback: p?.scrollback ?? 10000,
      macOptionIsMeta: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      theme: terminalTheme(p?.colorScheme),
      windowsPty: build ? { backend: 'conpty', buildNumber: build } : undefined,
      linkHandler: {
        // OSC 8 hyperlinks: file:// opens in the editor, the web in the browser.
        activate: (e, uri) => this.activateUri(e, uri),
        allowNonHttpProtocols: true
      }
    })
    this.xterm.loadAddon(this.fit)
    this.xterm.loadAddon(new Unicode11Addon())
    this.xterm.unicode.activeVersion = '11'
    this.xterm.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || e.metaKey) window.open(uri)
      })
    )
    this.xterm.open(this.el)
    // The WebGL renderer draws glyphs into a texture atlas from a canvas, and a
    // canvas does not wait for a system font the way the DOM does. Load the
    // font first, or the atlas fills with the fallback face.
    this.paintBackground()
    void fontReady(this.xterm.options.fontFamily ?? '').then(() => {
      if (this.disposed) return
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => gl.dispose())
        this.xterm.loadAddon(gl)
      } catch {
        // The DOM renderer stays in charge.
      }
    })

    this.registerShellIntegration()
    this.registerFileLinks()
    this.registerKeys()
    this.registerDrop()
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      // With "right click pastes", the menu is on Shift+right click.
      if (this.mgr.profile(this.profileId)?.rightClickPastes && !e.shiftKey) {
        void api.clipboard.read().then((t) => t && this.xterm.paste(t))
        return
      }
      void this.contextMenu()
    })
    this.xterm.onSelectionChange(() => {
      if (this.mgr.profile(this.profileId)?.copyOnSelect && this.xterm.hasSelection()) api.clipboard.write(this.xterm.getSelection())
    })
    this.xterm.textarea?.addEventListener('focus', () => mgr.setActive(this))

    this.fit.fit()
    this.ready = api.term.create(startCwd, this.xterm.cols, this.xterm.rows, profileId).then((info) => {
      this.info = info
      if (info.profile !== this.profileId) {
        this.profileId = info.profile
        this.applySettings()
      }
      mgr.byId.set(info.id, this)
      this.xterm.onData((d) => {
        if (this.jumpLine != null) this.clearJump()
        api.term.write(info.id, d)
      })
      this.xterm.onBinary((d) => api.term.write(info.id, d))
      this.renderTab()
    })
    new ResizeObserver(() => this.scheduleFit()).observe(this.el)
  }

  write(data: string): void {
    this.xterm.write(data, () => api.term.ack(this.info.id, data.length))
  }

  async send(text: string): Promise<void> {
    await this.ready
    this.xterm.paste(text)
  }

  focus(): void {
    this.xterm.focus()
  }

  applyTheme(): void {
    this.xterm.options.theme = terminalTheme(this.mgr.profile(this.profileId)?.colorScheme)
    this.paintBackground()
  }

  /** The padding around the grid takes the scheme's background too. */
  private paintBackground(): void {
    const bg = this.xterm.options.theme?.background
    if (bg) this.el.style.setProperty('--term-bg', bg)
  }

  /** Applies the profile's current settings; called when settings change. */
  applySettings(): void {
    const p = this.mgr.profile(this.profileId)
    if (!p) return
    const o = this.xterm.options
    const family = familyFor(p.fontFamily)
    const size = Math.max(6, p.fontSize + this.mgr.zoom)
    const set = (): void => {
      if (this.disposed) return
      if (o.fontFamily !== family) o.fontFamily = family
      if (o.fontSize !== size) o.fontSize = size
      if (o.lineHeight !== p.lineHeight) o.lineHeight = p.lineHeight
      const weight = p.fontWeight as Terminal['options']['fontWeight']
      if (o.fontWeight !== weight) o.fontWeight = weight
      if (o.cursorStyle !== p.cursorStyle) o.cursorStyle = p.cursorStyle
      if (o.cursorBlink !== p.cursorBlink && this.status !== 'exited') o.cursorBlink = p.cursorBlink
      if (o.scrollback !== p.scrollback) o.scrollback = p.scrollback
      this.applyTheme()
      this.scheduleFit()
    }
    if (o.fontFamily !== family) void fontReady(family).then(set)
    else set()
  }

  exited(code: number): void {
    this.status = 'exited'
    this.xterm.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`)
    this.xterm.options.cursorBlink = false
    this.renderTab()
  }

  dispose(): void {
    this.disposed = true
    if (this.info) api.term.kill(this.info.id)
    this.xterm.dispose()
    this.el.remove()
    this.tab.remove()
  }

  /** Paths are pasted relative to the shell's folder when they are near it, MSYS-style for Git Bash. */
  pathForShell(p: string): string {
    const rel = relativeFrom(this.cwd, p)
    if (rel) return shellQuote(rel)
    return shellQuote(this.info?.msys ? toMsys(p) : p)
  }

  scheduleFit(): void {
    // ConPTY repaints the whole screen on every resize, so a drag of the sash
    // is collapsed into one resize at the end.
    clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      if (!this.el.classList.contains('active') || this.el.clientWidth === 0) return
      this.fit.fit()
      if (this.info) api.term.resize(this.info.id, this.xterm.cols, this.xterm.rows)
    }, 40)
  }

  renderTab(): void {
    this.tab.replaceChildren()
    const status = h('span', `status ${this.status}`)
    const label = h('span', 'label', this.info ? basename(this.cwd) || this.cwd : '…')
    const meta = h('span', 'meta', this.info?.shell ?? '')
    const close = h('button', 'close')
    close.append(icon(ICON.close))
    close.title = 'Close terminal'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.mgr.close(this)
    })
    this.tab.title = this.cwd
    this.tab.append(status, label, meta, close)
  }

  private setStatus(s: Status): void {
    if (this.status === s) return
    this.status = s
    this.renderTab()
  }

  private registerShellIntegration(): void {
    const x = this.xterm
    // OSC 7: the shell's working directory, as file://host/path.
    x.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data)
      if (!m) return false
      let p = m[1]
      try {
        if (/%[0-9a-f]{2}/i.test(p)) p = decodeURIComponent(p)
      } catch {
        // Not percent-encoded after all.
      }
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      const cwd = this.info?.msys ? fromMsys(p, this.info.msys) : normalize(p)
      if (cwd !== this.cwd) {
        this.cwd = cwd
        this.renderTab()
        this.mgr.cwdChanged.emit(this)
      }
      return true
    })
    // OSC 133: A prompt start, B command start, C output start, D;code finished.
    x.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';')
      if (kind === 'A') {
        // A prompt redraw can send A again for the same line; keep one mark per prompt.
        const last = this.marks[this.marks.length - 1]
        const line = x.buffer.active.baseY + x.buffer.active.cursorY
        if (last && !last.marker.isDisposed && last.marker.line === line && last.exit === undefined) return true
        const marker = x.registerMarker(0)
        if (marker) this.marks.push({ marker })
        if (this.marks.length > 2000) this.marks.splice(0, 500)
      } else if (kind === 'B') {
        // Where typing starts, so a shell that does not send 633;E still has
        // its command line read back from the screen.
        const b = x.buffer.active
        this.run = { promptEnd: x.registerMarker(0), promptEndX: b.cursorX }
      } else if (kind === 'C') {
        this.setStatus('busy')
        const b = x.buffer.active
        this.run = {
          ...this.run,
          start: x.registerMarker(0),
          startX: b.cursorX,
          startedAt: Date.now(),
          cwd: this.cwd
        }
      } else if (kind === 'D') {
        const code = Number(arg ?? 0)
        this.remember(code)
        const mark = this.marks[this.marks.length - 1]
        if (mark && !mark.marker.isDisposed) {
          mark.exit = code
          mark.deco = x.registerDecoration({ marker: mark.marker, x: 0, width: 1, layer: 'top' })
          mark.deco?.onRender((el) => {
            el.classList.add('cmd-mark', code === 0 ? 'ok' : 'fail')
            el.title = code === 0 ? '' : `Exit code ${code}`
          })
        }
        this.setStatus(code === 0 ? 'idle' : 'failed')
        this.mgr.commandFinished.emit({ term: this, code })
      }
      return true
    })
    // OSC 633;E: the command line as the shell saw it, for the command memory.
    x.parser.registerOscHandler(633, (data) => {
      if (data.startsWith('E;')) this.run = { ...this.run, command: unescapeCommandLine(data.slice(2)) }
      return true
    })
  }

  /** Text of buffer rows [from, to), with soft-wrapped rows joined to the line above. */
  private rows(from: number, to: number, firstX = 0): string {
    const b = this.xterm.buffer.active
    const out: string[] = []
    for (let i = Math.max(0, from); i < to; i++) {
      const l = b.getLine(i)
      if (!l) continue
      let s = l.translateToString(true)
      if (i === from && firstX) s = s.slice(firstX)
      if (l.isWrapped && out.length) out[out.length - 1] += s
      else out.push(s)
    }
    return out.join('\n')
  }

  /** Sends the finished command, its output and its timing to the command memory. */
  private remember(exit: number): void {
    const r = this.run
    this.run = {}
    if (!this.info || !r.start || r.startedAt == null) return
    const b = this.xterm.buffer.active
    // Shells print D at the start of the line after the output.
    const end = b.baseY + b.cursorY + (b.cursorX > 0 ? 1 : 0)
    let command = r.command
    if (command == null && r.promptEnd && !r.promptEnd.isDisposed && !r.start.isDisposed) {
      command = this.rows(r.promptEnd.line, r.start.line + (r.startX ? 1 : 0), r.promptEndX).trim()
    }
    if (!command) return
    const output = r.start.isDisposed ? '' : this.rows(r.start.line, end, r.startX).replace(/\s+$/, '')
    api.history.record({
      command,
      cwd: r.cwd ?? this.cwd,
      exit,
      startedAt: r.startedAt,
      durationMs: Date.now() - r.startedAt,
      output,
      truncated: r.start.isDisposed,
      shell: this.info.shell,
      session: this.session
    })
    r.start.dispose()
    r.promptEnd?.dispose()
  }

  /** The id the command memory files this terminal's commands under. */
  get session(): string {
    return `${RUN_ID}-${this.info?.id ?? 0}`
  }

  /** The command Ctrl+Up and Ctrl+Down have selected, by its prompt's buffer line. */
  private jumpLine: number | null = null
  private jumpDeco: IDecoration | null = null

  /**
   * Selects the previous (-1) or next (+1) command, scrolls it into view and
   * outlines it with its output, the way VS Code and iTerm2 mark commands.
   * Moving past the newest command returns to the prompt.
   */
  jumpToPrompt(dir: -1 | 1): void {
    const x = this.xterm
    const lines = this.marks.filter((m) => !m.marker.isDisposed).map((m) => m.marker.line)
    if (!lines.length) return
    // The last mark is the prompt being typed at; it is where navigation starts and ends.
    const live = lines.length - 1
    let i = this.jumpLine == null ? live : lines.indexOf(this.jumpLine)
    if (i < 0) i = live
    i = Math.max(0, i + dir)
    this.clearJump()
    if (i >= live) {
      x.scrollToBottom()
      return
    }
    const line = lines[i]
    const height = Math.max(1, Math.min(lines[i + 1] - line, x.rows))
    const b = x.buffer.active
    if (line < b.viewportY || line + height > b.viewportY + x.rows) x.scrollToLine(Math.max(0, line - 1))
    this.jumpLine = line
    const marker = x.registerMarker(line - (b.baseY + b.cursorY))
    if (!marker) return
    this.jumpDeco = x.registerDecoration({ marker, width: x.cols, height, layer: 'top' }) ?? null
    this.jumpDeco?.onRender((el) => el.classList.add('cmd-focus'))
    this.jumpDeco?.onDispose(() => marker.dispose())
  }

  private clearJump(): void {
    this.jumpDeco?.dispose()
    this.jumpDeco = null
    this.jumpLine = null
  }

  private registerFileLinks(): void {
    const x = this.xterm
    x.registerLinkProvider({
      provideLinks: (y, callback) => {
        const buf = x.buffer.active
        // Join soft-wrapped rows so a path broken across lines is still one link.
        let first = y - 1
        while (first > 0 && buf.getLine(first)?.isWrapped) first--
        let last = y - 1
        while (buf.getLine(last + 1)?.isWrapped) last++
        if (last - first > 20) return callback(undefined)
        const rows: IBufferLine[] = []
        for (let r = first; r <= last; r++) {
          const line = buf.getLine(r)
          if (line) rows.push(line)
        }
        const cols = x.cols
        const text = rows.map((l, i) => l.translateToString(i === rows.length - 1)).join('')
        const matches = findPaths(text)
        if (!matches.length) return callback(undefined)

        const at = (offset: number): { x: number; y: number } => ({
          x: (offset % cols) + 1,
          y: first + Math.floor(offset / cols) + 1
        })
        Promise.all(
          matches.map(async (m): Promise<ILink | null> => {
            const start = at(m.start)
            const end = at(m.end - 1)
            if (end.y < y || start.y > y) return null
            const abs = this.resolve(m.path)
            if (!abs) return null
            const st = await statCached(abs)
            if (!st) return null
            return {
              range: { start, end },
              text: text.slice(m.start, m.end),
              decorations: { underline: true, pointerCursor: true },
              activate: (e) => {
                if (!(e.ctrlKey || e.metaKey)) return
                this.mgr.openRequest.emit({ path: abs, line: m.line, col: m.col, dir: st.dir })
              }
            }
          })
        ).then((links) => {
          const ok = links.filter((l): l is ILink => l !== null)
          callback(ok.length ? ok : undefined)
        })
      }
    })
  }

  private resolve(p: string): string | null {
    if (p.startsWith('~/') || p.startsWith('~\\')) return join(api.sys.home, p.slice(2))
    if (isWindowsPath(p)) return normalize(p)
    if (p.startsWith('/')) return this.info?.msys ? fromMsys(p, this.info.msys) : normalize(p)
    if (p.startsWith('\\')) return null
    return join(this.cwd, p)
  }

  private activateUri(e: MouseEvent, uri: string): void {
    if (!(e.ctrlKey || e.metaKey)) return
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri)
    if (m) {
      let p = decodeURIComponent(m[1])
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      const line = /#L?(\d+)$/.exec(p)
      p = p.replace(/#.*$/, '')
      const abs = this.info?.msys ? fromMsys(p, this.info.msys) : normalize(p)
      void statCached(abs).then((st) => {
        if (st) this.mgr.openRequest.emit({ path: abs, line: line ? Number(line[1]) : undefined, dir: st.dir })
      })
    } else if (/^https?:/.test(uri)) {
      window.open(uri)
    }
  }

  private registerKeys(): void {
    const x = this.xterm
    x.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = isMac ? e.metaKey : e.ctrlKey
      // Copy when there is a selection; otherwise Ctrl+C is SIGINT. The
      // selection stays, as in VS Code: tools that read selected text send
      // their own Ctrl+C (Phevere does, half a second after a drag), and
      // clearing on copy made every selection vanish. Typing clears it.
      if (mod && !e.altKey && e.code === 'KeyC' && x.hasSelection() && (e.shiftKey || !isMac || e.metaKey)) {
        api.clipboard.write(x.getSelection())
        e.preventDefault()
        return false
      }
      // Ctrl+Insert copies and Shift+Insert pastes, as in Windows Terminal and
      // conhost. Ctrl+Insert never interrupts, which is why selection readers
      // such as Phevere send it to terminals instead of Ctrl+C.
      if (e.code === 'Insert' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (x.hasSelection()) api.clipboard.write(x.getSelection())
        e.preventDefault()
        return false
      }
      if (e.code === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        void api.clipboard.read().then((t) => t && x.paste(t))
        return false
      }
      if (e.key === 'Escape' && !mod && !e.shiftKey && !e.altKey && x.hasSelection()) {
        x.clearSelection()
        e.preventDefault()
        return false
      }
      if (mod && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void api.clipboard.read().then((t) => t && x.paste(t))
        return false
      }
      // The app's own keys are taken by the window before xterm sees them;
      // this keeps xterm from acting on any that slip through.
      if (this.mgr.claimsKey(e)) return false
      return true
    })
  }

  private registerDrop(): void {
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      this.el.classList.add('drop-target')
    })
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-target'))
    this.el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.el.classList.remove('drop-target')
      const dt = e.dataTransfer
      if (!dt) return
      const inner = dt.getData('application/x-byndery-paths')
      const paths: string[] = inner
        ? JSON.parse(inner)
        : [...dt.files].map((f) => api.fs.pathForFile(f)).filter(Boolean)
      if (!paths.length) return
      void this.send(paths.map((p) => this.pathForShell(normalize(p))).join(' ') + ' ')
      this.focus()
    })
  }

  private async contextMenu(): Promise<void> {
    const x = this.xterm
    const sel = x.hasSelection()
    const id = await api.menu([
      { id: 'copy', label: 'Copy', accel: 'CmdOrCtrl+C', enabled: sel },
      { id: 'paste', label: 'Paste', accel: 'CmdOrCtrl+V' },
      { separator: true },
      { id: 'all', label: 'Select All' },
      { id: 'clear', label: 'Clear' },
      { separator: true },
      { id: 'new', label: 'New Terminal', accel: 'CmdOrCtrl+T' },
      { id: 'kill', label: 'Close Terminal', accel: 'CmdOrCtrl+W' }
    ])
    if (id === 'copy') api.clipboard.write(x.getSelection())
    else if (id === 'paste') void api.clipboard.read().then((t) => t && x.paste(t))
    else if (id === 'all') x.selectAll()
    else if (id === 'clear') x.clear()
    else if (id === 'new') this.mgr.create()
    else if (id === 'kill') this.mgr.close(this)
    this.focus()
  }
}

export class TerminalManager {
  readonly byId = new Map<number, TermView>()
  readonly views: TermView[] = []
  active: TermView | null = null
  readonly cwdChanged = new Emitter<TermView>()
  readonly openRequest = new Emitter<OpenRequest>()
  readonly commandFinished = new Emitter<{ term: TermView; code: number }>()
  readonly activeChanged = new Emitter<TermView | null>()
  root = ''
  /** Ctrl+= and Ctrl+-: points added to every profile's font size, for this window. */
  zoom = 0
  settings: SettingsState | null = null
  /** Set by the app: true for keys that belong to an app action rather than the shell. */
  claimsKey: (e: KeyboardEvent) => boolean = () => false

  constructor(
    private host: HTMLElement,
    private tabs: HTMLElement
  ) {
    api.term.onData((id, data) => this.byId.get(id)?.write(data))
    api.term.onExit((id, code) => {
      const v = this.byId.get(id)
      if (!v) return
      this.byId.delete(id)
      // A shell closed with `exit` closes its tab; one that died stays to show why.
      if (code === 0) this.close(v)
      else v.exited(code)
    })
    onThemeChange(() => this.views.forEach((v) => v.applyTheme()))
  }

  profile(id: string): Profile | undefined {
    return this.settings?.profiles.find((p) => p.id === id) ?? this.defaultProfile()
  }

  /** The profile new terminals start from. */
  defaultProfile(): Profile | undefined {
    const s = this.settings
    if (!s) return undefined
    const visible = s.profiles.filter((p) => !p.hidden)
    return visible.find((p) => p.id === s.effective.general.defaultProfile) ?? visible[0] ?? s.profiles[0]
  }

  /** New settings: every open terminal takes its profile's values. */
  applySettings(s: SettingsState): void {
    this.settings = s
    for (const v of this.views) v.applySettings()
  }

  create(cwd?: string, profileId?: string): TermView {
    const v = new TermView(this, this.host, cwd ?? this.active?.cwd ?? this.root, profileId)
    this.views.push(v)
    v.tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.close(v)
      }
    })
    v.tab.addEventListener('click', () => {
      this.setActive(v)
      v.focus()
    })
    v.renderTab()
    this.tabs.append(v.tab)
    this.setActive(v)
    v.focus()
    return v
  }

  setActive(v: TermView): void {
    if (this.active === v) return
    this.active?.el.classList.remove('active')
    this.active?.tab.classList.remove('active')
    this.active = v
    v.el.classList.add('active')
    v.tab.classList.add('active')
    v.scheduleFit()
    this.activeChanged.emit(v)
    this.cwdChanged.emit(v)
  }

  close(v: TermView): void {
    const i = this.views.indexOf(v)
    if (i < 0) return
    this.views.splice(i, 1)
    if (v.info) this.byId.delete(v.info.id)
    v.dispose()
    if (this.active === v) {
      this.active = null
      const next = this.views[Math.min(i, this.views.length - 1)]
      if (next) {
        this.setActive(next)
        next.focus()
      } else {
        this.activeChanged.emit(null)
      }
    }
  }

  cycle(dir: 1 | -1): void {
    if (!this.active || this.views.length < 2) return
    const i = this.views.indexOf(this.active)
    const next = this.views[(i + dir + this.views.length) % this.views.length]
    this.setActive(next)
    next.focus()
  }

  refit(): void {
    this.active?.scheduleFit()
  }
}
