import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const packageExtensions = new Set(['.exe', '.dmg', '.appimage', '.deb', '.rpm'])
const packages = readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile() && packageExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()))
  .map((entry) => join(dist, entry.name))

if (!packages.length) throw new Error('No installer packages found in dist/')

const files = []
for (const file of packages) {
  const hash = await new Promise((resolveHash, reject) => {
    const digest = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(digest.digest('hex')))
  })
  writeFileSync(`${file}.sha256`, `${hash}  ${file.slice(dist.length + 1)}\n`)
  files.push(file, `${file}.sha256`)
}

process.stdout.write(JSON.stringify(files))
