// Builds the shell environment byndery ships on Windows: MSYS2 with zsh and
// git, Powerlevel10k, and the gitstatus binary Powerlevel10k uses. The result
// lands in vendor/ and is packaged as the app's own terminal environment.
//
//   node scripts/vendor-shell.mjs [--mirror tuna|ustc|official] [--force]
//
// Every step can be re-run; finished steps are skipped. On macOS and Linux
// only Powerlevel10k is fetched, because zsh is already part of the system.

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

// The base archive is pinned. Its signature was checked against MSYS2's
// installer key (0EBF 782C 5D53 F7E5 FB02 A667 46BD 761F 7A49 B0EC) when the
// pin was set; the hash keeps every later download identical to that one.
const MSYS2 = {
  file: 'msys2-base-x86_64-20260927.tar.xz',
  sha256: 'ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322'
}
const MIRRORS = {
  official: { distrib: 'https://repo.msys2.org/distrib/x86_64/', repo: 'https://repo.msys2.org/' },
  tuna: { distrib: 'https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/', repo: 'https://mirrors.tuna.tsinghua.edu.cn/msys2/' },
  ustc: { distrib: 'https://mirrors.ustc.edu.cn/msys2/distrib/x86_64/', repo: 'https://mirrors.ustc.edu.cn/msys2/' }
}
const P10K_REPOS = ['https://github.com/romkatv/powerlevel10k.git', 'https://gitee.com/romkatv/powerlevel10k.git']
const PACKAGES = ['zsh', 'git']

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const force = args.includes('--force')
const mirror = MIRRORS[opt('mirror', process.env.BYNDERY_MSYS2_MIRROR || 'official')] ?? MIRRORS.official

const root = resolve(import.meta.dirname, '..')
const vendor = join(root, 'vendor')
const cache = join(vendor, '.cache')
const msys = join(vendor, 'msys64')
mkdirSync(cache, { recursive: true })

const log = (s) => console.log(`[vendor-shell] ${s}`)

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function fetchArchive() {
  const dest = join(cache, MSYS2.file)
  if (existsSync(dest) && sha256(dest) === MSYS2.sha256) return dest
  for (const m of [mirror, MIRRORS.official]) {
    log(`downloading ${MSYS2.file} from ${new URL(m.distrib).host}`)
    try {
      await download(m.distrib + MSYS2.file, dest)
      if (sha256(dest) === MSYS2.sha256) return dest
      log('checksum mismatch, trying the next source')
    } catch (e) {
      log(`download failed: ${e.message}`)
    }
  }
  rmSync(dest, { force: true })
  throw new Error('could not download a matching MSYS2 archive')
}

function gnuTar() {
  // Windows' own tar.exe stalls on large .tar.xz archives; Git for Windows
  // ships GNU tar and xz, which unpack this one in seconds.
  for (const dir of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const tar = join(dir, 'Git', 'usr', 'bin', 'tar.exe')
    if (existsSync(tar)) return { tar, path: [join(dir, 'Git', 'mingw64', 'bin'), join(dir, 'Git', 'usr', 'bin')] }
  }
  return null
}

function extract(archive) {
  if (existsSync(join(msys, 'usr', 'bin', 'bash.exe')) && !force) return
  rmSync(msys, { recursive: true, force: true })
  log('unpacking')
  const gnu = gnuTar()
  if (gnu) {
    const env = { ...process.env, PATH: gnu.path.join(';') + ';' + process.env.PATH }
    execFileSync(gnu.tar, ['-xJf', archive.replace(/\\/g, '/'), '-C', vendor.replace(/\\/g, '/')], { env, stdio: 'inherit' })
  } else {
    execFileSync('tar.exe', ['-xf', archive, '-C', vendor], { stdio: 'inherit' })
  }
}

function configure() {
  // ~ is the Windows profile folder, as in Git Bash, so ~/.zshrc, ~/.ssh and
  // ~/.gitconfig are the ones every other tool on the machine uses.
  const nss = join(msys, 'etc', 'nsswitch.conf')
  const text = readFileSync(nss, 'utf8')
  if (!/^db_home:\s*windows/m.test(text)) {
    writeFileSync(nss, text.replace(/^db_home:.*$/m, 'db_home: windows'))
  }
  // Put the chosen mirror first in each pacman mirror list.
  if (mirror !== MIRRORS.official) {
    const dir = join(msys, 'etc', 'pacman.d')
    for (const f of readdirSync(dir).filter((f) => f.startsWith('mirrorlist.'))) {
      const p = join(dir, f)
      const body = readFileSync(p, 'utf8')
      const sub = f === 'mirrorlist.msys' ? 'msys/$arch/' : `mingw/${f.slice('mirrorlist.'.length)}/`
      const line = `Server = ${mirror.repo}${sub}`
      if (!body.includes(line)) writeFileSync(p, `${line}\n${body}`)
    }
  }
}

function bash(script, { allowFail = false } = {}) {
  const r = spawnSync(join(msys, 'usr', 'bin', 'bash.exe'), ['-lc', script], {
    env: { ...process.env, MSYSTEM: 'MSYS', CHERE_INVOKING: '1', MSYS2_PATH_TYPE: 'minimal' },
    cwd: msys,
    stdio: 'inherit'
  })
  if (r.status !== 0 && !allowFail) throw new Error(`bash failed (${r.status}): ${script}`)
  return r.status
}

function installPackages() {
  const have = PACKAGES.every((p) => existsSync(join(msys, 'usr', 'bin', `${p}.exe`)))
  if (have && !force) return
  log('first start: creating the pacman keyring')
  bash('true')
  // A core update replaces the runtime and asks for a restart, so it runs twice.
  log('updating MSYS2')
  bash('pacman -Syuu --noconfirm --disable-download-timeout', { allowFail: true })
  bash('pacman -Syuu --noconfirm --disable-download-timeout')
  log(`installing ${PACKAGES.join(', ')}`)
  bash(`pacman -S --needed --noconfirm --disable-download-timeout ${PACKAGES.join(' ')}`)
  bash('pacman -Scc --noconfirm', { allowFail: true })
}

function fetchP10k() {
  const dir = join(vendor, 'powerlevel10k')
  if (existsSync(join(dir, 'powerlevel10k.zsh-theme')) && !force) return dir
  rmSync(dir, { recursive: true, force: true })
  for (const url of P10K_REPOS) {
    log(`cloning ${url}`)
    const r = spawnSync('git', ['clone', '--depth', '1', url, dir], { stdio: 'inherit' })
    if (r.status === 0) {
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      return dir
    }
  }
  throw new Error('could not clone Powerlevel10k')
}

function fetchGitstatus(p10k) {
  // gitstatusd answers Powerlevel10k's git queries. Its install script picks
  // the build for this platform; the binary is kept beside the theme so the
  // app never downloads it at run time.
  const cacheDir = join(vendor, 'gitstatus')
  if (existsSync(cacheDir) && readdirSync(cacheDir).some((f) => f.startsWith('gitstatusd')) && !force) return
  mkdirSync(cacheDir, { recursive: true })
  log('installing gitstatusd')
  const install = join(p10k, 'gitstatus', 'install').replace(/\\/g, '/')
  const target = cacheDir.replace(/\\/g, '/')
  if (process.platform === 'win32') {
    bash(`GITSTATUS_CACHE_DIR="$(cygpath -u '${target}')" sh "$(cygpath -u '${install}')" -f`)
  } else {
    execFileSync('sh', [install, '-f'], { env: { ...process.env, GITSTATUS_CACHE_DIR: target }, stdio: 'inherit' })
  }
}

const archiveStep = async () => {
  if (process.platform !== 'win32') return
  const archive = await fetchArchive()
  extract(archive)
  configure()
  installPackages()
}

await archiveStep()
const p10k = fetchP10k()
fetchGitstatus(p10k)
log('done')
