// Builds byndery-handoff.exe, the COM class that lets Windows hand console
// programs to byndery (src/handoff/byndery-handoff.cpp), into build/handoff/.
// electron-builder packages it under resources/handoff/ for Windows.
//
//   node scripts/build-handoff.mjs [--arch x64|arm64]
//
// Needs Visual Studio or its Build Tools with the C++ workload, found through
// vswhere. Does nothing on macOS and Linux.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

if (process.platform !== 'win32') {
  console.log('[build-handoff] not Windows, nothing to build')
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const archArg = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : process.arch
const arch = archArg === 'arm64' ? 'arm64' : 'x64'
const source = join(root, 'src', 'handoff', 'byndery-handoff.cpp')
const outDir = join(root, 'build', 'handoff')
const exe = join(outDir, 'byndery-handoff.exe')

const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
if (!existsSync(vswhere)) throw new Error('vswhere.exe not found; install Visual Studio Build Tools with the C++ workload')
// The newest installation that has the C++ build environment (ARM64 hosts name the tools differently, so look for the file).
const vcvars = execFileSync(vswhere, ['-products', '*', '-sort', '-property', 'installationPath'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((dir) => join(dir.trim(), 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat'))
  .find((file) => existsSync(file))
if (!vcvars) throw new Error('No Visual Studio installation with the C++ tools was found')

// vcvarsall takes host_target; a native ARM64 host uses "arm64", an x64 host cross-compiles with "x64_arm64".
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const vcArch = hostArch === arch ? arch : `${hostArch}_${arch}`

mkdirSync(outDir, { recursive: true })
const flags = [
  '/nologo', '/O2', '/MT', '/EHsc', '/W4', '/std:c++17', '/DUNICODE', '/D_UNICODE',
  `"${source}"`, `/Fe:"${exe}"`, `/Fo:"${join(outDir, 'byndery-handoff.obj')}"`,
  '/link', '/SUBSYSTEM:WINDOWS', 'ole32.lib', 'oleaut32.lib', 'advapi32.lib', 'user32.lib', 'shell32.lib', 'uuid.lib'
]
// A batch file keeps cmd.exe's quoting out of the way.
const script = join(tmpdir(), `byndery-build-handoff-${process.pid}.cmd`)
writeFileSync(script, `@echo off\r\ncall "${vcvars}" ${vcArch} >nul || exit /b 1\r\ncl ${flags.join(' ')} || exit /b 1\r\n`)
try {
  execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit' })
} finally {
  rmSync(script, { force: true })
}
if (!existsSync(exe)) throw new Error(`${exe} was not produced`)
console.log(`[build-handoff] built ${exe} (${arch})`)
