// End-to-end test: launches the built app on a scratch git repository and
// drives it the way a person would. Run `npm run build` first, then
// `npm run e2e`. Pass --shots <dir> to save screenshots along the way.

import { _electron } from 'playwright-core'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const shotsArg = process.argv.indexOf('--shots')
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null
const appDir = process.cwd()

// A small repository with the kinds of files an agent leaves behind.
const ws = mkdtempSync(join(tmpdir(), 'byndery-e2e-'))
const userData = mkdtempSync(join(tmpdir(), 'byndery-e2e-profile-'))
mkdirSync(join(ws, 'src'))
mkdirSync(join(ws, 'notes'))
writeFileSync(
  join(ws, 'README.md'),
  [
    '# Field notes',
    '',
    'An **agent** wrote this file. See [the plan](notes/plan.md) and `src/app.ts`.',
    '',
    '- first point',
    '- second point',
    '',
    '- [x] shell integration',
    '- [ ] diff review',
    '',
    '> Quoted from the brief.',
    '',
    '```ts',
    'const answer = 42',
    '```',
    ''
  ].join('\n')
)
writeFileSync(join(ws, 'src', 'app.ts'), 'export function main(): number {\n  const value = 1\n  return value + 1\n}\n')
writeFileSync(join(ws, 'notes', 'plan.md'), '# Plan\n\nShip the terminal first.\n')
writeFileSync(join(ws, '.gitignore'), 'dist/\n')
const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'ignore' })
git('init', '-q', '-b', 'main')
git('-c', 'user.email=e2e@byndery', '-c', 'user.name=e2e', 'add', '.')
git('-c', 'user.email=e2e@byndery', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
writeFileSync(join(ws, 'src', 'app.ts'), 'export function main(): number {\n  const value = 2\n  return value + 1\n}\n')
writeFileSync(join(ws, 'notes', 'new.md'), 'untracked\n')

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push(`ok   ${name} (${Date.now() - t0} ms)`)
  } catch (e) {
    const tail = await termText().then((t) => t.trimEnd().split('\n').slice(-6).join('\n     | '), () => '')
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}\n     | ${tail}`)
    failed = true
  }
}
let failed = false

// The shell keeps its history in the scratch profile, never in the user's home.
const msysPath = (p) => (process.platform === 'win32' ? '/' + p[0].toLowerCase() + p.slice(2).split(String.fromCharCode(92)).join('/') : p)
const app = await _electron.launch({
  args: ['.', ws, `--user-data-dir=${userData}`],
  cwd: appDir,
  env: { ...process.env, HISTFILE: msysPath(join(userData, 'shell_history')) }
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const shot = async (name) => SHOTS && (await win.screenshot({ path: join(SHOTS, `${name}.png`) }))

const termText = () =>
  win.evaluate(() => {
    const b = window.__byndery.terms.active.xterm.buffer.active
    const out = []
    // Soft-wrapped rows belong to the line above them.
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i)
      if (l.isWrapped && out.length) out[out.length - 1] += l.translateToString(true)
      else out.push(l.translateToString(true))
    }
    return out.join('\n')
  })
const waitFor = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const typeInTerminal = async (text) => {
  await win.evaluate(() => window.__byndery.terms.active.focus())
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}
const promptCount = () => win.evaluate(() => window.__byndery.terms.active.marks.length)
// The output of the last run of `cmd`, from its prompt line on. Routed lines
// show a PS or cmd tag between the prompt mark and the command.
const since = (text, cmd) =>
  text.slice(Math.max(...['❯ ', '❯ PS ', '❯ cmd '].map((m) => text.lastIndexOf(m + cmd))))
const norm = (p) => p.replace(/\\/g, '/').replace(/^[a-z]:/, (d) => d.toUpperCase())

await step('The default shell starts in the workspace with shell integration', async () => {
  await waitFor(async () => (await promptCount()) > 0, 'first prompt mark', 15000)
  const info = await win.evaluate(() => ({ shell: window.__byndery.terms.active.info.shell, cwd: window.__byndery.terms.active.cwd }))
  assert.ok(['zsh', 'bash'].includes(info.shell), `shell is ${info.shell}`)
  assert.equal(info.cwd.toLowerCase(), norm(ws).toLowerCase())
})
await shot('01-start')

await step('Tree shows git status for modified and untracked files', async () => {
  await win.locator('.row.dir', { hasText: 'src' }).click()
  await waitFor(() => win.locator('.row.git-M', { hasText: 'app.ts' }).count(), 'M badge on app.ts')
  await win.locator('.row.dir', { hasText: 'notes' }).click()
  await waitFor(() => win.locator('.row.git-U', { hasText: 'new.md' }).count(), 'U badge on new.md')
  assert.ok(await win.locator('.row.dir.has-M', { hasText: 'src' }).count(), 'src folder carries the modified dot')
})

await step('Tree follows the terminal into a folder after cd', async () => {
  const before = await promptCount()
  await typeInTerminal('cd src')
  await waitFor(async () => (await promptCount()) > before, 'prompt after cd')
  await waitFor(async () => (await win.locator('.row.cwd').textContent())?.includes('src'), 'cwd marker on src')
})

await step('A failed command gets a red mark beside its prompt', async () => {
  const before = await promptCount()
  await typeInTerminal('false')
  await waitFor(async () => (await promptCount()) > before, 'prompt after false')
  await waitFor(() => win.locator('.cmd-mark.fail').count(), 'failure mark')
})

await step('Ctrl+click on path:line in terminal output opens the editor at that line', async () => {
  await typeInTerminal("echo 'error at app.ts:3:10 here'")
  await waitFor(async () => (await termText()).includes('error at app.ts:3:10 here\n'), 'echo output')
  const pos = await win.evaluate(() => {
    const t = window.__byndery.terms.active.xterm
    const b = t.buffer.active
    for (let i = b.length - 1; i >= 0; i--) {
      const s = b.getLine(i).translateToString(true)
      const x = s.indexOf('app.ts:3')
      if (x >= 0 && s.startsWith('error')) {
        const screen = t.element.querySelector('.xterm-screen').getBoundingClientRect()
        const cell = t._core._renderService.dimensions.css.cell
        return { x: screen.left + (x + 2) * cell.width + cell.width / 2, y: screen.top + (i - b.viewportY) * cell.height + cell.height / 2 }
      }
    }
    return null
  })
  assert.ok(pos, 'found the echoed path on screen')
  await win.mouse.move(pos.x, pos.y)
  await win.waitForTimeout(400)
  await win.keyboard.down('Control')
  await win.mouse.click(pos.x, pos.y)
  await win.keyboard.up('Control')
  await waitFor(() => win.locator('#editor-tabs .tab.active', { hasText: 'app.ts' }).count(), 'app.ts tab')
  const line = await win.evaluate(() => {
    const v = window.__byndery.editor.view
    return v.state.doc.lineAt(v.state.selection.main.head).number
  })
  assert.equal(line, 3)
})
await shot('02-link-opened')

await step('Single click opens a preview tab; Markdown renders live', async () => {
  await win.locator('.row', { hasText: 'README.md' }).click()
  await waitFor(() => win.locator('#editor-tabs .tab.preview', { hasText: 'README.md' }).count(), 'README preview tab')
  await waitFor(() => win.locator('.cm-line.md-h1').count(), 'rendered heading')
  const h1 = await win.locator('.cm-line.md-h1').first().textContent()
  assert.equal(h1, 'Field notes', 'heading mark is hidden away from the cursor')
  assert.ok(await win.locator('.md-check').count() === 2, 'task checkboxes rendered')
  assert.ok(await win.locator('.md-bullet').count() >= 2, 'bullets rendered')
  assert.ok(await win.locator('.cm-line.md-codeblock').count() >= 3, 'code block styled')
  assert.equal(await win.locator('#editor-tabs .tab', { hasText: 'app.ts' }).count(), 1, 'pinned app.ts tab kept')
})
await shot('03-markdown')

await step('Ctrl+E switches the Markdown file to source and back', async () => {
  await win.locator('#editor-host .cm-content').click()
  await win.keyboard.press('Control+E')
  await waitFor(() => win.locator('#editor-host .cm-lineNumbers').count(), 'line numbers in source mode')
  await win.keyboard.press('Control+E')
  await waitFor(async () => (await win.locator('#editor-host .cm-lineNumbers').count()) === 0, 'back to preview')
})

await step('A file changed on disk reloads in place and highlights the change', async () => {
  const p = join(ws, 'README.md')
  writeFileSync(p, readFileSync(p, 'utf8').replace('second point', 'second point, edited by the agent'))
  await waitFor(async () => (await win.locator('#editor-host .cm-content').textContent()).includes('edited by the agent'), 'reloaded text')
  assert.ok(await win.locator('.cm-changed').count(), 'changed line highlighted')
})

await step('Unsaved edits are not overwritten by a change on disk', async () => {
  await win.locator('.cm-line', { hasText: 'Quoted from the brief' }).click()
  await win.keyboard.press('End')
  await win.keyboard.type(' Mine.')
  assert.ok(await win.locator('#editor-tabs .tab.dirty').count(), 'tab shows unsaved dot')
  const p = join(ws, 'README.md')
  writeFileSync(p, readFileSync(p, 'utf8') + '\nAppended by the agent.\n')
  await waitFor(() => win.locator('#editor-notice:not([hidden])').count(), 'conflict notice')
  await win.locator('#editor-notice button', { hasText: 'Keep Mine' }).click()
  await win.keyboard.press('Control+S')
  await waitFor(async () => readFileSync(p, 'utf8').includes('Mine.'), 'saved to disk')
  assert.equal(await win.locator('#editor-tabs .tab.dirty').count(), 0)
})

await step('Ctrl+L sends the selection to the terminal as an @-mention', async () => {
  await win.locator('#editor-tabs .tab', { hasText: 'app.ts' }).click()
  await win.evaluate(() => {
    const v = window.__byndery.editor.view
    v.dispatch({ selection: { anchor: v.state.doc.line(2).from, head: v.state.doc.line(3).to } })
    v.focus()
  })
  await win.keyboard.press('Control+L')
  await waitFor(async () => (await termText()).includes('@app.ts#L2-3'), '@app.ts#L2-3 in the terminal')
  await win.keyboard.press('Control+U')
})

await step('Ctrl+P finds a file by fuzzy name', async () => {
  await win.keyboard.press('Control+P')
  await win.keyboard.type('plan')
  await waitFor(async () => (await win.locator('#palette-list li.active .name').textContent()) === 'plan.md', 'plan.md ranked first')
  await shot('04-palette')
  await win.keyboard.press('Enter')
  await waitFor(() => win.locator('#editor-tabs .tab.active', { hasText: 'plan.md' }).count(), 'plan.md open')
  await waitFor(() => win.locator('.row.selected', { hasText: 'plan.md' }).count(), 'tree reveals the open file')
})

await step('Dragging a file from the tree onto the terminal types its path', async () => {
  // Playwright's dragTo leaves Chromium's drag session open inside Electron, so
  // the drag is played as the DOM events the tree and terminal listen for.
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) => r.textContent.includes('plan.md'))
    const term = document.querySelector('.term.active')
    const dt = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    term.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    term.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  try {
    await waitFor(async () => (await termText()).includes('../notes/plan.md'), 'relative path pasted')
  } finally {
    await win.evaluate(() => window.__byndery.terms.active.focus())
    await win.keyboard.press('Control+U')
  }
})

await step('One prompt runs zsh, PowerShell cmdlets, cmd built-ins and Windows programs', async () => {
  const shell = await win.evaluate(() => window.__byndery.terms.active.info.shell)
  if (process.platform !== 'win32' || shell !== 'zsh') return
  const run = async (cmd, expect) => {
    const before = await promptCount()
    await typeInTerminal(cmd)
    await waitFor(async () => (await promptCount()) > before, `prompt after ${cmd}`, 20000)
    const text = await termText()
    assert.ok(expect.test(since(text, cmd)), `${cmd} printed ${JSON.stringify(since(text, cmd).slice(0, 200))}`)
  }
  await run("Get-Date -Format 'yyyy-MM' | Write-Output", /20\d\d-\d\d/)
  await run('ver', /Microsoft Windows/)
  await run('whoami.exe', /whoami\.exe\n(?!zsh:)\S+/)
  await run('echo $ZSH_VERSION', /\d+\.\d+/)
})

await step('PowerShell and cmd lines hand their folder, variables and exit code back', async () => {
  const shell = await win.evaluate(() => window.__byndery.terms.active.info.shell)
  if (process.platform !== 'win32' || shell !== 'zsh') return
  const run = async (cmd) => {
    const before = await promptCount()
    await typeInTerminal(cmd)
    await waitFor(async () => (await promptCount()) > before, `prompt after ${cmd}`, 20000)
  }
  await run('$env:BYNDERY_E2E = "from-ps"')
  await run('echo $BYNDERY_E2E')
  assert.ok((await termText()).includes('\nfrom-ps'), 'PowerShell variable reached zsh')
  assert.ok((await termText()).includes('PS $env:BYNDERY_E2E'), 'routed line shows PS and the typed text')
  await run(`cd /d ${join(ws, 'notes')}`)
  await waitFor(async () => (await win.evaluate(() => window.__byndery.terms.active.cwd)).endsWith('/notes'), 'cmd cd /d moved zsh')
  await run('cd ../src')
  await run('pwsh: exit 4')
  assert.equal(await win.evaluate(() => window.__byndery.terms.active.marks.at(-2).exit), 4)
})

await step('Settings switch a system off; its prefix still works', async () => {
  if (process.platform !== 'win32') return
  await win.keyboard.press('Control+Comma')
  await waitFor(() => win.locator('.sheet:not([hidden])').count(), 'settings sheet')
  await shot('06-settings')
  await win.locator('.sheet-check input[data-key="cmd"]').uncheck()
  await win.keyboard.press('Escape')
  const run = async (cmd) => {
    const before = await promptCount()
    await typeInTerminal(cmd)
    await waitFor(async () => (await promptCount()) > before, `prompt after ${cmd}`, 20000)
    const t = await termText()
    return since(t, cmd)
  }
  assert.match(await run('ver'), /command not found/)
  assert.match(await run('cmd: ver'), /Microsoft Windows/)
  await win.keyboard.press('Control+Comma')
  await shot('07-settings-again')
  await win.locator('.sheet-check input[data-key="cmd"]').check()
  await win.locator('.sheet-check input[data-key="powershell"]').uncheck()
  await win.locator('.sheet-check input[data-key="linux"]').uncheck()
  assert.ok(await win.locator('.sheet-check input[data-key="cmd"]').isDisabled(), 'the last system cannot be switched off')
  await win.locator('.sheet-check input[data-key="linux"]').check()
  await win.locator('.sheet-check input[data-key="powershell"]').check()
  await win.keyboard.press('Escape')
  assert.match(await run('ver'), /Microsoft Windows/)
})

await step('Command history finds output, puts commands back and runs them', async () => {
  const run = async (cmd) => {
    const before = await promptCount()
    await typeInTerminal(cmd)
    await waitFor(async () => (await promptCount()) > before, `prompt after ${cmd}`, 20000)
  }
  writeFileSync(join(ws, 'src', '.env'), 'API_TOKEN=do-not-store-me\n')
  await run('cat .env')
  await win.waitForTimeout(300)
  // Search by text that only appears in an earlier command's output.
  await win.evaluate(() => window.__byndery.terms.active.focus())
  await win.keyboard.press('Control+R')
  await waitFor(() => win.locator('.history:not([hidden])').count(), 'history panel')
  await win.keyboard.type('3:10 here')
  await waitFor(async () => (await win.locator('.history-list li.active .history-cmd').textContent())?.includes("echo 'error at app.ts:3:10 here'"), 'echo found by its output')
  await waitFor(async () => (await win.locator('.history-output').textContent()).includes('error at app.ts:3:10 here'), 'output preview')
  await shot('08-history')
  // Ctrl+R cycles the scope; Tab puts the command on the prompt without running it.
  await win.keyboard.press('Control+R')
  assert.equal(await win.locator('.history-scope[aria-pressed="true"]').textContent(), 'This workspace')
  await win.keyboard.press('Tab')
  await waitFor(async () => (await termText()).trimEnd().endsWith("echo 'error at app.ts:3:10 here'"), 'command on the prompt')
  await win.keyboard.press('Control+U')
  // Enter runs it.
  const before = await promptCount()
  await win.keyboard.press('Control+R')
  await win.keyboard.type('ZSH_VERSION')
  await waitFor(async () => (await win.locator('.history-list li.active .history-cmd').textContent())?.includes('ZSH_VERSION'), 'ZSH_VERSION found')
  await win.keyboard.press('Enter')
  await waitFor(async () => (await promptCount()) > before, 'command ran from history')
  // The secret file's contents were never kept.
  const leaked = await win.evaluate(async () => {
    const rows = await window.byndery.history.search({ text: 'do-not-store', scope: 'all' })
    const env = (await window.byndery.history.search({ text: 'cat .env', scope: 'all' }))[0]
    return { rows: rows.length, envOutput: env ? (await window.byndery.history.output(env.id)).text : null }
  })
  assert.deepEqual(leaked, { rows: 0, envOutput: '' })
  // With the memory switched off, nothing new is kept.
  await win.evaluate(() => window.byndery.settings.set({ memory: false }))
  await run('echo not-remembered-xyz')
  await win.evaluate(() => window.byndery.settings.set({ memory: true }))
  await win.waitForTimeout(200)
  assert.equal((await win.evaluate(() => window.byndery.history.search({ text: 'not-remembered-xyz', scope: 'all' }))).length, 0)
})

await step('Paths work in both forms: C:\\ and /c/', async () => {
  const shell = await win.evaluate(() => window.__byndery.terms.active.info.shell)
  if (process.platform !== 'win32' || shell !== 'zsh') return
  const winPath = join(ws, 'notes')
  const msysPath = '/' + ws[0].toLowerCase() + ws.slice(2).replace(/\\/g, '/') + '/src'
  let before = await promptCount()
  await typeInTerminal(`cd ${winPath}`)
  await waitFor(async () => (await promptCount()) > before, 'prompt after cd C:\\')
  await waitFor(async () => (await win.evaluate(() => window.__byndery.terms.active.cwd)).endsWith('/notes'), 'cwd is notes')
  const shown = await termText()
  assert.ok(shown.includes(`cd ${winPath}`), 'the line is shown as typed')
  before = await promptCount()
  await typeInTerminal(`cd ${msysPath}`)
  await waitFor(async () => (await promptCount()) > before, 'prompt after cd /c/')
  await waitFor(async () => (await win.evaluate(() => window.__byndery.terms.active.cwd)).endsWith('/src'), 'cwd is src')

  await win.keyboard.press('Control+P')
  await win.keyboard.type(`${msysPath}/app.ts:2`)
  await waitFor(async () => (await win.locator('#palette-list li.active .key').textContent()) === 'Open', 'Open item')
  await win.keyboard.press('Enter')
  await waitFor(() => win.locator('#editor-tabs .tab.active', { hasText: 'app.ts' }).count(), 'app.ts open')
  const line = await win.evaluate(() => {
    const v = window.__byndery.editor.view
    return v.state.doc.lineAt(v.state.selection.main.head).number
  })
  assert.equal(line, 2)
})

await step('Ctrl+Up scrolls back to the previous prompt', async () => {
  await typeInTerminal('seq 1 200')
  await waitFor(async () => (await termText()).includes('\n200'), 'seq output')
  await win.waitForTimeout(300)
  const before = await win.evaluate(() => window.__byndery.terms.active.xterm.buffer.active.viewportY)
  await win.keyboard.press('Control+ArrowUp')
  const after = await win.evaluate(() => window.__byndery.terms.active.xterm.buffer.active.viewportY)
  assert.ok(after < before, `viewport moved up (${before} to ${after})`)
  await win.keyboard.press('Control+ArrowDown')
})

await step('Second terminal opens in the active terminal folder', async () => {
  await win.keyboard.press('Control+Shift+Backquote')
  await waitFor(async () => (await win.locator('#term-tabs .tab').count()) === 2, 'two terminal tabs')
  await waitFor(async () => (await promptCount()) > 0, 'prompt in second terminal', 15000)
  const cwd = await win.evaluate(() => window.__byndery.terms.active.cwd)
  assert.ok(cwd.toLowerCase().endsWith('/src'), `second terminal cwd ${cwd}`)
})

await step('Dark theme follows the system', async () => {
  // Playwright pins prefers-color-scheme to light, which hides nativeTheme
  // changes from the page, so the switch goes through its media emulation.
  await win.emulateMedia({ colorScheme: 'dark' })
  await win.waitForTimeout(400)
  await waitFor(async () => (await win.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(21, 20, 19)', 'dark chrome background')
  await win.locator('#editor-tabs .tab', { hasText: 'README.md' }).click()
  await win.waitForTimeout(300)
  await shot('05-dark')
  await win.emulateMedia({ colorScheme: 'light' })
})

await step('No errors in the renderer', async () => {
  assert.deepEqual(errors, [])
})

await app.close()
rmSync(ws, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
console.log(results.join('\n'))
process.exit(failed ? 1 : 0)
