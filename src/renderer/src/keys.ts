import { isMac } from './bridge'

// Shortcuts the app takes even while the terminal has focus. VS Code does the
// same for quick open and the sidebar; everything else, Ctrl+W and Ctrl+E
// included, goes to the shell untouched.
export function isAppShortcut(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod || e.altKey) return false
  const k = e.key.toLowerCase()
  if (k === 'p' || k === 'b' || k === 'o') return true
  if (e.code === 'Backquote') return true
  if (k === 'tab' || k === 'pageup' || k === 'pagedown') return true
  if (e.shiftKey && k === 'e') return true
  if (k === '=' || k === '-' || k === '0' || k === ',') return true
  return false
}

/** "Ctrl+Shift+P" style label for the current platform. */
export function keyLabel(accel: string): string {
  if (!isMac) return accel.replace(/Mod/g, 'Ctrl')
  return accel.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace(/Ctrl\+/g, '⌃')
}
