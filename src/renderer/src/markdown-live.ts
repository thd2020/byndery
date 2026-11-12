import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { dirname, join, isWindowsPath, normalize } from '../../shared/paths'

// Live preview in the style of Obsidian: Markdown renders in place, and the
// syntax of a construct reappears only while the cursor is inside it, so the
// file on disk stays plain CommonMark and every edit is a normal text edit.

export interface LiveOptions {
  /** The file's own path, so relative links and images resolve against its folder. */
  path: () => string
  openLink: (target: string, external: boolean) => void
}

class Bullet extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'md-bullet'
    s.textContent = '•'
    return s
  }
  eq(): boolean {
    return true
  }
}

class Check extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number
  ) {
    super()
  }
  eq(o: Check): boolean {
    return o.checked === this.checked && o.pos === this.pos
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'md-check'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class Rule extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'md-hr'
    return s
  }
  eq(): boolean {
    return true
  }
}

class Image extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  eq(o: Image): boolean {
    return o.src === this.src
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'md-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.onerror = () => wrap.classList.add('broken')
    wrap.append(img)
    return wrap
  }
}

const hide = Decoration.replace({})
const line = (cls: string): Decoration => Decoration.line({ class: cls })
const mark = (cls: string): Decoration => Decoration.mark({ class: cls })

// While the editor does not have focus nothing counts as under the cursor, so
// a file opened from the tree or the terminal shows fully rendered.
let focused = false

function touches(state: EditorState, from: number, to: number): boolean {
  if (!focused) return false
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true
  return false
}

function lineTouches(state: EditorState, from: number, to: number): boolean {
  const a = state.doc.lineAt(from).from
  const b = state.doc.lineAt(to).to
  return touches(state, a, b)
}

export function resolveImage(src: string, filePath: string): string {
  if (/^(https?:|data:)/.test(src)) return src
  const clean = decodeURI(src.replace(/^<|>$/g, ''))
  const abs = isWindowsPath(clean) || clean.startsWith('/') ? normalize(clean) : join(dirname(filePath), clean)
  return 'byndery-file://local/' + encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

function build(view: EditorView, opts: LiveOptions): DecorationSet {
  const { state } = view
  focused = view.hasFocus
  const decos: Range<Decoration>[] = []
  const tree = syntaxTree(state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        const name = n.name
        const heading = /^ATXHeading(\d)$/.exec(name)
        if (heading) {
          decos.push(line(`md-h md-h${heading[1]}`).range(n.from))
          return
        }
        if (/^SetextHeading(\d)$/.test(name)) {
          decos.push(line(`md-h md-h${name.slice(-1)}`).range(n.from))
          return
        }
        switch (name) {
          case 'HeaderMark': {
            if (n.node.parent?.name.startsWith('SetextHeading')) {
              if (!lineTouches(state, n.from, n.to)) decos.push(line('md-setext-mark').range(state.doc.lineAt(n.from).from))
              break
            }
            if (lineTouches(state, n.from, n.to)) decos.push(mark('md-syntax').range(n.from, n.to))
            else {
              const after = state.doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to
              decos.push(hide.range(n.from, after))
            }
            break
          }
          case 'EmphasisMark':
          case 'CodeMark':
          case 'StrikethroughMark': {
            const parent = n.node.parent
            if (!parent) break
            if (parent.name === 'FencedCode') {
              decos.push(mark('md-fence').range(n.from, n.to))
              break
            }
            if (touches(state, parent.from, parent.to)) decos.push(mark('md-syntax').range(n.from, n.to))
            else decos.push(hide.range(n.from, n.to))
            break
          }
          case 'InlineCode':
            decos.push(mark('md-code').range(n.from, n.to))
            break
          case 'Strikethrough':
            decos.push(mark('md-strike').range(n.from, n.to))
            break
          case 'Link': {
            const node = n.node
            const url = node.getChild('URL')
            const marks = node.getChildren('LinkMark')
            if (!url || marks.length < 2) break
            const target = state.doc.sliceString(url.from, url.to)
            const textFrom = marks[0].to
            const textTo = marks[1].from
            decos.push(
              Decoration.mark({ class: 'md-link', attributes: { 'data-href': target, title: target } }).range(textFrom, textTo)
            )
            if (!touches(state, n.from, n.to)) {
              decos.push(hide.range(n.from, textFrom))
              decos.push(hide.range(textTo, n.to))
            } else {
              decos.push(mark('md-syntax').range(n.from, textFrom))
              decos.push(mark('md-syntax').range(textTo, n.to))
            }
            // Keep walking: inline code or emphasis inside the link text still renders.
            return undefined
          }
          case 'URL':
            if (n.node.parent?.name !== 'Link' && n.node.parent?.name !== 'Image') {
              const t = state.doc.sliceString(n.from, n.to)
              decos.push(Decoration.mark({ class: 'md-link', attributes: { 'data-href': t } }).range(n.from, n.to))
            }
            break
          case 'Image': {
            const url = n.node.getChild('URL')
            if (!url) break
            const src = state.doc.sliceString(url.from, url.to)
            const altMarks = n.node.getChildren('LinkMark')
            const alt = altMarks.length >= 2 ? state.doc.sliceString(altMarks[0].to, altMarks[1].from) : ''
            if (!touches(state, n.from, n.to)) {
              decos.push(Decoration.replace({ widget: new Image(resolveImage(src, opts.path()), alt) }).range(n.from, n.to))
            }
            return false
          }
          case 'ListMark': {
            const listItem = n.node.parent
            const bullet = listItem?.parent?.name === 'BulletList'
            const task = listItem?.getChild('Task')
            if (task) {
              decos.push(hide.range(n.from, Math.min(n.to + 1, task.from)))
              break
            }
            if (bullet && !touches(state, n.from, n.to)) {
              decos.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to))
            } else decos.push(mark('md-list-mark').range(n.from, n.to))
            break
          }
          case 'TaskMarker': {
            const checked = /x/i.test(state.doc.sliceString(n.from, n.to))
            if (!touches(state, n.from, n.to)) {
              decos.push(Decoration.replace({ widget: new Check(checked, n.from) }).range(n.from, n.to))
            }
            if (checked) {
              const l = state.doc.lineAt(n.from)
              if (n.to + 1 < l.to) decos.push(mark('md-done').range(n.to + 1, l.to))
            }
            break
          }
          case 'Blockquote': {
            for (let p = n.from; p <= n.to; ) {
              const l = state.doc.lineAt(p)
              decos.push(line('md-quote').range(l.from))
              p = l.to + 1
            }
            break
          }
          case 'QuoteMark':
            if (!lineTouches(state, n.from, n.to)) {
              const after = state.doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to
              decos.push(hide.range(n.from, after))
            } else decos.push(mark('md-syntax').range(n.from, n.to))
            break
          case 'FencedCode':
          case 'CodeBlock': {
            const first = state.doc.lineAt(n.from).number
            const last = state.doc.lineAt(n.to).number
            for (let i = first; i <= last; i++) {
              const l = state.doc.line(i)
              const cls = ['md-codeblock']
              if (i === first) cls.push('md-codeblock-first')
              if (i === last) cls.push('md-codeblock-last')
              decos.push(line(cls.join(' ')).range(l.from))
            }
            break
          }
          case 'CodeInfo':
            decos.push(mark('md-fence').range(n.from, n.to))
            break
          case 'HorizontalRule':
            if (!lineTouches(state, n.from, n.to)) decos.push(Decoration.replace({ widget: new Rule() }).range(n.from, n.to))
            break
          case 'Table': {
            const first = state.doc.lineAt(n.from).number
            const last = state.doc.lineAt(n.to).number
            for (let i = first; i <= last; i++) decos.push(line('md-table').range(state.doc.line(i).from))
            return false
          }
        }
        return undefined
      }
    })
  }
  return Decoration.set(decos, true)
}

export function livePreview(opts: LiveOptions) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) {
          this.decorations = build(view, opts)
        }
        update(u: ViewUpdate): void {
          if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
            this.decorations = build(u.view, opts)
          }
        }
      },
      { decorations: (v) => v.decorations }
    ),
    EditorView.domEventHandlers({
      mousedown: (e) => {
        const a = (e.target as HTMLElement).closest('[data-href]') as HTMLElement | null
        if (!a || !(e.ctrlKey || e.metaKey)) return false
        e.preventDefault()
        const href = a.dataset.href!
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !isWindowsPath(href)) opts.openLink(href, true)
        else {
          const [file] = href.split('#')
          if (file) opts.openLink(join(dirname(opts.path()), decodeURI(file)), false)
        }
        return true
      }
    }),
    EditorView.lineWrapping
  ]
}

