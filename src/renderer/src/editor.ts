import { Compartment, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { basename, relative, relativeFrom } from '../../shared/paths'
import { api, Emitter, h, icon, ICON } from './bridge'
import { livePreview } from './markdown-live'

interface Tab {
  path: string
  state: EditorState
  saved: Text
  mtime: number
  preview: boolean
  markdown: boolean
  raw: boolean
  scroll: number
  el: HTMLDivElement
  /** Set when the file could not be opened as text. */
  unreadable?: 'binary' | 'too-large' | 'missing'
  conflict?: string
  /** A new file that has no path yet; `path` holds "untitled:N" until Save As. */
  untitled?: string
}

const isMarkdown = (p: string): boolean => /.(md|markdown|mdx)$/i.test(p)

const languageSlot = new Compartment()
const modeSlot = new Compartment()

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--text-3)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.heading, fontWeight: '650' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent-text)' },
  { tag: t.url, color: 'var(--text-3)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--text-3)' }
])

// Lines an agent (or anything else) changed on disk glow briefly after reload.
const flashEffect = StateEffect.define<{ from: number; to: number } | null>()
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue
      if (!e.value) return Decoration.none
      const ranges = []
      const doc = tr.state.doc
      const a = doc.lineAt(Math.min(e.value.from, doc.length)).number
      const b = doc.lineAt(Math.min(e.value.to, doc.length)).number
      for (let i = a; i <= Math.min(b, a + 400); i++) ranges.push(Decoration.line({ class: 'cm-changed' }).range(doc.line(i).from))
      set = Decoration.set(ranges)
    }
    return set
  },
  provide: (f) => EditorView.decorations.from(f)
})

export class EditorArea {
  readonly view: EditorView
  readonly tabs: Tab[] = []
  active: Tab | null = null
  readonly activeChanged = new Emitter<string | null>()
  readonly visibilityChanged = new Emitter<boolean>()
  root = ''

  constructor(
    private section: HTMLElement,
    private tabBar: HTMLElement,
    private host: HTMLElement,
    private notice: HTMLElement,
    private empty: HTMLElement,
    private mdToggle: HTMLButtonElement
  ) {
    this.view = new EditorView({ parent: host, state: EditorState.create({ doc: '' }) })
    mdToggle.addEventListener('click', () => this.toggleSource())
  }

  private extensions(tab: Tab): Extension[] {
    return [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      indentUnit.of('  '),
      EditorState.tabSize.of(4),
      syntaxHighlighting(highlight),
      flashField,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      languageSlot.of([]),
      modeSlot.of(this.modeExtensions(tab)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.active) {
          if (this.active.preview) this.pin(this.active)
          this.renderTab(this.active)
        }
      })
    ]
  }

  private modeExtensions(tab: Tab): Extension {
    if (tab.markdown && !tab.raw) {
      return [
        EditorView.editorAttributes.of({ class: 'cm-prose' }),
        livePreview({
          path: () => tab.path,
          openLink: (target, external) => {
            if (external) window.open(target)
            else void this.open(target, { pin: true })
          }
        })
      ]
    }
    return [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine()]
  }

  get visible(): boolean {
    return !this.section.hidden
  }

  private opening = new Map<string, Promise<void>>()

  /** Opens a file, reusing the preview tab for single clicks the way VS Code and Warp do. */
  async open(path: string, opts: { line?: number; col?: number; pin?: boolean } = {}): Promise<void> {
    // A click and a double click arrive while the first read is still in
    // flight; they wait for it instead of opening the file twice.
    const pending = this.opening.get(path)
    if (pending) {
      await pending
      return this.open(path, opts)
    }
    if (!this.tabs.some((x) => x.path === path)) {
      const p = this.openNew(path, opts)
      this.opening.set(path, p)
      try {
        await p
      } finally {
        this.opening.delete(path)
      }
      return
    }
    const tab = this.tabs.find((x) => x.path === path)!
    if (opts.pin) this.pin(tab)
    this.renderTab(tab)
    this.activate(tab)
    if (opts.line) this.goto(opts.line, opts.col)
  }

  private async openNew(path: string, opts: { line?: number; col?: number; pin?: boolean }): Promise<void> {
    const r = await api.fs.read(path)
    const tab = this.makeTab(path, r.text ?? '', { preview: !opts.pin, mtime: r.mtime })
    tab.unreadable = r.text == null ? r.reason : undefined
    this.renderTab(tab)
    this.activate(tab)
    if (opts.line) this.goto(opts.line, opts.col)
  }

  private untitledCount = 0

  /** A new, empty tab with no file behind it until it is saved. */
  newFile(): void {
    const n = ++this.untitledCount
    const tab = this.makeTab(`untitled:${n}`, '', { preview: false, mtime: 0 })
    tab.untitled = `Untitled-${n}`
    this.renderTab(tab)
    this.activate(tab)
    this.focus()
  }

  private makeTab(path: string, text: string, o: { preview: boolean; mtime: number }): Tab {
    const tab: Tab = {
      path,
      state: EditorState.create({ doc: '' }),
      saved: EditorState.create({ doc: '' }).doc,
      mtime: o.mtime,
      preview: o.preview,
      markdown: isMarkdown(path),
      raw: false,
      scroll: 0,
      el: h('div', 'tab')
    }
    tab.state = EditorState.create({ doc: text, extensions: this.extensions(tab) })
    tab.saved = tab.state.doc
    tab.el.addEventListener('click', () => this.activate(tab))
    tab.el.addEventListener('dblclick', () => this.pin(tab))
    tab.el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        void this.close(tab)
      }
    })
    tab.el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      void this.tabMenu(tab)
    })
    // A new preview replaces the old one unless that one has been edited.
    const old = this.tabs.find((x) => x.preview && x.state.doc.eq(x.saved))
    if (tab.preview && old) {
      const i = this.tabs.indexOf(old)
      this.tabs.splice(i, 1, tab)
      old.el.replaceWith(tab.el)
      if (this.active === old) this.active = null
    } else {
      this.tabs.push(tab)
      this.tabBar.append(tab.el)
    }
    void this.loadLanguage(tab)
    return tab
  }

  private async loadLanguage(tab: Tab): Promise<void> {
    let ext: Extension
    if (tab.markdown) ext = markdown({ base: markdownLanguage, codeLanguages: languages })
    else {
      const desc = LanguageDescription.matchFilename(languages, basename(tab.path))
      if (!desc) return
      ext = await desc.load()
    }
    const effects = languageSlot.reconfigure(ext)
    if (this.active === tab) this.view.dispatch({ effects })
    else tab.state = tab.state.update({ effects }).state
  }

  activate(tab: Tab): void {
    if (this.active && this.active !== tab) this.stash()
    const switching = this.active !== tab
    this.active = tab
    this.show(true)
    for (const x of this.tabs) x.el.classList.toggle('active', x === tab)
    if (switching) {
      this.view.setState(tab.state)
      requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = tab.scroll))
    }
    tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    this.renderChrome()
    this.activeChanged.emit(tab.path)
  }

  private stash(): void {
    if (!this.active) return
    this.active.state = this.view.state
    this.active.scroll = this.view.scrollDOM.scrollTop
  }

  private pin(tab: Tab): void {
    if (!tab.preview) return
    tab.preview = false
    this.renderTab(tab)
  }

  focus(): void {
    if (this.active && !this.active.unreadable) this.view.focus()
  }

  goto(line: number, col = 1): void {
    const doc = this.view.state.doc
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)))
    const pos = Math.min(l.from + Math.max(0, col - 1), l.to)
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    this.view.focus()
  }

  private dirty(tab: Tab): boolean {
    const doc = tab === this.active ? this.view.state.doc : tab.state.doc
    return !doc.eq(tab.saved)
  }

  /** Saves the active tab; false when there was nothing to save or Save As was cancelled. */
  async save(): Promise<boolean> {
    const tab = this.active
    if (!tab || tab.unreadable) return false
    const doc = this.view.state.doc
    if (tab.untitled) {
      const to = await api.workspace.saveAs(`${this.root}/${tab.untitled}.txt`)
      if (!to) return false
      tab.path = to
      tab.untitled = undefined
      tab.markdown = isMarkdown(to)
      this.view.dispatch({ effects: modeSlot.reconfigure(this.modeExtensions(tab)) })
      void this.loadLanguage(tab)
      this.activeChanged.emit(to)
    }
    tab.mtime = await api.fs.write(tab.path, doc.toString())
    tab.saved = doc
    tab.conflict = undefined
    this.pin(tab)
    this.renderTab(tab)
    this.renderChrome()
    return true
  }

  async close(tab: Tab | null = this.active): Promise<void> {
    if (!tab) return
    if (this.dirty(tab)) {
      if (this.active !== tab) this.activate(tab)
      const choice = await api.confirm(`Save changes to ${this.title(tab)}?`, 'Your changes will be lost if you don’t save them.', ['Save', 'Don’t Save', 'Cancel'])
      if (choice === 2) return
      if (choice === 0 && !(await this.save())) return
    }
    const i = this.tabs.indexOf(tab)
    this.tabs.splice(i, 1)
    tab.el.remove()
    if (this.active === tab) {
      this.active = null
      const next = this.tabs[Math.min(i, this.tabs.length - 1)]
      if (next) this.activate(next)
      else {
        this.show(false)
        this.activeChanged.emit(null)
      }
    }
  }

  cycle(dir: 1 | -1): void {
    if (!this.active || this.tabs.length < 2) return
    const i = this.tabs.indexOf(this.active)
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length])
    this.focus()
  }

  toggleSource(): void {
    const tab = this.active
    if (!tab?.markdown) return
    // Keep the line at the top of the screen in place across the switch.
    const top = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop).from
    tab.raw = !tab.raw
    this.view.dispatch({ effects: modeSlot.reconfigure(this.modeExtensions(tab)) })
    requestAnimationFrame(() => this.view.dispatch({ effects: EditorView.scrollIntoView(top, { y: 'start' }) }))
    this.renderChrome()
  }

  /** `@path#L3-9` for the active selection, relative to `cwd` when it can be. Claude Code reads this form. */
  reference(cwd: string): string | null {
    const tab = this.active
    if (!tab || tab.untitled) return null
    const rel = relativeFrom(cwd, tab.path) ?? tab.path
    const sel = this.view.state.selection.main
    let ref = `@${rel.includes(' ') ? `"${rel}"` : rel}`
    if (!sel.empty) {
      const doc = this.view.state.doc
      const a = doc.lineAt(sel.from).number
      const b = doc.lineAt(sel.to === doc.lineAt(sel.to).from && sel.to > sel.from ? sel.to - 1 : sel.to).number
      ref += a === b ? `#L${a}` : `#L${a}-${b}`
    }
    return ref
  }

  /** Paths the watcher reported. Clean files follow the disk; edited ones ask first. */
  async diskChanged(paths: Set<string>): Promise<void> {
    for (const tab of this.tabs) {
      if (!paths.has(tab.path)) continue
      const r = await api.fs.read(tab.path)
      if (r.text == null) {
        if (r.reason === 'missing') {
          tab.unreadable = 'missing'
          this.renderTab(tab)
          if (tab === this.active) this.renderChrome()
        }
        continue
      }
      if (tab.unreadable === 'missing') tab.unreadable = undefined
      const isActive = tab === this.active
      const doc = isActive ? this.view.state.doc : tab.state.doc
      if (doc.toString() === r.text) {
        tab.mtime = r.mtime
        tab.saved = doc
        tab.conflict = undefined
        this.renderTab(tab)
        continue
      }
      if (!doc.eq(tab.saved)) {
        tab.conflict = r.text
        if (isActive) this.renderChrome()
        this.renderTab(tab)
        continue
      }
      this.replaceDoc(tab, r.text)
      tab.mtime = r.mtime
    }
  }

  /** Swaps in new text as one minimal change, so the cursor and undo history survive. */
  private replaceDoc(tab: Tab, text: string): void {
    const isActive = tab === this.active
    const old = (isActive ? this.view.state : tab.state).doc.toString()
    let a = 0
    while (a < old.length && a < text.length && old[a] === text[a]) a++
    let b = 0
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++
    const spec = {
      changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) },
      effects: flashEffect.of({ from: a, to: a + Math.max(0, text.length - b - a) }),
      annotations: []
    }
    if (isActive) {
      this.view.dispatch(spec)
      tab.saved = this.view.state.doc
      window.setTimeout(() => {
        if (this.active === tab) this.view.dispatch({ effects: flashEffect.of(null) })
      }, 2400)
    } else {
      tab.state = tab.state.update(spec).state
      tab.saved = tab.state.doc
    }
    tab.conflict = undefined
    this.renderTab(tab)
  }

  private title(tab: Tab): string {
    return tab.untitled ?? basename(tab.path)
  }

  private renderTab(tab: Tab): void {
    const dup = !tab.untitled && this.tabs.some((x) => x !== tab && basename(x.path) === basename(tab.path))
    tab.el.className = 'tab'
    tab.el.classList.toggle('active', tab === this.active)
    tab.el.classList.toggle('preview', tab.preview)
    tab.el.classList.toggle('dirty', this.dirty(tab))
    tab.el.title = tab.untitled ?? relative(this.root, tab.path) ?? tab.path
    const label = h('span', 'label', this.title(tab))
    if (tab.unreadable === 'missing') label.style.textDecoration = 'line-through'
    const parts: HTMLElement[] = [label]
    if (dup) {
      const rel = relative(this.root, tab.path) ?? tab.path
      parts.push(h('span', 'meta', rel.split('/').slice(-2, -1)[0] ?? ''))
    }
    const close = h('button', 'close')
    close.title = 'Close'
    close.append(icon(ICON.close))
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.close(tab)
    })
    tab.el.replaceChildren(...parts, close)
  }

  private renderChrome(): void {
    const tab = this.active
    this.mdToggle.hidden = !tab?.markdown || !!tab.unreadable
    if (tab?.markdown) {
      this.mdToggle.textContent = tab.raw ? 'Preview' : 'Source'
    }
    // Notice bar: a file changed on disk while it had unsaved edits.
    if (tab?.conflict != null) {
      const msg = h('span', '', `${this.title(tab)} changed on disk.`)
      const reload = h('button', '', 'Reload')
      const keep = h('button', '', 'Keep Mine')
      reload.addEventListener('click', () => {
        this.replaceDoc(tab, tab.conflict!)
        this.renderChrome()
      })
      keep.addEventListener('click', () => {
        tab.conflict = undefined
        this.renderChrome()
      })
      this.notice.replaceChildren(msg, h('span', 'spacer'), reload, keep)
      this.notice.hidden = false
    } else this.notice.hidden = true

    if (tab?.unreadable) {
      this.host.hidden = true
      const text = { binary: 'Binary file', 'too-large': 'File is larger than 8 MB', missing: 'File was deleted' }[tab.unreadable]
      const wrap = h('div', 'empty-msg')
      wrap.append(h('div', '', text))
      if (tab.unreadable !== 'missing') {
        const b = h('button', 'text-btn', 'Open in Default App')
        b.addEventListener('click', () => api.fs.openExternal(tab.path))
        wrap.append(b)
      }
      this.empty.replaceChildren(wrap)
      this.empty.hidden = false
    } else {
      this.host.hidden = false
      this.empty.hidden = true
    }
  }

  private async tabMenu(tab: Tab): Promise<void> {
    const id = await api.menu([
      { id: 'close', label: 'Close', accel: 'CmdOrCtrl+W' },
      { id: 'others', label: 'Close Others', enabled: this.tabs.length > 1 },
      ...(tab.untitled
        ? []
        : [{ separator: true }, { id: 'copy', label: 'Copy Path' }, { id: 'reveal', label: 'Reveal in File Tree' }])
    ])
    if (id === 'close') void this.close(tab)
    else if (id === 'others') {
      for (const x of [...this.tabs]) {
        if (x !== tab) await this.close(x)
      }
    } else if (id === 'copy') api.clipboard.write(api.platform === 'win32' ? tab.path.replace(/\//g, '\\') : tab.path)
    else if (id === 'reveal') this.activeChanged.emit(tab.path)
  }

  private show(on: boolean): void {
    if (this.section.hidden === !on) return
    this.section.hidden = !on
    this.visibilityChanged.emit(on)
  }

  hide(): void {
    this.show(false)
  }

  reopen(): void {
    if (this.active) this.show(true)
  }
}
