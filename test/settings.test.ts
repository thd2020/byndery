import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, deletePath, merge, migrate, routingFile, setPath, stripComments } from '../src/shared/settings.ts'

test('the user layer merges over the defaults, arrays replace', () => {
  const s = merge(DEFAULT_SETTINGS, { commands: { order: ['cmd', 'linux', 'powershell'], enabled: { cmd: false } } })
  assert.deepEqual(s.commands.order, ['cmd', 'linux', 'powershell'])
  assert.deepEqual(s.commands.enabled, { linux: true, powershell: true, cmd: false })
  assert.equal(s.profileDefaults.fontFamily, 'MesloLGS NF')
  assert.equal(DEFAULT_SETTINGS.commands.enabled.cmd, true, 'defaults are not changed')
})

test('a reset removes the value and the objects it leaves empty', () => {
  const user: Record<string, unknown> = {}
  setPath(user, ['profiles', 'zsh', 'fontSize'], 15)
  assert.deepEqual(user, { profiles: { zsh: { fontSize: 15 } } })
  deletePath(user, ['profiles', 'zsh', 'fontSize'])
  assert.deepEqual(user, {})
})

test('settings files from before profiles are read', () => {
  assert.deepEqual(migrate({ commands: { linux: true, powershell: false, cmd: true }, memory: false }), {
    commands: { enabled: { linux: true, powershell: false, cmd: true } },
    history: { enabled: false }
  })
})

test('the routing file lists order, systems on, prefixes and pins', () => {
  const text = routingFile({ ...DEFAULT_SETTINGS.commands, enabled: { linux: true, powershell: false, cmd: true }, overrides: { dir: 'cmd', 'bad name;rm': 'cmd' } })
  assert.equal(
    text,
    'order=linux powershell cmd\non=linux cmd\npssyntax=1\nprefix.linux=zsh:\nprefix.powershell=pwsh:\nprefix.cmd=cmd:\noverride.dir=cmd\n'
  )
})

test('settings.json may have comments and trailing commas', () => {
  const text = '// mine\n{ "a": "x // not a comment", /* note */ "b": [1, 2,], }\n'
  assert.deepEqual(JSON.parse(stripComments(text)), { a: 'x // not a comment', b: [1, 2] })
  assert.deepEqual(JSON.parse(stripComments('{ "s": "a,}" }')), { s: 'a,}' })
})
