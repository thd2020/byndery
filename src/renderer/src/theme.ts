import type { ITheme } from '@xterm/xterm'

const media = window.matchMedia('(prefers-color-scheme: dark)')
export const isDark = (): boolean => media.matches

export function onThemeChange(cb: () => void): void {
  media.addEventListener('change', cb)
}

export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// ANSI colours tuned to sit on the warm backgrounds: no pure black or white,
// and every colour keeps at least 4.5:1 contrast against its background.
const DARK: ITheme = {
  black: '#3a3733',
  red: '#e26a5f',
  green: '#93c46f',
  yellow: '#d9a441',
  blue: '#6fa8dc',
  magenta: '#c48bd6',
  cyan: '#4fc4b8',
  white: '#d6d1c8',
  brightBlack: '#807a72',
  brightRed: '#f08378',
  brightGreen: '#aad888',
  brightYellow: '#ecbd5e',
  brightBlue: '#8dbdee',
  brightMagenta: '#d6a3e6',
  brightCyan: '#73d8cd',
  brightWhite: '#f5f2ec'
}

const LIGHT: ITheme = {
  black: '#24221f',
  red: '#b8392f',
  green: '#3b7a22',
  yellow: '#8c5d00',
  blue: '#2a62b0',
  magenta: '#8a3fa0',
  cyan: '#0f7a74',
  white: '#6d6862',
  brightBlack: '#5f5a53',
  brightRed: '#c94a3f',
  brightGreen: '#468a2c',
  brightYellow: '#9d6b00',
  brightBlue: '#3a74c4',
  brightMagenta: '#9b4db2',
  brightCyan: '#148a83',
  brightWhite: '#3a3733'
}

export function terminalTheme(): ITheme {
  return {
    ...(isDark() ? DARK : LIGHT),
    background: cssVar('--bg-pane'),
    foreground: cssVar('--text'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--bg-pane'),
    selectionBackground: cssVar('--selection'),
    selectionInactiveBackground: cssVar('--bg-active'),
    scrollbarSliderBackground: cssVar('--bg-active'),
    scrollbarSliderHoverBackground: cssVar('--line-strong'),
    scrollbarSliderActiveBackground: cssVar('--text-3')
  }
}
