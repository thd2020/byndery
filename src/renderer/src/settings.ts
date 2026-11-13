import {
  SYSTEMS,
  SYSTEM_NAMES,
  getPath,
  SHELL_PLUGINS,
  type Profile,
  type SettingsState,
  type SystemId,
  type TerminalSettings
} from '../../shared/settings'
import type { DefaultTerminalState, ToolsStatus, UpdateState } from '../../shared/api'
import { api, Emitter, h } from './bridge'
import { chordOf, keyLabel, normalizeChord, type Keymap } from './keymap'
import { SCHEMES } from './theme'

/**
 * The settings window, laid out the way Windows Terminal and Konsole lay
 * theirs out: pages in a sidebar, terminal settings in profiles that inherit
 * from Profile defaults, and a reset button beside every value a layer
 * overrides. Every change is written to settings.json at once and applies to
 * open terminals; the file itself opens in the editor.
 */

type Path = string[]
type Choice = [value: string, label: string]

interface FieldSpec {
  label: string
  /** One line under the label, for a consequence the label cannot carry. */
  hint?: string
  path: Path
  control: 'toggle' | 'select' | 'number' | 'text'
  choices?: Choice[] | (() => Choice[])
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** Shown instead of the stored value, e.g. arguments as one line. */
  format?: (v: unknown) => string
  parse?: (s: string) => unknown
}

const PROFILE_FIELDS: { group: string; fields: (Omit<FieldSpec, 'path'> & { key: keyof TerminalSettings })[] }[] = [
  {
    group: 'Text',
    fields: [
      { key: 'fontFamily', label: 'Font', control: 'text', placeholder: 'MesloLGS NF' },
      { key: 'fontSize', label: 'Size', control: 'number', min: 8, max: 32, step: 1 },
      { key: 'lineHeight', label: 'Line height', control: 'number', min: 1, max: 2, step: 0.05 },
      {
        key: 'fontWeight',
        label: 'Weight',
        control: 'select',
        choices: [
          ['300', 'Light'],
          ['400', 'Regular'],
          ['500', 'Medium'],
          ['600', 'Semibold']
        ],
        parse: Number
      },
      { key: 'colorScheme', label: 'Color scheme', control: 'select', choices: () => SCHEMES.map((s) => [s, s === 'byndery' ? 'byndery (follows the theme)' : s]) }
    ]
  },
  {
    group: 'Cursor',
    fields: [
      {
        key: 'cursorStyle',
        label: 'Shape',
        control: 'select',
        choices: [
          ['bar', 'Bar'],
          ['block', 'Block'],
          ['underline', 'Underline']
        ]
      },
      { key: 'cursorBlink', label: 'Blink', control: 'toggle' }
    ]
  },
  {
    group: 'Behaviour',
    fields: [
      { key: 'scrollback', label: 'Scrollback lines', control: 'number', min: 0, max: 200000, step: 1000 },
      { key: 'copyOnSelect', label: 'Copy on select', control: 'toggle' },
      { key: 'rightClickPastes', label: 'Right click pastes', hint: 'The menu is then on Shift+right click.', control: 'toggle' }
    ]
  },
  {
    group: 'Prompt',
    fields: [
      {
        key: 'promptStyle',
        label: 'zsh prompt',
        hint: 'Applies to new terminals.',
        control: 'select',
        choices: [
          ['rainbow', 'Powerlevel10k rainbow'],
          ['lean', 'Powerlevel10k lean'],
          ['own', 'My own prompt']
        ]
      }
    ]
  }
]

type Page = { id: string; label: string; indent?: boolean }

const wrap = (child: HTMLElement): HTMLElement => {
  const c = h('div', 'settings-control')
  c.append(child)
  return c
}

export class SettingsSheet {
  private el = h('div', 'settings')
  private nav = h('nav', 'settings-nav')
  private body = h('div', 'settings-body')
  private state: SettingsState | null = null
  private updateState: UpdateState | null = null
  private defaultTerminal: DefaultTerminalState | null = null
  private page = 'general'
  private restoreFocus: HTMLElement | null = null
  private recording: string | null = null
  private keyFilter = ''
  private explainSeq = 0
  /** The user asked to see settings.json. */
  readonly openFile = new Emitter<string>()
  /** A command to run in a new terminal tab (Settings > Tools). */
  readonly runInTerminal = new Emitter<string>()
  private tools: ToolsStatus | null = null
  private toolsBusy: string | null = null

  constructor(private keymap: Keymap) {
    this.el.hidden = true
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'Settings')
    // Keys typed here belong to the settings, not to the window's shortcuts.
    this.el.dataset.ownKeys = ''
    const close = h('button', 'icon-btn settings-close')
    close.title = 'Close (Esc)'
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
    close.addEventListener('click', () => this.close())
    this.el.append(this.nav, this.body, close)
    this.el.tabIndex = -1
    document.body.append(this.el)
    // On the document, so Escape works even when a re-render took focus away.
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return
      if (this.recording) return this.record(e)
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        this.close()
      }
    })
    api.settings.onChange((s) => {
      this.state = s
      if (this.isOpen) this.render()
    })
    api.updates.onChange((s) => {
      this.updateState = s
      if (this.isOpen && this.page === 'updates') this.render()
    })
    api.tools.onProgress((f) => {
      if (!this.toolsBusy) return
      this.toolsBusy = `Repairing… ${Math.round(f * 100)}%`
      if (this.isOpen && this.page === 'tools') this.render()
    })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  async open(page?: string): Promise<void> {
    if (!this.isOpen) this.restoreFocus = document.activeElement as HTMLElement | null
    const [settings, updates, defaultTerminal] = await Promise.all([
      api.settings.get(),
      api.updates.get(),
      api.platform === 'win32' ? api.defaultTerminal.get() : Promise.resolve(null)
    ])
    this.state = settings
    this.updateState = updates
    this.defaultTerminal = defaultTerminal
    this.tools = null
    if (page) this.page = page
    this.el.hidden = false
    this.render()
    ;(this.nav.querySelector('.active') as HTMLElement | null)?.focus()
  }

  close(): void {
    if (this.el.hidden) return
    this.recording = null
    this.el.hidden = true
    this.restoreFocus?.focus()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else void this.open()
  }

  // Layout

  private pages(): Page[] {
    const s = this.state!
    const pages: Page[] = [{ id: 'general', label: 'General' }, { id: 'updates', label: 'Updates' }, { id: 'defaults', label: 'Profile defaults' }]
    for (const p of s.profiles) pages.push({ id: `profile:${p.id}`, label: p.name, indent: true })
    if (s.profiles.some((p) => p.routes)) pages.push({ id: 'commands', label: 'Commands' })
    pages.push({ id: 'shell', label: 'Shell' })
    if (api.platform === 'win32') pages.push({ id: 'tools', label: 'Tools' })
    pages.push({ id: 'files', label: 'Files' }, { id: 'editor', label: 'Editor' }, { id: 'keys', label: 'Keyboard' }, { id: 'history', label: 'Command history' })
    return pages
  }

  private render(): void {
    const s = this.state
    if (!s) return
    // Re-rendering replaces the controls; keep focus on the one that changed.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.focusKey
    const pages = this.pages()
    if (!pages.some((p) => p.id === this.page)) this.page = 'general'

    this.nav.replaceChildren()
    this.nav.append(h('div', 'settings-title', 'Settings'))
    for (const p of pages) {
      const b = h('button', `settings-nav-item${p.indent ? ' indent' : ''}${p.id === this.page ? ' active' : ''}`, p.label)
      b.dataset.focusKey = `nav:${p.id}`
      b.addEventListener('click', () => {
        this.page = p.id
        this.render()
        this.body.scrollTop = 0
      })
      this.nav.append(b)
    }
    const add = h('button', 'settings-nav-item indent subtle', 'Add profile')
    add.addEventListener('click', () => void this.addProfile())
    const lastProfile = [...this.nav.querySelectorAll('.settings-nav-item.indent')].pop()
    lastProfile?.after(add)
    const json = h('button', 'settings-nav-item subtle json', 'Open settings.json')
    json.addEventListener('click', () => {
      this.close()
      this.openFile.emit(s.file)
    })
    this.nav.append(h('span', 'spacer'), json)

    this.body.replaceChildren()
    if (s.error) {
      const banner = h('div', 'settings-error')
      banner.append(h('span', '', `${s.error}. The last settings that could be read are in force.`))
      const open = h('button', 'text-btn', 'Open settings.json')
      open.addEventListener('click', () => {
        this.close()
        this.openFile.emit(s.file)
      })
      banner.append(open)
      this.body.append(banner)
    }
    const page = this.page
    if (page === 'general') this.renderGeneral()
    else if (page === 'updates') this.renderUpdates()
    else if (page === 'defaults') this.renderDefaults()
    else if (page.startsWith('profile:')) this.renderProfile(page.slice(8))
    else if (page === 'commands') this.renderCommands()
    else if (page === 'shell') this.renderShell()
    else if (page === 'tools') this.renderTools()
    else if (page === 'files') this.renderFiles()
    else if (page === 'editor') this.renderEditor()
    else if (page === 'keys') this.renderKeys()
    else if (page === 'history') this.renderHistory()
    const again = focused ? (this.el.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`) as HTMLElement | null) : null
    if (again) again.focus()
    else if (!this.el.contains(document.activeElement)) this.el.focus()
  }

  private heading(text: string): void {
    this.body.append(h('h2', 'settings-h', text))
  }

  private group(title?: string): HTMLElement {
    const g = h('section', 'settings-group')
    if (title) g.append(h('h3', '', title))
    this.body.append(g)
    return g
  }

  // Fields

  private value(path: Path): unknown {
    const s = this.state!
    if (path[0] === 'profiles') {
      const p = s.profiles.find((x) => x.id === path[1])
      return p ? (p as unknown as Record<string, unknown>)[path[2]] : undefined
    }
    return getPath(s.effective, path)
  }

  private overridden(path: Path): boolean {
    return getPath(this.state!.user, path) !== undefined
  }

  private set(path: Path, value: unknown): void {
    void api.settings.set(path, value).then((s) => {
      this.state = s
      this.render()
    })
  }

  private reset(path: Path): void {
    void api.settings.reset(path).then((s) => {
      this.state = s
      this.render()
    })
  }

  private field(parent: HTMLElement, f: FieldSpec, resetTitle = 'Reset to default'): void {
    const row = h('div', 'settings-row')
    const text = h('div', 'settings-label')
    const id = `f-${f.path.join('-')}`
    const label = h('label', '', f.label)
    label.htmlFor = id
    text.append(label)
    if (f.hint) text.append(h('div', 'settings-hint', f.hint))
    const v = this.value(f.path)
    let control: HTMLElement
    if (f.control === 'toggle') {
      const input = h('input', 'switch')
      input.type = 'checkbox'
      input.checked = !!v
      input.addEventListener('change', () => this.set(f.path, input.checked))
      control = input
    } else if (f.control === 'select') {
      const sel = h('select', 'settings-select')
      const choices = typeof f.choices === 'function' ? f.choices() : (f.choices ?? [])
      for (const [val, lab] of choices) {
        const o = h('option', '', lab)
        o.value = val
        sel.append(o)
      }
      sel.value = String(v ?? '')
      sel.addEventListener('change', () => this.set(f.path, f.parse ? f.parse(sel.value) : sel.value))
      control = sel
    } else {
      const input = h('input', 'settings-input')
      input.type = f.control === 'number' ? 'number' : 'text'
      if (f.min != null) input.min = String(f.min)
      if (f.max != null) input.max = String(f.max)
      if (f.step != null) input.step = String(f.step)
      input.placeholder = f.placeholder ?? ''
      input.spellcheck = false
      input.value = f.format ? f.format(v) : String(v ?? '')
      const commit = (): void => {
        let out: unknown = f.parse ? f.parse(input.value) : input.value
        if (f.control === 'number') {
          const n = Number(input.value)
          if (!Number.isFinite(n)) return void (input.value = String(v ?? ''))
          out = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n))
        }
        if (JSON.stringify(out) !== JSON.stringify(v)) this.set(f.path, out)
      }
      input.addEventListener('change', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit()
      })
      control = input
    }
    control.id = id
    control.dataset.focusKey = id
    const reset = h('button', 'settings-reset')
    reset.title = resetTitle
    reset.setAttribute('aria-label', `${resetTitle}: ${f.label}`)
    reset.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5a4.8 4.8 0 1 1 .9 4.6"/><path d="M3.2 3.3v3.4h3.4"/></svg>'
    reset.style.visibility = this.overridden(f.path) ? 'visible' : 'hidden'
    reset.addEventListener('click', () => this.reset(f.path))
    row.append(text, wrap(control), reset)
    parent.append(row)
  }

  // Pages

  private renderGeneral(): void {
    const s = this.state!
    this.heading('General')
    const g = this.group()
    this.field(g, {
      label: 'Theme',
      path: ['general', 'theme'],
      control: 'select',
      choices: [
        ['system', 'Same as the system'],
        ['light', 'Light'],
        ['dark', 'Dark']
      ]
    })
    const visible = s.profiles.filter((p) => !p.hidden)
    this.field(g, {
      label: 'Default profile',
      path: ['general', 'defaultProfile'],
      control: 'select',
      choices: [['', visible[0] ? `${visible[0].name} (first in the list)` : 'First in the list'], ...visible.map((p): Choice => [p.id, p.name])]
    })
    this.field(g, { label: 'Ask before closing a terminal that is running a command', path: ['general', 'confirmClose'], control: 'toggle' })
    if (api.platform === 'win32') this.renderDefaultTerminal()
  }

  /** Windows only: byndery in place of the PowerShell and Command Prompt windows Windows opens. */
  private renderDefaultTerminal(): void {
    const d = this.defaultTerminal
    const g = this.group('Default terminal')
    const row = h('div', 'settings-row')
    row.style.gridTemplateColumns = 'minmax(0, 1fr) auto'
    const text = h('div', 'settings-label')
    const label = h('label', '', 'Open console programs in byndery')
    label.htmlFor = 'default-terminal'
    let hint = 'PowerShell, Command Prompt and other console programs started from Start, Explorer or Run open as byndery tabs instead of console windows.'
    if (!d?.available) hint = 'Available in the installed app.'
    else if (!d.supported) hint = 'Needs Windows 11 22H2 or later.'
    else if (!d.terminalProxy) hint += ' Windows hands consoles over through Windows Terminal, which needs to be installed.'
    text.append(label, h('div', 'settings-hint', hint))
    const toggle = h('input', 'switch')
    toggle.type = 'checkbox'
    toggle.id = 'default-terminal'
    toggle.dataset.focusKey = 'default-terminal'
    toggle.checked = !!d?.enabled
    toggle.disabled = !d?.available || !d.supported
    toggle.addEventListener('change', () => {
      toggle.disabled = true
      void api.defaultTerminal.set(toggle.checked).then((state) => {
        this.defaultTerminal = state
        this.render()
      })
    })
    row.append(text, wrap(toggle))
    g.append(row)
    if (d?.error) g.append(h('div', 'settings-hint warn', d.error))
  }

  private renderUpdates(): void {
    const u = this.updateState
    this.heading('Updates')
    const g = this.group()

    if (u?.supportsAutoUpdate) {
      const row = h('div', 'settings-row')
      row.style.gridTemplateColumns = 'minmax(0, 1fr) auto'
      const text = h('div', 'settings-label')
      const label = h('label', '', 'Automatically install updates')
      label.htmlFor = 'auto-updates'
      text.append(label, h('div', 'settings-hint', 'Download updates in the background and install them when you close byndery.'))
      const toggle = h('input', 'switch')
      toggle.type = 'checkbox'
      toggle.id = 'auto-updates'
      toggle.checked = u.autoEnabled
      toggle.addEventListener('change', () => void api.updates.setEnabled(toggle.checked))
      row.append(text, wrap(toggle))
      g.append(row)
    } else if (u?.canCheck) {
      g.append(h('div', 'settings-hint group-hint', 'This installer needs manual updates.'))
    } else {
      g.append(h('div', 'settings-hint group-hint', 'Update checks are available in the installed app.'))
    }

    if (u) {
      let status = `byndery ${u.currentVersion}.`
      if (u.status === 'checking') status = 'Checking for updates…'
      else if (u.status === 'downloading') status = `Downloading version ${u.availableVersion ?? ''}: ${Math.round(u.progress * 100)}%.`
      else if (u.status === 'ready') status = u.autoEnabled ? `Version ${u.availableVersion} will install when you close byndery.` : `Version ${u.availableVersion} is ready to install.`
      else if (u.status === 'error') status = `Update failed: ${u.error ?? 'Unknown error.'}`
      else if (u.availableVersion) status = `Version ${u.availableVersion} is available.`
      g.append(h('div', u.status === 'error' ? 'settings-hint warn' : 'settings-hint group-hint', status))

      const actions = h('div', 'settings-actions')
      const check = h('button', 'text-btn', 'Check for updates')
      check.disabled = !u.canCheck || u.status === 'checking' || u.status === 'downloading'
      check.addEventListener('click', () => void api.updates.check())
      actions.append(check)

      if (u.availableVersion && u.releasePage) {
        const action = h('button', 'text-btn', u.installSupported ? (u.canInstall ? 'Install now' : 'Download and install') : 'Open release page')
        action.disabled = u.status === 'checking' || u.status === 'downloading'
        action.addEventListener('click', () => void api.updates.install())
        actions.append(action)
      }
      g.append(actions)
    }
  }

  private renderDefaults(): void {
    this.heading('Profile defaults')
    for (const g of PROFILE_FIELDS) {
      const el = this.group(g.group)
      for (const f of g.fields) this.field(el, { ...f, path: ['profileDefaults', f.key] })
    }
  }

  private renderProfile(id: string): void {
    const p = this.state!.profiles.find((x) => x.id === id)
    if (!p) return
    this.heading(p.name)
    const top = this.group()
    const base = (key: string): Path => ['profiles', id, key]
    this.field(top, { label: 'Name', path: base('name'), control: 'text' })
    this.field(top, {
      label: 'Command',
      path: base('command'),
      control: 'text',
      placeholder: p.detected ? p.program.replace(/\//g, api.platform === 'win32' ? '\\' : '/') : 'Path to a program',
      hint: p.routes && p.command ? 'byndery’s prompt and command routing only run with the bundled zsh.' : undefined
    })
    this.field(top, {
      label: 'Arguments',
      path: base('args'),
      control: 'text',
      format: (v) => (Array.isArray(v) ? v.join(' ') : ''),
      parse: (t) => t.split(/\s+/).filter(Boolean)
    })
    this.field(top, {
      label: 'Start in',
      path: base('startIn'),
      control: 'text',
      placeholder: 'The file tree’s folder',
      hint: 'A folder path, or ~ for your home folder.'
    })
    this.field(top, { label: 'Hide from the new terminal menu', path: base('hidden'), control: 'toggle' })
    for (const g of PROFILE_FIELDS) {
      if (g.group === 'Prompt' && !/zsh/i.test(p.program || p.id)) continue
      const el = this.group(g.group)
      for (const f of g.fields) this.field(el, { ...f, path: base(f.key) }, 'Reset to the profile default')
    }
    const actions = this.group()
    const row = h('div', 'settings-actions')
    const dup = h('button', 'text-btn', 'Duplicate')
    dup.addEventListener('click', () => void this.addProfile(p))
    row.append(dup)
    if (!p.detected) {
      const del = h('button', 'text-btn danger', 'Delete profile')
      del.addEventListener('click', async () => {
        if ((await api.confirm(`Delete the profile “${p.name}”?`, 'Terminals already open from it stay open.', ['Delete', 'Cancel'])) !== 0) return
        this.page = 'defaults'
        this.reset(['profiles', id])
      })
      row.append(del)
    }
    actions.append(row)
  }

  private async addProfile(from?: Profile): Promise<void> {
    const ids = new Set(this.state!.profiles.map((p) => p.id))
    let n = 1
    while (ids.has(`profile-${n}`)) n++
    const id = `profile-${n}`
    const entry: Record<string, unknown> = from
      ? { name: `${from.name} copy`, command: from.program, args: from.args, startIn: from.startIn, env: from.env }
      : { name: 'New profile', command: api.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }
    this.page = `profile:${id}`
    this.state = await api.settings.set(['profiles', id], entry)
    this.render()
  }

  private renderCommands(): void {
    const s = this.state!
    const r = s.effective.commands
    this.heading('Commands')

    // 1. Prefixes and the systems, in priority order.
    const sys = this.group('Systems')
    sys.append(h('div', 'settings-hint group-hint', 'When a name exists in more than one, the higher one runs it. A prefix sends a line to its system even when that system is off.'))
    const list = h('ol', 'route-list')
    const on = SYSTEMS.filter((x) => r.enabled[x]).length
    r.order.forEach((id, i) => {
      const li = h('li', `route-item${r.enabled[id] ? '' : ' off'}`)
      li.draggable = true
      li.dataset.sys = id
      const grip = h('span', 'route-grip')
      grip.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>'
      const rank = h('span', 'route-rank', String(i + 1))
      const toggle = h('input', 'switch')
      toggle.type = 'checkbox'
      toggle.checked = r.enabled[id]
      // One system has to take plain lines.
      toggle.disabled = r.enabled[id] && on === 1
      toggle.dataset.focusKey = `route-on-${id}`
      toggle.setAttribute('aria-label', `Use ${SYSTEM_NAMES[id]}`)
      toggle.addEventListener('change', () => this.set(['commands', 'enabled', id], toggle.checked))
      const name = h('span', 'route-name', SYSTEM_NAMES[id])
      const prefix = h('input', 'settings-input route-prefix')
      prefix.value = r.prefixes[id] ?? ''
      prefix.placeholder = 'No prefix'
      prefix.spellcheck = false
      prefix.dataset.focusKey = `route-prefix-${id}`
      prefix.setAttribute('aria-label', `${SYSTEM_NAMES[id]} prefix`)
      prefix.addEventListener('change', () => this.set(['commands', 'prefixes', id], prefix.value.trim()))
      const move = (d: -1 | 1): void => {
        const order = [...r.order]
        const j = i + d
        if (j < 0 || j >= order.length) return
        ;[order[i], order[j]] = [order[j], order[i]]
        this.set(['commands', 'order'], order)
      }
      const up = h('button', 'icon-btn')
      up.title = 'Move up'
      up.disabled = i === 0
      up.dataset.focusKey = `route-up-${id}`
      up.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 9.5 8 6l3.5 3.5"/></svg>'
      up.addEventListener('click', () => move(-1))
      const down = h('button', 'icon-btn')
      down.title = 'Move down'
      down.disabled = i === r.order.length - 1
      down.dataset.focusKey = `route-down-${id}`
      down.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>'
      down.addEventListener('click', () => move(1))
      li.append(grip, rank, toggle, name, prefix, up, down)
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/x-route', id)
        li.classList.add('dragging')
      })
      li.addEventListener('dragend', () => li.classList.remove('dragging'))
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('text/x-route')) return
        e.preventDefault()
        li.classList.add('drop')
      })
      li.addEventListener('dragleave', () => li.classList.remove('drop'))
      li.addEventListener('drop', (e) => {
        li.classList.remove('drop')
        const from = e.dataTransfer?.getData('text/x-route') as SystemId | undefined
        if (!from || from === id) return
        e.preventDefault()
        const order = r.order.filter((x) => x !== from)
        order.splice(order.indexOf(id), 0, from)
        this.set(['commands', 'order'], order)
      })
      list.append(li)
    })
    sys.append(list)
    const resetOrder = h('div', 'settings-actions')
    if (this.overridden(['commands', 'order']) || this.overridden(['commands', 'enabled']) || this.overridden(['commands', 'prefixes'])) {
      const b = h('button', 'text-btn', 'Reset systems to default')
      b.addEventListener('click', async () => {
        await api.settings.reset(['commands', 'order'])
        await api.settings.reset(['commands', 'enabled'])
        this.reset(['commands', 'prefixes'])
      })
      resetOrder.append(b)
      sys.append(resetOrder)
    }

    // 2. Syntax.
    const syn = this.group('Syntax')
    this.field(syn, {
      label: 'PowerShell syntax runs in PowerShell',
      hint: '$env:NAME, $x = 1, [Type]::Member and Verb-Noun cmdlets, whatever the order above.',
      path: ['commands', 'powershellSyntax'],
      control: 'toggle'
    })

    // 3. Names pinned to a system.
    const pins = this.group('Always run in')
    pins.append(h('div', 'settings-hint group-hint', 'A command name here skips the order and goes to its system.'))
    const table = h('div', 'pin-table')
    const systemSelect = (value: SystemId, onChange: (v: SystemId) => void, key: string): HTMLSelectElement => {
      const sel = h('select', 'settings-select')
      for (const x of SYSTEMS) {
        const o = h('option', '', SYSTEM_NAMES[x])
        o.value = x
        sel.append(o)
      }
      sel.value = value
      sel.dataset.focusKey = key
      sel.addEventListener('change', () => onChange(sel.value as SystemId))
      return sel
    }
    const pinsNow = Object.entries(r.overrides).sort(([a], [b]) => a.localeCompare(b))
    for (const [name, target] of pinsNow) {
      const row = h('div', 'pin-row')
      row.append(
        h('code', 'pin-name', name),
        systemSelect(target, (v) => this.set(['commands', 'overrides', name], v), `pin-${name}`)
      )
      const rm = h('button', 'icon-btn')
      rm.title = `Remove ${name}`
      rm.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>'
      rm.addEventListener('click', () => {
        const next = { ...r.overrides }
        delete next[name]
        this.set(['commands', 'overrides'], next)
      })
      row.append(rm)
      table.append(row)
    }
    const add = h('div', 'pin-row add')
    const nameIn = h('input', 'settings-input')
    nameIn.placeholder = 'Command name'
    nameIn.spellcheck = false
    nameIn.dataset.focusKey = 'pin-new'
    let target: SystemId = 'cmd'
    const sel = systemSelect(target, (v) => (target = v), 'pin-new-system')
    const addBtn = h('button', 'text-btn', 'Add')
    const commit = (): void => {
      const n = nameIn.value.trim().toLowerCase()
      if (!/^[\w.+-]+$/.test(n)) return nameIn.focus()
      this.set(['commands', 'overrides'], { ...r.overrides, [n]: target })
    }
    addBtn.addEventListener('click', commit)
    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
    })
    add.append(nameIn, sel, addBtn)
    table.append(add)
    pins.append(table)

    // 4. Try it: the shell's own answer.
    const tryIt = this.group('Try a line')
    const input = h('input', 'settings-input wide')
    input.placeholder = 'Get-ChildItem | Sort-Object Length'
    input.spellcheck = false
    input.dataset.focusKey = 'route-try'
    const out = h('div', 'route-result')
    let timer = 0
    input.addEventListener('input', () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void this.explain(input.value, out), 250)
    })
    tryIt.append(input, out)
  }

  private async explain(line: string, out: HTMLElement): Promise<void> {
    const seq = ++this.explainSeq
    if (!line.trim()) return void out.replaceChildren()
    const r = await api.settings.explain(line)
    if (seq !== this.explainSeq) return
    if (!r) return void out.replaceChildren(h('span', 'settings-hint', 'The bundled zsh is not installed.'))
    const names: Record<string, string> = { zsh: SYSTEM_NAMES.linux, pwsh: SYSTEM_NAMES.powershell, cmd: SYSTEM_NAMES.cmd }
    out.replaceChildren(h('strong', '', names[r.system] ?? r.system), h('span', 'settings-hint', r.reason))
  }

  /** A list of name and value pairs stored as one object, such as aliases or environment variables. */
  private pairs(parent: HTMLElement, path: Path, names: [string, string], valid: (name: string) => boolean): void {
    const current = (this.value(path) as Record<string, string> | undefined) ?? {}
    const table = h('div', 'pin-table')
    for (const [name, value] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
      const row = h('div', 'pin-row')
      const input = h('input', 'settings-input')
      input.value = value
      input.spellcheck = false
      input.dataset.focusKey = `${path.join('.')}:${name}`
      input.addEventListener('change', () => this.set([...path, name], input.value))
      const rm = h('button', 'icon-btn')
      rm.title = `Remove ${name}`
      rm.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>'
      rm.addEventListener('click', () => {
        const next = { ...current }
        delete next[name]
        this.set(path, next)
      })
      row.append(h('code', 'pin-name', name), input, rm)
      table.append(row)
    }
    const add = h('div', 'pin-row add')
    const nameIn = h('input', 'settings-input')
    nameIn.placeholder = names[0]
    nameIn.spellcheck = false
    nameIn.dataset.focusKey = `${path.join('.')}:new`
    const valueIn = h('input', 'settings-input')
    valueIn.placeholder = names[1]
    valueIn.spellcheck = false
    const addBtn = h('button', 'text-btn', 'Add')
    const commit = (): void => {
      const n = nameIn.value.trim()
      if (!valid(n)) return nameIn.focus()
      this.set(path, { ...current, [n]: valueIn.value })
    }
    addBtn.addEventListener('click', commit)
    valueIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
    })
    add.append(nameIn, valueIn, addBtn)
    table.append(add)
    parent.append(table)
  }

  /** Settings > Shell: zsh plugins, aliases, environment and PATH, for every zsh and bash byndery starts. */
  private renderShell(): void {
    this.heading('Shell')
    const plugins = this.group('zsh plugins')
    plugins.append(h('div', 'settings-hint group-hint', 'byndery ships these for zsh. A plugin your own .zshrc loads is never loaded twice.'))
    for (const [key, label, hint] of SHELL_PLUGINS) this.field(plugins, { label, hint, path: ['shell', 'plugins', key], control: 'toggle' })
    if (api.platform === 'win32') {
      this.field(plugins, {
        label: 'Offer to install missing commands',
        hint: 'When nothing knows a command, byndery asks whether to install it with pacman.',
        path: ['shell', 'offerInstall'],
        control: 'toggle'
      })
    }
    const aliases = this.group('Aliases')
    aliases.append(h('div', 'settings-hint group-hint', 'For zsh and bash. Applies to new terminals.'))
    this.pairs(aliases, ['shell', 'aliases'], ['Name', 'Command'], (n) => /^[\w.+-]+$/.test(n))
    const env = this.group('Environment variables')
    this.pairs(env, ['shell', 'env'], ['NAME', 'Value'], (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    const path = this.group('Added to PATH')
    path.append(h('div', 'settings-hint group-hint', 'Folders searched after everything else, one per line.'))
    const area = h('textarea', 'settings-input wide')
    area.rows = 3
    area.spellcheck = false
    area.dataset.focusKey = 'shell.path'
    area.value = ((this.value(['shell', 'path']) as string[] | undefined) ?? []).join('\n')
    area.addEventListener('change', () => this.set(['shell', 'path'], area.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)))
    path.append(area)
  }

  /** Settings > Tools (Windows): byndery's MSYS2, packages added to it, and links to the rest of Windows. */
  private renderTools(): void {
    this.heading('Tools')
    const t = this.tools
    if (!t) {
      this.body.append(h('div', 'settings-hint group-hint', 'Reading…'))
      void api.tools.status().then((s) => {
        this.tools = s
        if (this.isOpen && this.page === 'tools') this.render()
      })
      return
    }
    const run = (command: string): void => this.runInTerminal.emit(command)
    const linux = this.group('Linux tools')
    let status = 'byndery’s Linux tools are not part of this build.'
    if (t.bundled && !t.installed) status = 'Not set up yet: they unpack the first time a zsh terminal opens.'
    else if (t.installed && t.healthy) status = `Ready, in ${t.path.replace(/\//g, '\\')}.`
    else if (t.installed) status = `Damaged: ${t.missing.join(', ')} ${t.missing.length === 1 ? 'is' : 'are'} missing. Repair restores them.`
    linux.append(h('div', t.installed && !t.healthy ? 'settings-hint warn' : 'settings-hint group-hint', this.toolsBusy ?? status))
    const actions = h('div', 'settings-actions')
    const update = h('button', 'text-btn', 'Update all tools')
    update.disabled = !t.healthy
    update.addEventListener('click', () => run('pacman -Syu'))
    const repair = h('button', 'text-btn', 'Repair')
    repair.disabled = !t.bundled || this.toolsBusy != null
    repair.title = 'Unpacks byndery’s base again. Packages you added stay.'
    repair.addEventListener('click', () => {
      this.toolsBusy = 'Repairing…'
      this.render()
      void api.tools.repair().then(
        (s) => {
          this.tools = s
          this.toolsBusy = null
          this.render()
        },
        (e) => {
          this.toolsBusy = `Repair failed: ${e}`
          this.render()
        }
      )
    })
    actions.append(update, repair)
    linux.append(actions)

    const pkgs = this.group('Added packages')
    pkgs.append(h('div', 'settings-hint group-hint', 'Installed with pacman on top of byndery’s base. App updates keep them.'))
    const list = h('div', 'pin-table')
    for (const name of t.added) {
      const row = h('div', 'pin-row')
      const rm = h('button', 'text-btn', 'Remove')
      rm.addEventListener('click', () => run(`pacman -R ${name}`))
      row.append(h('code', 'pin-name', name), h('span', 'spacer'), rm)
      list.append(row)
    }
    const add = h('div', 'pin-row add')
    const name = h('input', 'settings-input')
    name.placeholder = 'Package, such as jq or make'
    name.spellcheck = false
    name.dataset.focusKey = 'tools:new'
    const install = h('button', 'text-btn', 'Install')
    const go = (): void => {
      const n = name.value.trim()
      if (/^[\w.+-]+$/.test(n)) run(`pacman -Sy --needed ${n}`)
    }
    install.disabled = !t.healthy
    install.addEventListener('click', go)
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go()
    })
    add.append(name, install)
    list.append(add)
    pkgs.append(list)

    const other = this.group('Other apps')
    this.field(other, { label: 'Open in byndery, in Explorer', hint: 'A folder’s menu opens it in byndery (under “Show more options” on Windows 11).', path: ['integration', 'explorerMenu'], control: 'toggle' })
    this.field(other, {
      label: 'Let Claude Code use byndery’s bash',
      hint: t.integration.gitBashPath && !this.value(['integration', 'gitBashForApps'])
        ? `CLAUDE_CODE_GIT_BASH_PATH is already ${t.integration.gitBashPath}; byndery leaves it alone.`
        : 'Sets CLAUDE_CODE_GIT_BASH_PATH for your account, so Claude Code works without Git for Windows.',
      path: ['integration', 'gitBashForApps'],
      control: 'toggle'
    })
    this.field(other, { label: 'Add the Linux tools to PATH', hint: 'After everything else, so Windows’ own commands still win. New windows of other apps see them.', path: ['integration', 'toolsOnPath'], control: 'toggle' })
  }

  private renderFiles(): void {
    this.heading('Files')
    const g = this.group()
    this.field(g, {
      label: 'Sync the file tree with the terminal',
      hint: 'A folder clicked in the tree becomes the terminal’s folder, and cd in the terminal moves the tree.',
      path: ['files', 'sync'],
      control: 'toggle'
    })
  }

  private renderEditor(): void {
    this.heading('Editor')
    const g = this.group()
    this.field(g, { label: 'Font size', path: ['editor', 'fontSize'], control: 'number', min: 8, max: 32, step: 1 })
    this.field(g, { label: 'Tab size', path: ['editor', 'tabSize'], control: 'number', min: 1, max: 8, step: 1 })
    this.field(g, { label: 'Wrap long lines', path: ['editor', 'wordWrap'], control: 'toggle' })
    this.field(g, { label: 'Open Markdown rendered', hint: 'Ctrl+E switches a file between rendered and source.', path: ['editor', 'markdownPreview'], control: 'toggle' })
  }

  private renderKeys(): void {
    const s = this.state!
    this.heading('Keyboard')
    const search = h('input', 'settings-input wide')
    search.placeholder = 'Search actions or keys'
    search.value = this.keyFilter
    search.spellcheck = false
    search.dataset.focusKey = 'keys-search'
    search.addEventListener('input', () => {
      this.keyFilter = search.value
      this.render()
      const el = this.el.querySelector('[data-focus-key="keys-search"]') as HTMLInputElement | null
      el?.setSelectionRange(el.value.length, el.value.length)
    })
    this.body.append(search)
    const g = this.group()
    const q = this.keyFilter.trim().toLowerCase()
    const scopeName = { window: '', terminal: 'Terminal', editor: 'Editor', tree: 'File tree' }
    for (const a of this.keymap.all()) {
      const keys = this.keymap.keysOf(a.id)
      const shown = keys.map((k) => keyLabel(normalizeChord(k)))
      if (q && !a.label.toLowerCase().includes(q) && !shown.some((k) => k.toLowerCase().includes(q))) continue
      const row = h('div', 'settings-row key-row')
      const text = h('div', 'settings-label')
      text.append(h('span', '', a.label))
      if (scopeName[a.scope]) text.append(h('span', 'key-scope', scopeName[a.scope]))
      const clash = this.keymap.conflicts(a.id)
      if (clash.length) text.append(h('div', 'settings-hint warn', `Also on ${clash.map((c) => c.label).join(', ')}`))
      const cell = h('button', `key-cell${this.recording === a.id ? ' recording' : ''}`)
      cell.dataset.focusKey = `key-${a.id}`
      cell.title = 'Change'
      if (this.recording === a.id) cell.append(h('span', 'settings-hint', 'Press keys. Backspace removes, Esc cancels.'))
      else if (shown.length) for (const k of shown) cell.append(h('kbd', '', k))
      else cell.append(h('span', 'settings-hint', 'None'))
      cell.addEventListener('click', () => {
        this.recording = a.id
        this.render()
      })
      const reset = h('button', 'settings-reset')
      reset.title = 'Reset to default'
      reset.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5a4.8 4.8 0 1 1 .9 4.6"/><path d="M3.2 3.3v3.4h3.4"/></svg>'
      reset.style.visibility = s.effective.keys[a.id] ? 'visible' : 'hidden'
      reset.addEventListener('click', () => this.reset(['keys', a.id]))
      row.append(text, wrap(cell), reset)
      g.append(row)
    }
  }

  /** Captures the next key chord for the action being recorded. */
  private record(e: KeyboardEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const id = this.recording!
    if (e.key === 'Escape') {
      this.recording = null
      return this.render()
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.recording = null
      return this.set(['keys', id], [])
    }
    const chord = chordOf(e)
    if (!chord) return
    this.recording = null
    const defaults = this.keymap.get(id)?.keys.map(normalizeChord) ?? []
    if (defaults.length === 1 && defaults[0] === chord) this.reset(['keys', id])
    else this.set(['keys', id], [chord])
  }

  private renderHistory(): void {
    this.heading('Command history')
    const g = this.group()
    this.field(g, { label: 'Remember commands and their output', path: ['history', 'enabled'], control: 'toggle' })
    const row = h('div', 'settings-actions')
    const clear = h('button', 'text-btn danger', 'Clear History…')
    clear.dataset.focusKey = 'clear-history'
    clear.addEventListener('click', async () => {
      const choice = await api.confirm('Clear the command history?', 'Every remembered command and its output is deleted from this computer.', ['Clear', 'Cancel'])
      if (choice === 0) await api.history.clear()
    })
    row.append(clear)
    g.append(row)
  }
}
