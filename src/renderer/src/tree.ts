import type { DirEntry, GitCode, GitState } from '../../shared/api'
import { basename, dirname, join, normalize, relative } from '../../shared/paths'
import { api, Emitter, h, icon, ICON } from './bridge'

interface Row {
  entry: DirEntry
  depth: number
}

const ROW_H = 22
const OVERSCAN = 8

/**
 * The file tree. Directories load when first expanded and reload when the
 * watcher reports a change inside them. Only the rows in view are in the DOM,
 * so a folder with thousands of files scrolls as fast as one with ten.
 */
export class FileTree {
  root = ''
  private children = new Map<string, DirEntry[]>()
  private expanded = new Set<string>()
  private rows: Row[] = []
  private selected: string | null = null
  private cwd: string | null = null
  private git: GitState | null = null
  private dirtyDirs = new Map<string, GitCode>()
  private ignored = new Set<string>()
  private spacer = h('div', 'spacer-rows')
  private pool: HTMLDivElement[] = []
  private renaming: string | null = null
  private frame = 0

  readonly open = new Emitter<{ path: string; pin: boolean }>()
  readonly sendToTerminal = new Emitter<string[]>()

  constructor(private el: HTMLElement) {
    el.append(this.spacer)
    el.addEventListener('scroll', () => this.paint())
    new ResizeObserver(() => this.paint()).observe(el)
    el.addEventListener('keydown', (e) => this.onKey(e))
    el.addEventListener('contextmenu', (e) => {
      if (e.target === el || e.target === this.spacer) {
        e.preventDefault()
        void this.menu(null)
      }
    })
  }

  async setRoot(root: string): Promise<void> {
    this.root = normalize(root)
    this.children.clear()
    this.expanded = new Set([this.root])
    this.selected = null
    await this.load(this.root)
    this.rebuild()
  }

  private async load(dir: string): Promise<void> {
    try {
      this.children.set(dir, await api.fs.list(dir))
    } catch {
      this.children.set(dir, [])
    }
  }

  private rebuild(): void {
    const rows: Row[] = []
    const walk = (dir: string, depth: number): void => {
      for (const e of this.children.get(dir) ?? []) {
        rows.push({ entry: e, depth })
        if (e.dir && this.expanded.has(e.path) && this.children.has(e.path)) walk(e.path, depth + 1)
      }
    }
    walk(this.root, 0)
    this.rows = rows
    this.spacer.style.height = `${rows.length * ROW_H}px`
    this.paint()
  }

  private paint(): void {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paintNow())
  }

  private paintNow(): void {
    const top = this.el.scrollTop
    const height = this.el.clientHeight
    const from = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
    const to = Math.min(this.rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN)
    const need = to - from
    while (this.pool.length < need) {
      const r = this.makeRow()
      this.pool.push(r)
      this.spacer.append(r)
    }
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i]
      if (i >= need) {
        el.hidden = true
        continue
      }
      el.hidden = false
      this.fillRow(el, from + i)
    }
  }

  private makeRow(): HTMLDivElement {
    const el = h('div', 'row')
    el.setAttribute('role', 'treeitem')
    const tw = h('span', 'twisty')
    tw.append(icon(ICON.chevron))
    el.append(tw, h('span', 'name'), h('span', 'dot'), h('span', 'badge'))
    el.draggable = true
    el.addEventListener('click', (e) => this.onClick(el, e))
    el.addEventListener('dblclick', () => {
      const r = this.rows[Number(el.dataset.i)]
      if (r && !r.entry.dir) this.open.emit({ path: r.entry.path, pin: true })
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const r = this.rows[Number(el.dataset.i)]
      if (!r) return
      this.select(r.entry.path)
      void this.menu(r.entry)
    })
    el.addEventListener('dragstart', (e) => {
      const r = this.rows[Number(el.dataset.i)]
      if (!r || !e.dataTransfer) return
      e.dataTransfer.setData('application/x-byndery-paths', JSON.stringify([r.entry.path]))
      e.dataTransfer.setData('text/plain', r.entry.path)
      e.dataTransfer.effectAllowed = 'copyMove'
    })
    el.addEventListener('dragover', (e) => {
      const r = this.rows[Number(el.dataset.i)]
      if (!r?.entry.dir || !e.dataTransfer?.types.includes('application/x-byndery-paths')) return
      e.preventDefault()
      el.classList.add('drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target')
      const r = this.rows[Number(el.dataset.i)]
      const raw = e.dataTransfer?.getData('application/x-byndery-paths')
      if (!r?.entry.dir || !raw) return
      e.preventDefault()
      for (const src of JSON.parse(raw) as string[]) {
        if (src === r.entry.path || dirname(src) === r.entry.path) continue
        void api.fs.rename(src, join(r.entry.path, basename(src)))
      }
    })
    return el
  }

  private fillRow(el: HTMLDivElement, i: number): void {
    const { entry, depth } = this.rows[i]
    el.dataset.i = String(i)
    el.style.top = `${i * ROW_H}px`
    el.style.paddingLeft = `${6 + depth * 14}px`
    const code = this.git?.files[entry.path]
    const roll = entry.dir ? this.dirtyDirs.get(entry.path) : undefined
    const cls = ['row']
    if (entry.dir) cls.push('dir')
    if (entry.dir && this.expanded.has(entry.path)) cls.push('open')
    if (entry.path === this.selected) cls.push('selected')
    if (entry.path === this.cwd) cls.push('cwd')
    if (code) cls.push(`git-${code}`)
    if (roll) cls.push(roll === 'U' || roll === 'A' ? 'has-U' : 'has-M')
    if (this.isIgnored(entry.path)) cls.push('ignored')
    if (entry.path === this.renaming) cls.push('renaming')
    el.className = cls.join(' ')
    el.setAttribute('aria-selected', String(entry.path === this.selected))
    if (entry.dir) el.setAttribute('aria-expanded', String(this.expanded.has(entry.path)))
    else el.removeAttribute('aria-expanded')
    const [tw, name, dot, badge] = el.children as unknown as HTMLElement[]
    tw.style.visibility = entry.dir ? 'visible' : 'hidden'
    name.textContent = entry.name
    dot.style.display = roll ? '' : 'none'
    badge.textContent = code && !entry.dir ? code : ''
    el.title = entry.symlink ? `${entry.path} (link)` : ''
    const input = el.querySelector('input')
    if (entry.path !== this.renaming && input) input.remove()
  }

  private isIgnored(p: string): boolean {
    if (!this.ignored.size) return false
    for (let d = p; d.length >= this.root.length; d = dirname(d)) {
      if (this.ignored.has(d)) return true
      if (d === dirname(d)) break
    }
    return false
  }

  private onClick(el: HTMLDivElement, e: MouseEvent): void {
    const r = this.rows[Number(el.dataset.i)]
    if (!r) return
    this.select(r.entry.path)
    if (r.entry.dir) void this.toggle(r.entry.path)
    else this.open.emit({ path: r.entry.path, pin: e.detail > 1 })
  }

  private select(p: string | null): void {
    this.selected = p
    this.paint()
  }

  async toggle(dir: string, force?: boolean): Promise<void> {
    const open = force ?? !this.expanded.has(dir)
    if (open) {
      this.expanded.add(dir)
      if (!this.children.has(dir)) await this.load(dir)
    } else this.expanded.delete(dir)
    this.rebuild()
  }

  collapseAll(): void {
    this.expanded = new Set([this.root])
    this.rebuild()
    this.el.scrollTop = 0
  }

  /** Expands the folders above `p`, selects it and scrolls it into view. */
  async reveal(p: string, select = true): Promise<void> {
    const target = normalize(p)
    const rel = relative(this.root, target)
    if (rel == null || rel === '') return
    let dir = this.root
    for (const seg of rel.split('/').slice(0, -1)) {
      dir = join(dir, seg)
      this.expanded.add(dir)
      if (!this.children.has(dir)) await this.load(dir)
    }
    this.rebuild()
    if (select) this.selected = target
    const i = this.rows.findIndex((r) => r.entry.path === target)
    if (i >= 0) {
      const top = i * ROW_H
      const view = this.el.clientHeight
      if (top < this.el.scrollTop || top + ROW_H > this.el.scrollTop + view) {
        this.el.scrollTop = Math.max(0, top - view / 3)
      }
    }
    this.paint()
  }

  /** Marks the terminal's folder and, when following, opens the tree down to it. */
  async setCwd(cwd: string | null, follow: boolean): Promise<void> {
    this.cwd = cwd ? normalize(cwd) : null
    if (follow && this.cwd && this.cwd !== this.root) {
      const rel = relative(this.root, this.cwd)
      if (rel) {
        await this.reveal(this.cwd, false)
        if (!this.expanded.has(this.cwd)) await this.toggle(this.cwd, true)
      }
    }
    this.paint()
  }

  setGit(state: GitState): void {
    this.git = state
    this.ignored = new Set(state.ignored)
    // Roll file states up to every folder above them: conflicts first, then edits, then new files.
    const rank: Record<GitCode, number> = { C: 4, D: 3, M: 3, R: 3, A: 1, U: 1 }
    const dirs = new Map<string, GitCode>()
    for (const [p, code] of Object.entries(state.files)) {
      for (let d = dirname(p); relative(this.root, d) != null; d = dirname(d)) {
        const cur = dirs.get(d)
        if (!cur || rank[code] > rank[cur]) dirs.set(d, code)
        if (d === this.root || d === dirname(d)) break
      }
    }
    this.dirtyDirs = dirs
    this.paint()
  }

  /** Called with paths the watcher reported. Reloads only folders already on screen. */
  async changed(paths: string[]): Promise<void> {
    const dirs = new Set<string>()
    for (const p of paths) {
      const d = dirname(p)
      if (this.children.has(d)) dirs.add(d)
      if (this.children.has(p)) dirs.add(p)
    }
    if (!dirs.size) return
    await Promise.all([...dirs].map((d) => this.load(d)))
    this.rebuild()
  }

  focus(): void {
    this.el.focus()
    if (!this.selected && this.rows[0]) this.select(this.rows[0].entry.path)
  }

  private onKey(e: KeyboardEvent): void {
    if (this.renaming) return
    const i = this.rows.findIndex((r) => r.entry.path === this.selected)
    const r = this.rows[i]
    const go = (j: number): void => {
      const t = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))]
      if (t) void this.reveal(t.entry.path)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1)
        break
      case 'ArrowUp':
        go(i - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(this.rows.length - 1)
        break
      case 'ArrowRight':
        if (r?.entry.dir) {
          if (!this.expanded.has(r.entry.path)) void this.toggle(r.entry.path, true)
          else go(i + 1)
        }
        break
      case 'ArrowLeft':
        if (r?.entry.dir && this.expanded.has(r.entry.path)) void this.toggle(r.entry.path, false)
        else if (r) {
          const parent = dirname(r.entry.path)
          if (parent !== this.root) void this.reveal(parent)
        }
        break
      case 'Enter':
        if (r?.entry.dir) void this.toggle(r.entry.path)
        else if (r) this.open.emit({ path: r.entry.path, pin: true })
        break
      case ' ':
        if (r && !r.entry.dir) this.open.emit({ path: r.entry.path, pin: false })
        break
      case 'F2':
        if (r) this.startRename(r.entry)
        break
      case 'Delete':
        if (r) void this.trash(r.entry)
        break
      default:
        return
    }
    e.preventDefault()
  }

  private async menu(entry: DirEntry | null): Promise<void> {
    const target = entry ?? { path: this.root, dir: true, name: basename(this.root), symlink: false }
    const dir = target.dir ? target.path : dirname(target.path)
    const id = await api.menu([
      ...(entry && !entry.dir ? [{ id: 'open', label: 'Open' }, { separator: true }] : []),
      { id: 'new-file', label: 'New File…' },
      { id: 'new-folder', label: 'New Folder…' },
      { separator: true },
      { id: 'insert', label: 'Insert Path in Terminal' },
      { id: 'copy', label: 'Copy Path' },
      { id: 'copy-rel', label: 'Copy Relative Path' },
      { id: 'reveal', label: api.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer' },
      ...(entry
        ? [{ separator: true }, { id: 'rename', label: 'Rename…', accel: 'F2' }, { id: 'trash', label: 'Delete', accel: 'Delete' }]
        : [])
    ])
    switch (id) {
      case 'open':
        this.open.emit({ path: target.path, pin: true })
        break
      case 'new-file':
      case 'new-folder':
        void this.startCreate(dir, id === 'new-folder')
        break
      case 'insert':
        this.sendToTerminal.emit([target.path])
        break
      case 'copy':
        api.clipboard.write(api.platform === 'win32' ? target.path.replace(/\//g, '\\') : target.path)
        break
      case 'copy-rel':
        api.clipboard.write(relative(this.root, target.path) || '.')
        break
      case 'reveal':
        api.fs.reveal(target.path)
        break
      case 'rename':
        if (entry) this.startRename(entry)
        break
      case 'trash':
        if (entry) void this.trash(entry)
        break
    }
  }

  private async trash(entry: DirEntry): Promise<void> {
    await api.fs.trash(entry.path)
    await this.changed([entry.path])
  }

  private async startCreate(dir: string, folder: boolean): Promise<void> {
    if (dir !== this.root) await this.toggle(dir, true)
    const name = await this.prompt(dir, folder ? 'folder' : 'file')
    if (!name) return
    const p = join(dir, name)
    try {
      await api.fs.create(p, folder)
    } catch {
      return
    }
    await this.load(dir)
    this.rebuild()
    await this.reveal(p)
    if (!folder) this.open.emit({ path: p, pin: true })
  }

  /** Inline name input placed as a temporary row at the top of `dir`. */
  private prompt(dir: string, kind: string): Promise<string | null> {
    return new Promise((resolve) => {
      const depth = dir === this.root ? 0 : (relative(this.root, dir)?.split('/').length ?? 0)
      const parentIndex = this.rows.findIndex((r) => r.entry.path === dir)
      const index = parentIndex + 1
      const el = h('div', 'row renaming')
      el.style.top = `${index * ROW_H}px`
      el.style.paddingLeft = `${6 + depth * 14 + 20}px`
      el.style.zIndex = '2'
      el.style.background = 'var(--bg-chrome)'
      const input = h('input')
      input.placeholder = kind === 'folder' ? 'Folder name' : 'File name'
      el.append(input)
      this.spacer.append(el)
      input.focus()
      let done = false
      const finish = (v: string | null): void => {
        if (done) return
        done = true
        el.remove()
        this.el.focus()
        resolve(v?.trim() || null)
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(input.value)
        if (e.key === 'Escape') finish(null)
      })
      input.addEventListener('blur', () => finish(input.value))
    })
  }

  private startRename(entry: DirEntry): void {
    this.renaming = entry.path
    this.paintNow()
    const el = this.pool.find((r) => this.rows[Number(r.dataset.i)]?.entry.path === entry.path)
    if (!el) {
      this.renaming = null
      return
    }
    const input = h('input')
    input.value = entry.name
    el.insertBefore(input, el.children[2])
    input.focus()
    const dot = entry.dir ? -1 : entry.name.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
    let done = false
    const finish = async (commit: boolean): Promise<void> => {
      if (done) return
      done = true
      const name = input.value.trim()
      this.renaming = null
      input.remove()
      if (commit && name && name !== entry.name) {
        const to = join(dirname(entry.path), name)
        try {
          await api.fs.rename(entry.path, to)
          await this.changed([entry.path, to])
          this.selected = to
        } catch {
          // Name taken or invalid; the row simply keeps its old name.
        }
      }
      this.paint()
      this.el.focus()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') void finish(true)
      if (e.key === 'Escape') void finish(false)
    })
    input.addEventListener('blur', () => void finish(true))
  }
}
