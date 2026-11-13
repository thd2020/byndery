import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPaths } from '../src/shared/links.ts'
import { rank } from '../src/shared/fuzzy.ts'
import { fromMsys, toMsys, normalize, join, relative, relativeFrom, shellQuote, dirname } from '../src/shared/paths.ts'

const one = (s: string) => {
  const r = findPaths(s)
  assert.equal(r.length, 1, `expected one match in ${JSON.stringify(s)}, got ${JSON.stringify(r)}`)
  return r[0]
}

test('paths with line and column', () => {
  assert.deepEqual(one('src/app.ts:12:5 - error TS2322'), { start: 0, end: 15, path: 'src/app.ts', line: 12, col: 5 })
  const m = one('  at Object.<anonymous> (C:\\work\\a.js:3:9)')
  assert.equal(m.path, 'C:\\work\\a.js')
  assert.equal(m.line, 3)
})

test('MSBuild and tsc parenthesised positions', () => {
  const m = one('src/app.ts(12,5): error TS1005')
  assert.equal(m.path, 'src/app.ts')
  assert.equal(m.line, 12)
  assert.equal(m.col, 5)
  assert.equal(m.end, 'src/app.ts(12,5)'.length)
})

test('python tracebacks', () => {
  const m = one('  File "/c/work/tool.py", line 40, in main')
  assert.equal(m.path, '/c/work/tool.py')
  assert.equal(m.line, 40)
})

test('Claude Code mentions and trailing punctuation', () => {
  const m = one('Updated @docs/design.md#L10-20.')
  assert.equal(m.path, 'docs/design.md')
  assert.equal(m.line, 10)
  assert.equal(one('写入了 README.md。').path, 'README.md')
  assert.equal(one('(see ./notes/plan.md)').path, './notes/plan.md')
})

test('ignores URLs, versions and plain words', () => {
  assert.deepEqual(findPaths('visit https://example.com/a/b now'), [])
  assert.deepEqual(findPaths('node v24.1.0 is done.'), [])
  assert.deepEqual(findPaths('took 1.5s'), [])
})

test('MSYS and Windows paths convert both ways', () => {
  assert.equal(fromMsys('/c/Users/me/a.md'), 'C:/Users/me/a.md')
  assert.equal(fromMsys('/d'), 'D:/')
  assert.equal(fromMsys('/usr/bin', { root: 'C:/Program Files/Git' }), 'C:/Program Files/Git/usr/bin')
  assert.equal(fromMsys('/tmp/x', { root: 'C:/Git', tmp: 'C:/Users/me/AppData/Local/Temp' }), 'C:/Users/me/AppData/Local/Temp/x')
  assert.equal(toMsys('C:\\Users\\me'), '/c/Users/me')
  assert.equal(normalize('c:\\a\\b\\'), 'C:/a/b')
  assert.equal(join('C:/a/b', '../c/./d.md'), 'C:/a/c/d.md')
  assert.equal(relative('C:/a', 'c:/A/b/c.md'), 'b/c.md')
  assert.equal(relative('C:/a', 'C:/ab/c.md'), null)
  assert.equal(dirname('C:/a'), 'C:/')
  assert.equal(relativeFrom('C:/w/src', 'C:/w/notes/plan.md'), '../notes/plan.md')
  assert.equal(relativeFrom('C:/w', 'c:/W/src/a.ts'), 'src/a.ts')
  assert.equal(relativeFrom('C:/w/a/b/c/d', 'C:/x.md'), null)
  assert.equal(relativeFrom('C:/w', 'D:/w/a.md'), null)
  assert.equal(shellQuote('/c/My Files/it\'s.md'), `'/c/My Files/it'\\''s.md'`)
  assert.equal(shellQuote('src/a.ts'), 'src/a.ts')
})

test('fuzzy ranking prefers file names and segment starts', () => {
  const files = ['src/renderer/terminal.ts', 'docs/landscape.md', 'src/main/term/pty.ts', 'test/term.test.ts']
  assert.equal(rank('terminal', files)[0].item, 'src/renderer/terminal.ts')
  assert.equal(rank('land', files)[0].item, 'docs/landscape.md')
  assert.equal(rank('xyz', files).length, 0)
})
