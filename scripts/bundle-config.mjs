// Writes build/tauri.bundle.json, merged into src-tauri/tauri.conf.json by
// `tauri build --config`: the resources this machine has built (Powerlevel10k,
// zsh plugins, gitstatusd, and on Windows the MSYS2 archive and
// byndery-handoff.exe) and the installer types for this platform. Development
// builds go without them.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const fromTauri = (p) => '../' + p
const resources = {
  [fromTauri('resources/shell/')]: 'shell/',
  [fromTauri('THIRD-PARTY-NOTICES.md')]: 'THIRD-PARTY-NOTICES.md'
}
const optional = [
  ['vendor/powerlevel10k/', 'vendor/powerlevel10k/'],
  ['vendor/gitstatus/', 'vendor/gitstatus/'],
  ['vendor/zsh-plugins/', 'vendor/zsh-plugins/'],
  ['vendor/msys64.tar.zst', 'vendor/msys64.tar.zst'],
  ['vendor/msys64.stamp', 'vendor/msys64.stamp'],
  ['vendor/msys64.count', 'vendor/msys64.count'],
  ['vendor/msys2-packages.txt', 'vendor/msys2-packages.txt'],
  ['build/handoff/byndery-handoff.exe', 'handoff/byndery-handoff.exe']
]
for (const [src, dst] of optional) {
  if (existsSync(join(root, src))) resources[fromTauri(src)] = dst
  else console.log(`[bundle-config] not bundled (absent): ${src}`)
}
const targets = { win32: ['nsis'], darwin: ['dmg'], linux: ['appimage', 'deb', 'rpm'] }[process.platform]
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'tauri.bundle.json'), JSON.stringify({ bundle: { targets, resources } }, null, 2) + '\n')
console.log(`[bundle-config] ${Object.keys(resources).length} resources, targets ${targets.join(', ')}`)
