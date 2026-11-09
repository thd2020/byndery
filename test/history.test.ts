import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capOutput, redact, REDACTED, shouldRemember, unescapeCommandLine } from '../src/shared/history.ts'

test('633;E command lines decode the way VS Code escapes them', () => {
  assert.equal(unescapeCommandLine('printf "a\\x3bb\\\\n"'), 'printf "a;b\\n"')
  assert.equal(unescapeCommandLine('echo one\\x0aecho two'), 'echo one\necho two')
  assert.equal(unescapeCommandLine('plain'), 'plain')
})

// Fake credentials are assembled at run time, so the source holds nothing a
// secret scanner would take for a real one.
const fake = {
  github: ['gh', 'p_', 'x'.repeat(36)].join(''),
  aws: ['AK', 'IA', 'X'.repeat(16)].join(''),
  password: ['not', 'a', 'real', 'one'].join('-'),
  anthropic: ['sk', 'ant', 'y'.repeat(24)].join('-'),
  key: ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nzzz\n-----END OPENSSH ', 'PRIVATE KEY-----'].join('')
}

test('secrets are redacted in commands and output', () => {
  assert.equal(redact(`export GH=${fake.github}`), `export GH=${REDACTED}`)
  assert.equal(redact(`aws key ${fake.aws} here`), `aws key ${REDACTED} here`)
  assert.equal(redact(`mysql --${'pass'}word=${fake.password} -u root`), `mysql --password=${REDACTED} -u root`)
  assert.equal(redact(`API_KEY="${fake.anthropic}"`), `API_KEY="${REDACTED}"`)
  assert.match(redact(fake.key), new RegExp(REDACTED))
  assert.equal(redact('git status'), 'git status')
  assert.equal(redact('tokenizer.py passes'), 'tokenizer.py passes')
})

test('long output keeps its start and its end', () => {
  const big = 'a'.repeat(1000) + 'MIDDLE' + 'z'.repeat(1000)
  const r = capOutput(big, 400)
  assert.ok(r.capped)
  assert.ok(r.text.startsWith('a'.repeat(200)))
  assert.ok(r.text.endsWith('z'.repeat(200)))
  assert.ok(!r.text.includes('MIDDLE'))
  assert.equal(capOutput('short').capped, false)
})

test('empty commands and ones typed after a space are not remembered', () => {
  assert.equal(shouldRemember('ls'), true)
  assert.equal(shouldRemember(' ls'), false)
  assert.equal(shouldRemember('   '), false)
})
