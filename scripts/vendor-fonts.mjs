// Fetches MesloLGS NF, the Nerd Font Powerlevel10k recommends, into
// src/renderer/src/assets/fonts, where the renderer's stylesheet picks it up.
// It runs after `npm install`. Each file is checked against a pinned SHA-256;
// GitHub comes first and the jsDelivr CDN is the fallback.
//
//   node scripts/vendor-fonts.mjs [--force]
//
// MesloLGS NF is Copyright 2009, 2010, 2013 André Berg, Apache License 2.0.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'assets', 'fonts')
const force = process.argv.includes('--force')

const FILES = {
  'MesloLGS-NF-Regular.ttf': ['MesloLGS NF Regular.ttf', 'd97946186e97f8d7c0139e8983abf40a1d2d086924f2c5dbf1c29bd8f2c6e57d'],
  'MesloLGS-NF-Bold.ttf': ['MesloLGS NF Bold.ttf', 'b6c0199cf7c7483c8343ea020658925e6de0aeb318b89908152fcb4d19226003'],
  'MesloLGS-NF-Italic.ttf': ['MesloLGS NF Italic.ttf', '6f357bcbe2597704e157a915625928bca38364a89c22a4ac36e7a116dcd392ef'],
  'MesloLGS-NF-Bold-Italic.ttf': ['MesloLGS NF Bold Italic.ttf', '56b4131adecec052c4b324efb818dd326d586dbc316fc68f98f1cae2eb8d1220']
}
const SOURCES = [
  (name) => `https://github.com/romkatv/powerlevel10k-media/raw/master/${encodeURIComponent(name)}`,
  (name) => `https://cdn.jsdelivr.net/gh/romkatv/powerlevel10k-media@master/${encodeURIComponent(name)}`
]

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchOne(file, [name, hash]) {
  const dest = join(out, file)
  if (!force && existsSync(dest) && sha256(readFileSync(dest)) === hash) return 'present'
  for (const url of SOURCES.map((s) => s(name))) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (sha256(buf) !== hash) continue
      writeFileSync(dest, buf)
      return url
    } catch {
      // Try the next source.
    }
  }
  throw new Error(`could not download ${name}`)
}

mkdirSync(out, { recursive: true })
try {
  for (const [file, spec] of Object.entries(FILES)) {
    const from = await fetchOne(file, spec)
    if (from !== 'present') console.log(`${file} from ${new URL(from).host}`)
  }
} catch (e) {
  // Install still succeeds; the terminal falls back to the system's monospace font.
  console.warn(`vendor-fonts: ${e.message}. Run "node scripts/vendor-fonts.mjs" again later.`)
}
