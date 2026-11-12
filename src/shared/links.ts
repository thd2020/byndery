// Finds file references in a line of terminal output. Agents and compilers
// print paths in a handful of shapes, and each one here comes from a tool
// people run beside byndery:
//
//   src/app.ts:12:5          tsc, eslint, ripgrep, Claude Code
//   src/app.ts(12,5)         tsc on Windows, MSBuild
//   File "app.py", line 12   Python tracebacks
//   /c/Users/me/a.md         Git Bash
//   C:\Users\me\a.md         Windows tools
//   @src/app.ts#L12-20       Claude Code file mentions
//
// Trailing punctuation, including the full-width marks CJK text uses, is never
// part of the path.

export interface PathMatch {
  /** Start and end offsets in the line (end exclusive), covering path and position. */
  start: number
  end: number
  path: string
  line?: number
  col?: number
}

const PATH_CHAR = String.raw`[^\s"'\x60<>|*?(){}\[\]，。；：、！？）（」「』『】【]`
const TRAILING = /[.,;:!?'"\x60)\]}>，。；：、！？）」』】]+$/

// A candidate either has a directory separator or ends in a short extension,
// which keeps plain words like "done." from becoming links.
const CANDIDATE = new RegExp(
  String.raw`(?<![\w/\\.-])@?(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?${PATH_CHAR}+`,
  'g'
)

export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []

  const py = /File "([^"]+)", line (\d+)/g
  for (let m; (m = py.exec(text)); ) {
    const start = m.index + 6
    out.push({ start, end: m.index + m[0].length, path: m[1], line: Number(m[2]) })
  }

  for (let m; (m = CANDIDATE.exec(text)); ) {
    let raw = m[0]
    let start = m.index
    if (out.some((o) => start >= o.start && start < o.end)) continue
    if (raw.startsWith('@')) {
      raw = raw.slice(1)
      start++
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue

    // Position suffixes: :12, :12:5, #L12, #L12-20; MSBuild's (12,5) follows the match.
    let line: number | undefined
    let col: number | undefined
    let path = raw.replace(TRAILING, '')
    let pos = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L?\d+)?)$/.exec(path)
    if (pos) {
      line = Number(pos[1] ?? pos[3])
      col = pos[2] ? Number(pos[2]) : undefined
      path = path.slice(0, pos.index)
    }
    path = path.replace(TRAILING, '')
    let end = start + path.length + (pos ? pos[0].length : 0)
    if (!pos) {
      const ms = /^\((\d+)(?:,(\d+))?\)/.exec(text.slice(start + path.length))
      if (ms) {
        line = Number(ms[1])
        col = ms[2] ? Number(ms[2]) : undefined
        end = start + path.length + ms[0].length
      }
    }

    if (!looksLikePath(path)) continue
    out.push({ start, end, path, line, col })
  }
  return out.sort((a, b) => a.start - b.start)
}

function looksLikePath(p: string): boolean {
  if (p.length < 2 || /^\d+$/.test(p) || /^[-=_.]+$/.test(p)) return false
  if (/[\\/]/.test(p)) return !/^[\\/]+$/.test(p)
  // Bare file name: needs an extension of letters, e.g. README.md, not 1.5 or v2.0.
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9}$/.test(p)
}
