// Copies the installers Tauri built into dist/ under the names byndery has
// used since 0.0.1, which its updater looks for:
//   byndery-<v>-win-<x64|arm64>.exe       byndery-<v>-mac-<x64|arm64>.dmg
//   byndery-<v>-linux-<x86_64|arm64>.AppImage
//   byndery-<v>-linux-<amd64|arm64>.deb   byndery-<v>-linux-<x86_64|aarch64>.rpm

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const bundle = join(root, 'src-tauri', 'target', 'release', 'bundle')
const dist = join(root, 'dist')
const arm = process.arch === 'arm64'
const kinds = [
  ['nsis', /\.exe$/, `byndery-${version}-win-${arm ? 'arm64' : 'x64'}.exe`],
  ['dmg', /\.dmg$/, `byndery-${version}-mac-${arm ? 'arm64' : 'x64'}.dmg`],
  ['appimage', /\.AppImage$/, `byndery-${version}-linux-${arm ? 'arm64' : 'x86_64'}.AppImage`],
  ['deb', /\.deb$/, `byndery-${version}-linux-${arm ? 'arm64' : 'amd64'}.deb`],
  ['rpm', /\.rpm$/, `byndery-${version}-linux-${arm ? 'aarch64' : 'x86_64'}.rpm`]
]
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
let n = 0
for (const [dir, pattern, name] of kinds) {
  const d = join(bundle, dir)
  if (!existsSync(d)) continue
  const found = readdirSync(d).filter((f) => pattern.test(f))
  if (found.length !== 1) throw new Error(`expected one ${dir} package in ${d}, found: ${found.join(', ') || 'none'}`)
  copyFileSync(join(d, found[0]), join(dist, name))
  console.log(`[collect] ${found[0]} -> dist/${name}`)
  n++
}
if (!n) throw new Error(`no packages under ${bundle}`)
