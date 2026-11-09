import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { MsysMounts } from '../shared/paths'
import { normalize } from '../shared/paths'

export interface ShellSpec {
  /** Short name shown on the terminal tab. */
  name: string
  file: string
  args: string[]
  env: Record<string, string>
  /** True when the shell reports OSC 133 and OSC 7 through our integration script. */
  integrated: boolean
  /** Set for Git Bash so terminal paths like /c/Users can be mapped back. */
  msys?: MsysMounts
}

let cached: string | null | undefined

/** Finds Git for Windows' bash.exe, the launcher in <git>\bin that sets up MSYSTEM and PATH. */
export function findGitBash(): string | null {
  if (cached !== undefined) return cached
  const env = process.env
  const roots = [
    env.ProgramFiles && join(env.ProgramFiles, 'Git'),
    env['ProgramW6432'] && join(env['ProgramW6432'], 'Git'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git'),
    join(homedir(), 'scoop', 'apps', 'git', 'current')
  ].filter(Boolean) as string[]
  for (const root of roots) {
    const bash = join(root, 'bin', 'bash.exe')
    if (existsSync(bash)) return (cached = bash)
  }
  // Fall back to wherever git.exe lives on PATH: <git>\cmd\git.exe or <git>\bin\git.exe.
  try {
    const out = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true })
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const bash = join(dirname(dirname(line.trim())), 'bin', 'bash.exe')
      if (existsSync(bash)) return (cached = bash)
    }
  } catch {
    // where.exe exits 1 when git is not on PATH.
  }
  return (cached = null)
}

export function defaultShell(integrationDir: string): ShellSpec {
  const script = join(integrationDir, 'bash-integration.sh')
  if (process.platform === 'win32') {
    const bash = findGitBash()
    if (bash) {
      const root = dirname(dirname(bash))
      return {
        name: 'bash',
        file: bash,
        // --init-file only applies to a non-login shell, so the script replays
        // the login startup files itself when BYNDERY_SHELL_LOGIN is set.
        args: ['--init-file', toMsysArg(script), '-i'],
        env: {
          BYNDERY_SHELL_LOGIN: '1',
          MSYSTEM: 'MINGW64',
          CHERE_INVOKING: '1'
        },
        integrated: true,
        msys: { root: normalize(root), tmp: process.env.TEMP ? normalize(process.env.TEMP) : undefined }
      }
    }
    return { name: 'powershell', file: 'powershell.exe', args: ['-NoLogo'], env: {}, integrated: false }
  }
  const user = process.env.SHELL || '/bin/bash'
  if (/bash$/.test(user)) {
    return {
      name: 'bash',
      file: user,
      args: ['--init-file', script, '-i'],
      env: { BYNDERY_SHELL_LOGIN: process.platform === 'darwin' ? '1' : '' },
      integrated: true
    }
  }
  return { name: user.split('/').pop() || 'shell', file: user, args: ['-l'], env: {}, integrated: false }
}

/** bash.exe accepts Windows paths, but only with forward slashes when quoted through MSYS argv conversion. */
function toMsysArg(p: string): string {
  return p.replace(/\\/g, '/')
}
