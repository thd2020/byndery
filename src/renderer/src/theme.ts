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

// Well-known schemes, with the colours Windows Terminal ships for them.
const scheme = (bg: string, fg: string, c: string[]): ITheme => ({
  background: bg,
  foreground: fg,
  black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15]
})
const solarized = ['#002B36', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#EEE8D5', '#073642', '#CB4B16', '#586E75', '#657B83', '#839496', '#6C71C4', '#93A1A1', '#FDF6E3']
const FIXED: Record<string, ITheme> = {
  Campbell: scheme('#0C0C0C', '#CCCCCC', ['#0C0C0C', '#C50F1F', '#13A10E', '#C19C00', '#0037DA', '#881798', '#3A96DD', '#CCCCCC', '#767676', '#E74856', '#16C60C', '#F9F1A5', '#3B78FF', '#B4009E', '#61D6D6', '#F2F2F2']),
  'One Half Dark': scheme('#282C34', '#DCDFE4', ['#282C34', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#DCDFE4', '#5A6374', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#DCDFE4']),
  'One Half Light': scheme('#FAFAFA', '#383A42', ['#383A42', '#E45649', '#50A14F', '#C18301', '#0184BC', '#A626A4', '#0997B3', '#FAFAFA', '#4F525D', '#DF6C75', '#98C379', '#E4C07A', '#61AFEF', '#C577DD', '#56B5C1', '#FFFFFF']),
  'Solarized Dark': scheme('#002B36', '#839496', solarized),
  'Solarized Light': scheme('#FDF6E3', '#657B83', solarized),
  'Tango Dark': scheme('#000000', '#D3D7CF', ['#000000', '#CC0000', '#4E9A06', '#C4A000', '#3465A4', '#75507B', '#06989A', '#D3D7CF', '#555753', '#EF2929', '#8AE234', '#FCE94F', '#729FCF', '#AD7FA8', '#34E2E2', '#EEEEEC'])
}

/** "byndery" follows the app's light or dark theme; the others are fixed. */
export const SCHEMES = ['byndery', ...Object.keys(FIXED)]

export function terminalTheme(name = 'byndery'): ITheme {
  const chrome = {
    selectionInactiveBackground: cssVar('--bg-active'),
    scrollbarSliderBackground: cssVar('--bg-active'),
    scrollbarSliderHoverBackground: cssVar('--line-strong'),
    scrollbarSliderActiveBackground: cssVar('--text-3')
  }
  const fixed = FIXED[name]
  if (fixed) {
    return { ...fixed, ...chrome, cursor: fixed.foreground, cursorAccent: fixed.background, selectionBackground: cssVar('--selection') }
  }
  return {
    ...(isDark() ? DARK : LIGHT),
    ...chrome,
    background: cssVar('--bg-pane'),
    foreground: cssVar('--text'),
    cursor: cssVar('--accent'),
    cursorAccent: cssVar('--bg-pane'),
    selectionBackground: cssVar('--selection')
  }
}
