import { rank } from '../../shared/fuzzy'
import { h } from './bridge'
import { keyLabel } from './keys'

export interface Command {
  id: string
  label: string
  key?: string
  run: () => void
}

type Mode = 'files' | 'commands' | 'line'

/**
 * One input for files, commands and go-to-line, the way VS Code's quick open
 * works: no prefix searches files, ">" lists commands, ":" jumps to a line.
 */
export class Palette {
  private items: { label: string; dir?: string; key?: string; hits?: number[]; run: () => void }[] = []
  private index = 0
  private restoreFocus: HTMLElement | null = null

  constructor(
    private el: HTMLElement,
    private input: HTMLInputElement,
    private list: HTMLUListElement,
    private source: {
      files: () => Promise<string[]>
      commands: () => Command[]
      openFile: (rel: string) => void
      gotoLine: (n: number) => void
      /** An absolute path typed or pasted in either form, C:\x or /c/x, or null. */
      absolute: (input: string) => { path: string; line?: number } | null
      openPath: (path: string, line?: number) => void
    }
  ) {
    input.addEventListener('input', () => void this.refresh())
    input.addEventListener('keydown', (e) => this.onKey(e))
    input.addEventListener('blur', () => setTimeout(() => this.close(false), 80))
    list.addEventListener('mousedown', (e) => {
      const li = (e.target as HTMLElement).closest('li')
      if (!li?.dataset.i) return
      e.preventDefault()
      this.index = Number(li.dataset.i)
      this.accept()
    })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  show(prefix = ''): void {
    if (!this.isOpen) this.restoreFocus = document.activeElement as HTMLElement | null
    this.el.hidden = false
    this.input.value = prefix
    this.input.placeholder = prefix === '>' ? 'Type a command' : 'Go to file, > for commands, : for a line'
    this.input.focus()
    void this.refresh()
  }

  close(restore = true): void {
    if (!this.isOpen) return
    this.el.hidden = true
    if (restore) this.restoreFocus?.focus()
  }

  private mode(): Mode {
    const v = this.input.value
    if (v.startsWith('>')) return 'commands'
    if (v.startsWith(':')) return 'line'
    return 'files'
  }

  private async refresh(): Promise<void> {
    const v = this.input.value
    const mode = this.mode()
    if (mode === 'line') {
      const n = Number(v.slice(1))
      this.items = n > 0 ? [{ label: `Go to line ${n}`, run: () => this.source.gotoLine(n) }] : []
    } else if (mode === 'commands') {
      const cmds = this.source.commands()
      const q = v.slice(1).trim()
      const ranked = rank(q, cmds.map((c) => c.label), 200)
      this.items = ranked.map((r) => {
        const c = cmds.find((x) => x.label === r.item)!
        return { label: c.label, key: c.key ? keyLabel(c.key) : undefined, hits: r.hits, run: c.run }
      })
    } else {
      const abs = this.source.absolute(v.trim())
      if (abs) {
        this.items = [{ label: abs.path + (abs.line ? `:${abs.line}` : ''), key: 'Open', run: () => this.source.openPath(abs.path, abs.line) }]
        this.index = 0
        this.render()
        return
      }
      const files = await this.source.files()
      if (this.input.value !== v) return
      const ranked = rank(v.trim(), files, 60)
      this.items = ranked.map((r) => {
        const cut = r.item.lastIndexOf('/')
        return {
          label: r.item.slice(cut + 1),
          dir: cut > 0 ? r.item.slice(0, cut) : '',
          hits: r.hits.filter((i) => i > cut).map((i) => i - cut - 1),
          run: () => this.source.openFile(r.item)
        }
      })
    }
    this.index = 0
    this.render()
  }

  private render(): void {
    const frag = document.createDocumentFragment()
    if (!this.items.length) {
      frag.append(h('li', 'empty', this.mode() === 'files' ? 'No matching files' : 'No matches'))
    }
    this.items.forEach((it, i) => {
      const li = h('li')
      li.dataset.i = String(i)
      li.setAttribute('role', 'option')
      if (i === this.index) li.classList.add('active')
      const name = h('span', 'name')
      const hits = new Set(it.hits ?? [])
      let run = ''
      let inHit = false
      const flush = (): void => {
        if (!run) return
        if (inHit) name.append(h('mark', '', run))
        else name.append(run)
        run = ''
      }
      for (let c = 0; c < it.label.length; c++) {
        const hit = hits.has(c)
        if (hit !== inHit) {
          flush()
          inHit = hit
        }
        run += it.label[c]
      }
      flush()
      li.append(name)
      if (it.dir) li.append(h('span', 'dir', it.dir))
      if (it.key) li.append(h('span', 'key', it.key))
      frag.append(li)
    })
    this.list.replaceChildren(frag)
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!this.items.length) return
      this.index = (this.index + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length
      this.render()
      this.list.children[this.index]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.accept()
    }
  }

  private accept(): void {
    const it = this.items[this.index]
    this.close(false)
    it?.run()
  }
}
