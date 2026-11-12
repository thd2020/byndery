import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'README.assets', 'byndery-icon.png'))
const width = source.readUInt32BE(16)
const height = source.readUInt32BE(20)
if (width !== 256 || height !== 256) throw new Error(`Expected a 256x256 PNG icon, got ${width}x${height}`)

const dir = join(root, 'packaging')
mkdirSync(dir, { recursive: true })

// ICO can contain a PNG image directly. A 256px entry uses zero for both size bytes.
const ico = Buffer.alloc(22 + source.length)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt8(0, 6)
ico.writeUInt8(0, 7)
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(source.length, 14)
ico.writeUInt32LE(22, 18)
source.copy(ico, 22)
writeFileSync(join(dir, 'icon.ico'), ico)

// ICNS stores the same PNG in a typed chunk; ic08 is the 256px representation.
const icns = Buffer.alloc(16 + source.length)
icns.write('icns', 0, 'ascii')
icns.writeUInt32BE(icns.length, 4)
icns.write('ic08', 8, 'ascii')
icns.writeUInt32BE(8 + source.length, 12)
source.copy(icns, 16)
writeFileSync(join(dir, 'icon.icns'), icns)
