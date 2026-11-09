import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { MsysMounts } from '../shared/paths'
import { isWindowsPath, normalize, toMsys } from '../shared/paths'

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

export function defaultShell(dirs: ShellDirs): ShellSpec {
  const bashScript = join(dirs.integration, 'bash-integration.sh')
  if (process.platform === 'win32') {
    const msys = findMsys2(dirs.vendor)
    if (msys) {
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
    const bash = findGitBash()
    if (bash) {
      const root = dirname(dirname(bash))
      return {
        name: 'bash',
        file: bash,
        // --init-file only applies to a non-login shell, so the script replays
        // the login startup files itself when BYNDERY_SHELL_LOGIN is set.
        args: ['--init-file', bashScript.replace(/\\/g, '/'), '-i'],
        env: { BYNDERY_SHELL_LOGIN: '1', MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' },
        integrated: true,
        msys: { root: normalize(root), tmp: tmp() }
      }
    }
    return { name: 'powershell', file: 'powershell.exe', args: ['-NoLogo'], env: {}, integrated: false }
  }

  const user = process.env.SHELL || '/bin/zsh'
  if (/zsh$/.test(user)) {
    return { name: 'zsh', file: user, args: process.platform === 'darwin' ? ['-l', '-i'] : ['-i'], env: zshEnv(dirs), integrated: true }
  }
  if (/bash$/.test(user)) {
    return {
      name: 'bash',
      file: user,
      args: ['--init-file', bashScript, '-i'],
      env: { BYNDERY_SHELL_LOGIN: process.platform === 'darwin' ? '1' : '' },
      integrated: true
    }
  }
  return { name: user.split('/').pop() || 'shell', file: user, args: ['-l'], env: {}, integrated: false }
}
