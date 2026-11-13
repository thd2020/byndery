import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertPaste, fromDialect, fromWsl, isAbsolutePath, normalize, quoteFor, toDialect, toWsl } from '../src/shared/paths.ts'

const msys = { msys: { root: 'C:/msys64' } }
const wsl = { wsl: 'Ubuntu' }
const win = { windows: true }

test('UNC paths keep their leading slashes', () => {
  assert.equal(normalize('\\\\wsl.localhost\\Ubuntu\\home\\me\\'), '//wsl.localhost/Ubuntu/home/me')
  assert.equal(normalize('//server//share/x'), '//server/share/x')
  assert.equal(normalize('/usr//bin'), '/usr/bin')
})

test('WSL paths both ways', () => {
  assert.equal(fromWsl('/mnt/c/Users/me', 'Ubuntu'), 'C:/Users/me')
  assert.equal(fromWsl('/home/me/x y.txt', 'Ubuntu'), '//wsl.localhost/Ubuntu/home/me/x y.txt')
  assert.equal(toWsl('C:\\Users\\me'), '/mnt/c/Users/me')
  assert.equal(toWsl('C:/'), '/mnt/c')
  assert.equal(toWsl('\\\\wsl$\\Ubuntu\\etc\\hosts'), '/etc/hosts')
  assert.equal(fromDialect('/mnt/d/a', wsl), 'D:/a')
  assert.equal(fromDialect('/c/Users', msys), 'C:/Users')
})

test('paths in each dialect', () => {
  assert.equal(toDialect('C:/Program Files/x', win), 'C:\\Program Files\\x')
  assert.equal(toDialect('C:/a', msys), '/c/a')
  assert.equal(toDialect('C:/a', wsl), '/mnt/c/a')
  assert.equal(quoteFor('C:\\Program Files\\x', { ...win, shell: 'pwsh' }), "'C:\\Program Files\\x'")
  assert.equal(quoteFor("C:\\it's", { ...win, shell: 'pwsh' }), "'C:\\it''s'")
  assert.equal(quoteFor('C:\\Program Files\\x', { ...win, shell: 'cmd' }), '"C:\\Program Files\\x"')
  assert.equal(quoteFor('C:\\plain', { ...win, shell: 'cmd' }), 'C:\\plain')
  assert.equal(quoteFor('/mnt/c/x y', wsl), "'/mnt/c/x y'")
})

test('a paste converts only when it is exactly one absolute path', () => {
  assert.equal(convertPaste('C:\\Users\\me\\proj', wsl), '/mnt/c/Users/me/proj')
  assert.equal(convertPaste('/mnt/c/Users/me', win), 'C:\\Users\\me')
  assert.equal(convertPaste('/c/Users/me', wsl), '/mnt/c/Users/me')
  assert.equal(convertPaste('C:/x', msys), '/c/x')
  // Flags, regexes, URLs, Docker volumes, several lines and relative paths stay as typed.
  assert.equal(convertPaste('/foo', win), '/foo')
  assert.equal(convertPaste('/s', win), '/s')
  assert.equal(convertPaste('https://example.com/c/x', wsl), 'https://example.com/c/x')
  assert.equal(convertPaste('-v /c/app:/app', wsl), '-v /c/app:/app')
  assert.equal(convertPaste('C:\\a\nC:\\b', wsl), 'C:\\a\nC:\\b')
  assert.equal(convertPaste('src/app.ts', wsl), 'src/app.ts')
  assert.equal(convertPaste('^/[a-z]+$', msys), '^/[a-z]+$')
  // A plain POSIX terminal keeps everything.
  assert.equal(convertPaste('C:\\x', {}), 'C:\\x')
  assert.ok(isAbsolutePath('\\\\server\\share'))
  assert.ok(!isAbsolutePath('/usr/bin'))
  assert.ok(!isAbsolutePath('/c'))
  assert.ok(isAbsolutePath('/mnt/c'))
})
