import type { HistoryEntry, HistoryScope } from '../../shared/history'
import { basename } from '../../shared/paths'
import { api, h } from './bridge'

const SCOPES: { id: HistoryScope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'workspace', label: 'This workspace' },
  { id: 'folder', label: 'This folder' },
  { id: 'session', label: 'This terminal' }
]

export interface HistoryTarget {
  cwd: string
  root: string
  session: string
  /** Replaces the prompt's line with `text`; runs it when `run` is set. */
  put(text: string, run: boolean): void
}

/**
 * The command memory, searched from one panel. Ctrl+R opens it from the
 * terminal, the way Atuin and Warp take over that key. Typing searches
 * commands and their output; Ctrl+R again moves between everything, this
 * workspace, this folder and this terminal. As in Atuin's shipped config,
 * Enter runs the command and Tab puts it on the prompt to edit.
 */
export class HistoryPanel {
  private el = h('div', 'history')
  private input = h('input', 'history-input')
  private scopeEl = h('div', 'history-scopes')
  private list = h('ul', 'history-list')
  private preview = h('pre', 'history-output')
  private meta = h('div', 'history-meta')
  private entries: HistoryEntry[] = []
  private index = 0
  private scope: HistoryScope = 'all'
  private target: HistoryTarget | null = null
  private restoreFocus: HTMLElement | null = null
  private seq = 0
  private previewSeq = 0

  constructor() {
    this.el.hidden = true
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'Command history')
    this.input.placeholder = 'Search commands and output'
    this.input.spellcheck = false
    const head = h('div', 'history-head')
    head.append(this.input, this.scopeEl)
    const body = h('div', 'history-body')
    const right = h('div', 'history-right')
    right.append(this.meta, this.preview)
    body.append(this.list, right)
    this.el.append(head, body)
    document.body.append(this.el)

    this.input.addEventListener('input', () => void this.refresh())
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    this.list.addEventListener('mousedown', (e) => {
      const li = (e.target as HTMLElement).closest('li')
      if (!li?.dataset.i) return
      e.preventDefault()
      this.select(Number(li.dataset.i))
    })
    this.list.addEventListener('dblclick', () => this.accept(false))
    document.addEventListener('mousedown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as Node)) this.close()
    })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  async open(target: HistoryTarget, initial = ''): Promise<void> {
    this.target = target
    if (!this.isOpen) this.restoreFocus = document.activeElement as HTMLElement | null
    this.el.hidden = false
    this.input.value = initial
    this.input.focus()
    this.renderScopes()
    await this.refresh()
  }

  close(restore = true): void {
    if (this.el.hidden) return
    this.el.hidden = true
    if (restore) this.restoreFocus?.focus()
  }

  private renderScopes(): void {
    this.scopeEl.replaceChildren(
      ...SCOPES.map((s) => {
        const b = h('button', 'history-scope', s.label)
        b.setAttribute('aria-pressed', String(s.id === this.scope))
        b.addEventListener('mousedown', (e) => {
          e.preventDefault()
          this.scope = s.id
          this.renderScopes()
          void this.refresh()
        })
        return b
      })
    )
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq
    const rows = await api.history.search({
      text: this.input.value,
      scope: this.scope,
      cwd: this.target?.cwd,
      root: this.target?.root,
      session: this.target?.session,
      limit: 200
    })
    if (seq !== this.seq) return
    this.entries = rows
    this.index = 0
    this.renderList()
    void this.showPreview()
  }

  private renderList(): void {
    const frag = document.createDocumentFragment()
    if (!this.entries.length) frag.append(h('li', 'empty', this.input.value ? 'No matches' : 'No commands yet'))
    this.entries.forEach((e, i) => {
      const li = h('li')
      li.dataset.i = String(i)
      if (i === this.index) li.classList.add('active')
      const mark = h('span', `history-mark ${e.exit == null ? '' : e.exit === 0 ? 'ok' : 'fail'}`)
      const cmd = h('span', 'history-cmd', e.command.split('\n')[0])
      const when = h('span', 'history-when', ago(e.startedAt))
      li.append(mark, cmd, when)
      frag.append(li)
    })
    this.list.replaceChildren(frag)
  }

  private select(i: number): void {
    if (!this.entries.length) return
    this.index = (i + this.entries.length) % this.entries.length
    for (const li of this.list.children) li.classList.toggle('active', Number((li as HTMLElement).dataset.i) === this.index)
    this.list.children[this.index]?.scrollIntoView({ block: 'nearest' })
    void this.showPreview()
  }

  private async showPreview(): Promise<void> {
    const e = this.entries[this.index]
    const seq = ++this.previewSeq
    if (!e) {
      this.meta.replaceChildren()
      this.preview.textContent = ''
      return
    }
    const parts = [
      e.cwd ? basename(e.cwd) || e.cwd : null,
      e.exit == null ? null : e.exit === 0 ? 'exit 0' : `exit ${e.exit}`,
      e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)} s` : null,
      new Date(e.startedAt || 0).toLocaleString()
    ].filter(Boolean) as string[]
    this.meta.replaceChildren(...parts.map((p) => h('span', '', p)))
    this.meta.title = e.cwd
    const out = e.outputBytes ? await api.history.output(e.id) : null
    if (seq !== this.previewSeq) return
    this.preview.textContent = out?.text ?? ''
    this.preview.classList.toggle('none', !out?.text)
    if (!out?.text) this.preview.textContent = e.session === 'imported' ? 'Imported from shell history' : 'No output'
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'ArrowDown' || (mod && e.key === 'n')) {
      e.preventDefault()
      this.select(this.index + 1)
    } else if (e.key === 'ArrowUp' || (mod && e.key === 'p')) {
      e.preventDefault()
      this.select(this.index - 1)
    } else if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      const i = SCOPES.findIndex((s) => s.id === this.scope)
      this.scope = SCOPES[(i + 1) % SCOPES.length].id
      this.renderScopes()
      void this.refresh()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.accept(true)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      this.accept(false)
    } else if (e.key === 'Delete' && e.shiftKey) {
      e.preventDefault()
      const entry = this.entries[this.index]
      if (entry) void api.history.remove(entry.id).then(() => this.refresh())
    }
  }

  private accept(run: boolean): void {
    const e = this.entries[this.index]
    const target = this.target
    this.close(false)
    if (!e || !target) return
    target.put(e.command, run)
  }
}

function ago(t: number): string {
  if (!t || t < 1e11) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`
  return new Date(t).toLocaleDateString()
}
