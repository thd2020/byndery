import { existsSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { MsysMounts } from '../shared/paths'
import { isWindowsPath, normalize, toMsys } from '../shared/paths'
import type { Profile, ProfileEntry, Settings } from '../shared/settings'

export interface ShellSpec {
  /** Short name shown on the terminal tab. */
  name: string
  file: string
  args: string[]
  env: Record<string, string>
  /** True when the shell reports OSC 133 and OSC 7 through our integration scripts. */
  integrated: boolean
  /** Set for MSYS-based shells so terminal paths like /c/Users can be mapped back. */
  msys?: MsysMounts
}

/** Where the app's own files are: resources/shell, and vendor/ for MSYS2 and Powerlevel10k. */
export interface ShellDirs {
  integration: string
  vendor: string
  /** The one-line file that says which command languages the prompt accepts. */
  routing: string
  /** A writable per-user temp folder. */
  temp: string
}

const tmp = (): string | undefined => (process.env.TEMP ? normalize(process.env.TEMP) : undefined)

/** Finds Git for Windows' bash.exe, the launcher in <git>\bin that sets up MSYSTEM and PATH. */
export function findGitBash(): string | null {
  const env = process.env
  const roots = [
    env.ProgramFiles && join(env.ProgramFiles, 'Git'),
    env['ProgramW6432'] && join(env['ProgramW6432'], 'Git'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git'),
    join(homedir(), 'scoop', 'apps', 'git', 'current'),
    join(homedir(), 'scoop', 'apps', 'git-with-openssh', 'current')
  ].filter(Boolean) as string[]
  for (const root of roots) {
    const bash = join(root, 'bin', 'bash.exe')
    if (existsSync(bash)) return bash
  }
  // Fall back to wherever git.exe lives on PATH: <git>\cmd\git.exe or <git>\bin\git.exe.
  try {
    const out = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const bash = join(dirname(dirname(line.trim())), 'bin', 'bash.exe')
      if (existsSync(bash)) return bash
    }
  } catch {
    // where.exe exits 1 when git is not on PATH.
  }
  return null
}

/** An MSYS2 tree with zsh: the one bundled with byndery first, then a system install. */
function findMsys2(vendor: string): string | null {
  for (const root of [join(vendor, 'msys64'), 'C:\\msys64', join(homedir(), 'scoop', 'apps', 'msys2', 'current')]) {
    if (existsSync(join(root, 'usr', 'bin', 'zsh.exe'))) return root
  }
  return null
}

function zshEnv(dirs: ShellDirs): Record<string, string> {
  const zdot = join(dirs.integration, 'zsh')
  const env: Record<string, string> = {
    ZDOTDIR: zdot,
    BYNDERY_ZDOTDIR: zdot,
    BYNDERY_USER_ZDOTDIR: process.env.ZDOTDIR ?? '',
    BYNDERY_ROUTING_FILE: dirs.routing
  }
  const plugins = join(dirs.vendor, 'zsh-plugins')
  if (existsSync(plugins)) env.BYNDERY_ZSH_PLUGINS = plugins
  const p10k = join(dirs.vendor, 'powerlevel10k')
  if (existsSync(join(p10k, 'powerlevel10k.zsh-theme'))) {
    env.BYNDERY_P10K = p10k
    // gitstatusd ships with the app; it is never downloaded at run time.
    env.GITSTATUS_CACHE_DIR = join(dirs.vendor, 'gitstatus')
    env.GITSTATUS_AUTO_INSTALL = '0'
  }
  return env
}

// zsh under MSYS treats C:/x as a relative path, so every path handed to an
// MSYS shell goes in its /c/x form.
const msysEnv = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, isWindowsPath(v) ? toMsys(v) : v]))

/** A shell found on this computer, the way Windows Terminal generates profiles for installed shells. */
interface Detected {
  id: string
  name: string
  spec: ShellSpec
  routes: boolean
}

function msysZsh(dirs: ShellDirs, msys: string): ShellSpec {
  return {
    name: 'zsh',
    file: join(msys, 'usr', 'bin', 'zsh.exe'),
    args: ['-l', '-i'],
    env: msysEnv({
      ...zshEnv(dirs),
      // UCRT64 is the environment MSYS2 recommends; inheriting the Windows
      // PATH keeps node, claude, codex and every other Windows tool on hand.
      MSYSTEM: 'UCRT64',
      // Scratch space for the command router, per user and always writable.
      BYNDERY_TMP: dirs.temp,
      MSYS2_PATH_TYPE: 'inherit',
      CHERE_INVOKING: '1'
    }),
    integrated: true,
    msys: { root: normalize(msys), tmp: tmp() }
  }
}

function bashSpec(dirs: ShellDirs, file: string, msysRoot?: string): ShellSpec {
  const script = join(dirs.integration, 'bash-integration.sh')
  return {
    name: 'bash',
    file,
    // --init-file only applies to a non-login shell, so the script replays
    // the login startup files itself when BYNDERY_SHELL_LOGIN is set.
    args: ['--init-file', msysRoot ? script.replace(/\\/g, '/') : script, '-i'],
    env: msysRoot
      ? { BYNDERY_SHELL_LOGIN: '1', MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' }
      : { BYNDERY_SHELL_LOGIN: process.platform === 'darwin' ? '1' : '' },
    integrated: true,
    msys: msysRoot ? { root: normalize(msysRoot), tmp: tmp() } : undefined
  }
}

function onPath(exe: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [exe], { encoding: 'utf8', windowsHide: true })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null
  } catch {
    return null
  }
}

let detected: Detected[] | null = null

/** Shells on this computer, best first. Found once per run. */
export function detectShells(dirs: ShellDirs): Detected[] {
  if (detected) return detected
  const out: Detected[] = []
  if (process.platform === 'win32') {
    const msys = findMsys2(dirs.vendor)
    if (msys) out.push({ id: 'zsh', name: 'zsh', spec: msysZsh(dirs, msys), routes: true })
    const bash = findGitBash()
    if (bash) out.push({ id: 'git-bash', name: 'Git Bash', spec: bashSpec(dirs, bash, dirname(dirname(bash))), routes: false })
    const pwsh = onPath('pwsh.exe')
    if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell', spec: { name: 'pwsh', file: pwsh, args: ['-NoLogo'], env: {}, integrated: false }, routes: false })
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    out.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      spec: { name: 'powershell', file: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], env: {}, integrated: false },
      routes: false
    })
    out.push({ id: 'cmd', name: 'Command Prompt', spec: { name: 'cmd', file: join(root, 'System32', 'cmd.exe'), args: [], env: {}, integrated: false }, routes: false })
  } else {
    const login = process.env.SHELL || '/bin/zsh'
    const shells = [login, '/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/fish', '/usr/bin/fish'].filter((f, i, a) => a.indexOf(f) === i && existsSync(f))
    for (const file of shells) {
      const base = file.split('/').pop() ?? 'sh'
      if (out.some((d) => d.id === base)) continue
      const spec: ShellSpec =
        base === 'zsh'
          ? { name: 'zsh', file, args: process.platform === 'darwin' ? ['-l', '-i'] : ['-i'], env: zshEnv(dirs), integrated: true }
          : base === 'bash'
            ? bashSpec(dirs, file)
            : { name: base, file, args: ['-l'], env: {}, integrated: false }
      out.push({ id: base, name: base, spec, routes: false })
    }
  }
  detected = out
  return out
}

/** Detected shells and the user's own profiles, with every field resolved. */
export function resolveProfiles(dirs: ShellDirs, s: Settings): Profile[] {
  const list: Profile[] = []
  const make = (id: string, base: Partial<Profile>, entry: ProfileEntry = {}): Profile => ({
    ...s.profileDefaults,
    name: id,
    command: '',
    program: '',
    args: [],
    startIn: '',
    env: {},
    hidden: false,
    detected: false,
    routes: false,
    ...base,
    ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)),
    id
  })
  const withProgram = (p: Profile, fallback: string): Profile => ({ ...p, program: p.command || fallback })
  for (const d of detectShells(dirs)) list.push(withProgram(make(d.id, { name: d.name, detected: true, routes: d.routes }, s.profiles[d.id]), d.spec.file))
  for (const [id, entry] of Object.entries(s.profiles)) {
    if (!list.some((p) => p.id === id)) list.push(withProgram(make(id, { name: entry.name || id }, entry), ''))
  }
  return list
}

/** How to start a profile. A detected profile keeps byndery's integration unless its command was changed. */
export function specFor(dirs: ShellDirs, p: Profile): ShellSpec {
  const found = detectShells(dirs).find((d) => d.id === p.id)
  let spec: ShellSpec
  if (found && !p.command) spec = { ...found.spec, args: p.args.length ? p.args : found.spec.args }
  else {
    const file = p.command || found?.spec.file || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
    const base = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').toLowerCase()
    if (base === 'zsh' && process.platform !== 'win32') spec = { name: 'zsh', file, args: ['-i'], env: zshEnv(dirs), integrated: true }
    else if (base === 'bash' && process.platform !== 'win32') spec = bashSpec(dirs, file)
    else spec = { name: base, file, args: [], env: {}, integrated: false }
    if (p.args.length) spec.args = p.args
  }
  const env: Record<string, string> = { ...spec.env }
  if (spec.name === 'zsh') {
    if (p.promptStyle === 'own') env.BYNDERY_PROMPT = 'keep'
    else env.BYNDERY_PROMPT_STYLE = p.promptStyle
  }
  for (const [k, v] of Object.entries(p.env)) env[k] = spec.msys && isWindowsPath(v) ? toMsys(v) : v
  return { ...spec, env }
}

/** The byndery zsh: the one shell whose prompt routes lines to PowerShell and cmd. */
function routingZsh(dirs: ShellDirs): ShellSpec | null {
  return detectShells(dirs).find((d) => d.routes)?.spec ?? null
}

/**
 * Which system the byndery prompt would run a line in, and why, by asking the
 * router itself, so Settings never guesses differently from the shell.
 */
export function explainRoute(dirs: ShellDirs, line: string): Promise<{ system: string; reason: string } | null> {
  const zsh = routingZsh(dirs)
  if (!zsh) return Promise.resolve(null)
  const script = toMsys(join(dirs.integration, 'zsh', 'windows.zsh'))
  return new Promise((resolve) => {
    execFile(
      zsh.file,
      ['-f', '-c', 'source "$1"; __byndery_explain "$2"', 'zsh', script, line],
      { env: { ...process.env, ...zsh.env, BYNDERY_EXPLAIN: '1', MSYS2_ARG_CONV_EXCL: '*' }, timeout: 8000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const [system, ...why] = (stdout ?? '').trim().split('\t')
        resolve(!system || (err && !stdout) ? null : { system, reason: why.join('\t') })
      }
    )
  })
}
