import { isMac } from './bridge'

/**
 * The app's key bindings as data. Every action has default keys and a
 * scope; Settings can replace the keys of any action. A key goes to the most
 * specific scope that binds it: the focused pane first, then the window.
 *
 * Keys are written the way Electron accelerators are, with Mod for Ctrl on
 * Windows and Linux and Cmd on macOS: "Mod+Shift+P", "F1", "Mod+`".
 */

/** Where focus has to be for an action's keys to work. */
export type Scope = 'window' | 'terminal' | 'editor' | 'tree'

export interface Action {
  id: string
  label: string
  /** Default keys; the first one is shown in menus and the palette. */
  keys: string[]
  scope: Scope
  run: () => void
  /** Left out of the command palette. */
  hidden?: boolean
}

const CODE_NAMES: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: '=',
  NumpadSubtract: '-'
}

/** The key of an event, from its physical position, so Shift and keyboard layouts do not change it. */
function keyName(e: KeyboardEvent): string | null {
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) return c.slice(3)
  if (/^Digit\d$/.test(c)) return c.slice(5)
  if (/^Numpad\d$/.test(c)) return c.slice(6)
  if (/^F\d{1,2}$/.test(c)) return c
  if (CODE_NAMES[c]) return CODE_NAMES[c]
  if (['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(c)) return c
  return null
}

/** "Mod+Shift+P" for a key event, or null for a bare modifier. */
export function chordOf(e: KeyboardEvent): string | null {
  const key = keyName(e)
  if (!key) return null
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (isMac && e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** Puts modifiers in one order, so "Shift+Mod+p" and "Mod+Shift+P" compare equal. */
export function normalizeChord(s: string): string {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = new Set(parts.map((p) => p.toLowerCase()))
  const out: string[] = []
  if (mods.has('mod') || mods.has('cmdorctrl') || (!isMac && mods.has('ctrl')) || (isMac && mods.has('cmd'))) out.push('Mod')
  if (isMac && mods.has('ctrl')) out.push('Ctrl')
  if (mods.has('alt') || mods.has('option')) out.push('Alt')
  if (mods.has('shift')) out.push('Shift')
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1))
  return out.join('+')
}

/** "Ctrl+Shift+P" on Windows and Linux, "⇧⌘P" on macOS. */
export function keyLabel(chord: string): string {
  if (!isMac) return chord.replace(/Mod/g, 'Ctrl')
  return chord.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃')
}

/** Electron accelerator syntax, for native menus. */
export const accelOf = (chord: string): string => chord.replace(/Mod/g, 'CmdOrCtrl')

export class Keymap {
  private actions = new Map<string, Action>()
  private overrides: Record<string, string[]> = {}
  private index = new Map<string, Action[]>()

  define(list: Action[]): void {
    for (const a of list) this.actions.set(a.id, a)
    this.rebuild()
  }

  /** Replaces the keys of the actions named in `keys`; an empty list unbinds. */
  setOverrides(keys: Record<string, string[]>): void {
    this.overrides = keys
    this.rebuild()
  }

  keysOf(id: string): string[] {
    return this.overrides[id] ?? this.actions.get(id)?.keys ?? []
  }

  get(id: string): Action | undefined {
    return this.actions.get(id)
  }

  all(): Action[] {
    return [...this.actions.values()]
  }

  private rebuild(): void {
    this.index.clear()
    for (const a of this.actions.values()) {
      for (const k of this.keysOf(a.id)) {
        const c = normalizeChord(k)
        const list = this.index.get(c) ?? []
        list.push(a)
        this.index.set(c, list)
      }
    }
  }

  /** The action a key event runs with focus in `scope`, if any. */
  match(e: KeyboardEvent, scope: Scope | null): Action | null {
    const chord = chordOf(e)
    if (!chord) return null
    const list = this.index.get(chord)
    if (!list) return null
    return list.find((a) => a.scope === scope) ?? list.find((a) => a.scope === 'window') ?? null
  }

  /** Actions bound to the same keys in overlapping scopes, for Settings to flag. */
  conflicts(id: string): Action[] {
    const a = this.actions.get(id)
    if (!a) return []
    const mine = new Set(this.keysOf(id).map(normalizeChord))
    return this.all().filter(
      (b) =>
        b !== a &&
        (b.scope === a.scope || b.scope === 'window' || a.scope === 'window') &&
        this.keysOf(b.id).some((k) => mine.has(normalizeChord(k)))
    )
  }
}

/** Which pane has focus, as a keymap scope. */
export function focusScope(): Scope | null {
  const el = document.activeElement
  if (!el || el === document.body) return null
  if (el.closest('#terminals')) return 'terminal'
  if (el.closest('#editor')) return 'editor'
  if (el.closest('#sidebar')) return 'tree'
  return null
}
