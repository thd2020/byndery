import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME, FrameReader, frame, handoffLabel, parseHeader } from '../src/shared/handoff.ts'

test('frames survive any chunking', () => {
  const stream = Buffer.concat([frame(FRAME.data, Buffer.from('héllo')), frame(FRAME.exit, Buffer.from([0xfe, 0xff, 0xff, 0xff])), frame(FRAME.data, Buffer.alloc(0))])
  for (let size = 1; size <= stream.length; size++) {
    const got: [number, string][] = []
    const reader = new FrameReader((type, payload) => got.push([type, payload.toString('hex')]))
    for (let i = 0; i < stream.length; i += size) reader.push(stream.subarray(i, i + size))
    assert.deepEqual(got, [
      [FRAME.data, Buffer.from('héllo').toString('hex')],
      [FRAME.exit, 'feffffff'],
      [FRAME.data, '']
    ])
  }
})

test('the exit frame carries a signed code', () => {
  const reader = new FrameReader((_type, payload) => assert.equal(payload.readInt32LE(0), -1073741510))
  const code = Buffer.alloc(4)
  code.writeUInt32LE(0xc000013a)
  reader.push(frame(FRAME.exit, code))
})

test('header from byndery-handoff.exe', () => {
  const h = parseHeader('{"version":1,"title":"C:\\\\Windows\\\\System32\\\\cmd.exe","program":"cmd.exe","pid":42,"cols":120,"rows":30,"hidden":false}')
  assert.deepEqual(h, { title: 'C:\\Windows\\System32\\cmd.exe', program: 'cmd.exe', pid: 42, cols: 120, rows: 30, hidden: false })
  assert.equal(handoffLabel(h!), 'cmd.exe')
  assert.equal(handoffLabel({ ...h!, title: 'Windows PowerShell' }), 'Windows PowerShell')
  assert.equal(handoffLabel({ ...h!, title: '', program: 'python.exe' }), 'python.exe')
  assert.equal(parseHeader('{"version":2}'), null)
  assert.equal(parseHeader('not json'), null)
})
