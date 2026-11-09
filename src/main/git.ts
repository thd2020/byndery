import { execFile } from 'node:child_process'
import type { GitCode, GitState } from '../shared/api'
import { join, normalize } from '../shared/paths.ts'

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) =>
      resolve(err ? null : out)
    )
  })
}

const EMPTY: GitState = { root: null, branch: null, ahead: 0, behind: 0, files: {}, ignored: [] }

export async function status(dir: string): Promise<GitState> {
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return EMPTY
  const root = normalize(top.trim())
  // --ignored=matching with normal untracked mode reports an ignored directory
  // once instead of every file inside it, which keeps node_modules cheap.
  const out = await git(root, [
    '-c', 'core.quotepath=false',
    'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching'
  ])
  if (out == null) return { ...EMPTY, root }
  return parse(root, out)
}

export function parse(root: string, out: string): GitState {
  const state: GitState = { root, branch: null, ahead: 0, behind: 0, files: {}, ignored: [] }
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    if (!r) continue
    if (r.startsWith('# branch.head ')) {
      const b = r.slice(14)
      state.branch = b === '(detached)' ? null : b
    } else if (r.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(r)
      if (m) [state.ahead, state.behind] = [Number(m[1]), Number(m[2])]
    } else if (r[0] === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = r.split(' ')
      state.files[join(root, f.slice(8).join(' '))] = code(f[1])
    } else if (r[0] === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next record
      const f = r.split(' ')
      state.files[join(root, f.slice(9).join(' '))] = 'R'
      i++
    } else if (r[0] === 'u') {
      const f = r.split(' ')
      state.files[join(root, f.slice(10).join(' '))] = 'C'
    } else if (r[0] === '?') {
      state.files[join(root, r.slice(2))] = 'U'
    } else if (r[0] === '!') {
      state.ignored.push(join(root, r.slice(2)))
    }
  }
  return state
}

function code(xy: string): GitCode {
  if (xy.includes('D')) return 'D'
  if (xy[0] === 'A') return 'A'
  if (xy.includes('R')) return 'R'
  return 'M'
}

/** The file as it is in HEAD, for showing what changed since the last commit. */
export async function show(path: string): Promise<string | null> {
  const p = normalize(path)
  const dir = p.slice(0, p.lastIndexOf('/')) || p
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return null
  const root = normalize(top.trim())
  const rel = p.slice(root.length + 1)
  return git(root, ['show', `HEAD:${rel}`])
}
