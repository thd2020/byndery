// Path helpers shared by the main process and the renderer. Git Bash prints
// MSYS paths (/c/Users/me), Windows tools print C:\Users\me, and the editor
// keys files by one canonical form: forward slashes, upper-case drive letter.

export const isWindowsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p)

/** Canonical form: forward slashes, drive letter upper-cased, no trailing slash. */
export function normalize(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/') && !/^[A-Z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export interface MsysMounts {
  /** Windows directory that MSYS calls "/", e.g. C:/Program Files/Git */
  root: string
  /** Windows directory behind /tmp */
  tmp?: string
}

/** /c/Users/me -> C:/Users/me; /usr/bin -> <root>/usr/bin. Non-MSYS input is normalized. */
export function fromMsys(p: string, mounts?: MsysMounts): string {
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (drive) return normalize(`${drive[1].toUpperCase()}:${drive[2] ?? '/'}`)
  const cyg = /^\/cygdrive\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (cyg) return normalize(`${cyg[1].toUpperCase()}:${cyg[2] ?? '/'}`)
  if (p.startsWith('/') && mounts) {
    if (mounts.tmp && (p === '/tmp' || p.startsWith('/tmp/'))) return normalize(mounts.tmp + p.slice(4))
    return normalize(mounts.root + p)
  }
  return normalize(p)
}

/** C:/Users/me -> /c/Users/me, for pasting into Git Bash. */
export function toMsys(p: string): string {
  const s = normalize(p)
  const m = /^([A-Z]):(\/.*)?$/.exec(s)
  if (!m) return s
  return `/${m[1].toLowerCase()}${m[2] ?? ''}`
}

/** Quote a path for a POSIX shell only when it needs it. */
export function shellQuote(p: string): string {
  if (/^[\w@%+=:,./-]+$/.test(p)) return p
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

export function join(base: string, rel: string): string {
  if (isWindowsPath(rel) || rel.startsWith('/')) return normalize(rel)
  const parts = normalize(base).split('/')
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (parts.length > 1) parts.pop() } else parts.push(seg)
  }
  return normalize(parts.join('/'))
}

export const basename = (p: string): string => normalize(p).split('/').pop() ?? p
export const dirname = (p: string): string => {
  const s = normalize(p)
  const i = s.lastIndexOf('/')
  if (i <= 0) return s
  const d = s.slice(0, i)
  return /^[A-Z]:$/.test(d) ? d + '/' : d
}

/**
 * Path from directory `from` to `to`, climbing with ".." when needed, or null
 * when they are on different drives or the climb is deeper than `maxUp`.
 */
export function relativeFrom(from: string, to: string, maxUp = 3): string | null {
  const a = normalize(from).split('/')
  const b = normalize(to).split('/')
  const winPath = /^[A-Z]:$/.test(a[0])
  const same = (x: string, y: string): boolean => (winPath ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (!same(a[0], b[0])) return null
  let i = 0
  while (i < a.length && i < b.length && same(a[i], b[i])) i++
  const up = a.length - i
  if (up > maxUp) return null
  const rel = [...Array(up).fill('..'), ...b.slice(i)].join('/')
  return rel || '.'
}

/** Path of `p` relative to `root`, or null when `p` is outside it. */
export function relative(root: string, p: string): string | null {
  const r = normalize(root), s = normalize(p)
  if (s === r) return ''
  const prefix = r.endsWith('/') ? r : r + '/'
  // Drive-letter paths are Windows paths, and Windows compares them case-insensitively.
  if (/^[A-Z]:/.test(r)) {
    return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s.slice(prefix.length) : null
  }
  return s.startsWith(prefix) ? s.slice(prefix.length) : null
}
