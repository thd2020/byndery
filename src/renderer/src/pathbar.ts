import { fromMsys, isWindowsPath, join, normalize } from '../../shared/paths'
import { api, Emitter, h } from './bridge'

/**
 * The tree's folder as a breadcrumb, the way Explorer and Dolphin show it.
 * A segment goes to that folder; a click on the empty part of the bar turns
 * it into a text field that takes C:\x, /c/x, ~/x or a path relative to the
 * folder shown.
 */
export class PathBar {
  readonly navigate = new Emitter<string>()
  private path = ''

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      if (e.target === el) this.edit()
    })
    el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.crumb')) this.edit()
    })
  }

  set(path: string): void {
    this.path = normalize(path)
    this.render()
  }

  private render(): void {
    const parts = segments(this.path)
    this.el.replaceChildren()
    parts.forEach((p, i) => {
      if (i > 0) this.el.append(h('span', 'crumb-sep', '/'))
      const b = h('button', i === parts.length - 1 ? 'crumb current' : 'crumb', p.label)
      b.title = native(p.path)
      b.addEventListener('click', () => {
        if (p.path !== this.path) this.navigate.emit(p.path)
      })
      this.el.append(b)
    })
    this.el.title = native(this.path)
    // Long paths keep their end in view.
    requestAnimationFrame(() => {
      this.el.scrollLeft = this.el.scrollWidth
      this.el.classList.toggle('clipped', this.el.scrollWidth > this.el.clientWidth)
    })
  }

  /** Swaps the breadcrumb for a text field holding the full path. */
  edit(): void {
    const input = h('input', 'crumb-input')
    input.value = native(this.path)
    input.spellcheck = false
    input.setAttribute('aria-label', 'Folder path')
    this.el.replaceChildren(input)
    input.focus()
    input.select()
    let done = false
    const finish = async (go: boolean): Promise<void> => {
      if (done) return
      const target = go ? resolveTyped(input.value, this.path) : null
      if (target && target !== this.path) {
        const st = await api.fs.stat(target)
        if (!st?.dir) {
          input.classList.add('invalid')
          input.focus()
          return
        }
        done = true
        this.navigate.emit(target)
        return
      }
      done = true
      this.render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') void finish(true)
      if (e.key === 'Escape') void finish(false)
      if (e.key !== 'Enter') input.classList.remove('invalid')
    })
    input.addEventListener('blur', () => void finish(false))
  }
}

/** The path as the platform writes it: backslashes on Windows. */
const native = (p: string): string => (api.platform === 'win32' ? p.replace(/\//g, '\\') : p)

function segments(path: string): { label: string; path: string }[] {
  const home = normalize(api.sys.home)
  const out: { label: string; path: string }[] = []
  let rest = path
  let base = ''
  if (path === home || path.startsWith(home + '/')) {
    out.push({ label: '~', path: home })
    base = home
    rest = path.slice(home.length + 1)
  } else if (/^[A-Za-z]:/.test(path)) {
    base = path.slice(0, 2) + '/'
    out.push({ label: path.slice(0, 2), path: base })
    rest = path.slice(3)
  } else {
    base = '/'
    out.push({ label: '/', path: '/' })
    rest = path.slice(1)
  }
  for (const name of rest.split('/').filter(Boolean)) {
    base = join(base, name)
    out.push({ label: name, path: base })
  }
  return out
}

/** A typed or pasted folder: C:\x, /c/x, ~/x, or relative to `from`. */
export function resolveTyped(input: string, from: string): string | null {
  const s = input.trim().replace(/^["']|["']$/g, '')
  if (!s) return null
  if (s === '~') return normalize(api.sys.home)
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(api.sys.home, s.slice(2))
  if (isWindowsPath(s)) return normalize(s.length === 2 ? s + '/' : s)
  if (/^\/[A-Za-z](\/|$)/.test(s) && api.platform === 'win32') return fromMsys(s)
  if (s.startsWith('/')) return normalize(s)
  return join(from, s)
}
