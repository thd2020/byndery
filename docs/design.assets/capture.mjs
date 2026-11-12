// Regenerates the screenshots in this folder from the running app.
//   npm run build && node docs/design.assets/capture.mjs
// It opens byndery on this repository, runs a few commands in the terminal,
// opens a source file and the settings, and saves the shots next to this script.

import { _electron } from 'playwright-core'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const profile = mkdtempSync(join(tmpdir(), 'byndery-capture-'))

// A small repository for the prompt shot. A worktree would hide the git
// segment (see the known limit in design.md).
const demo = mkdtempSync(join(tmpdir(), 'notes-'))
const git = (...a) => execFileSync('git', a, { cwd: demo, stdio: 'ignore' })
writeFileSync(join(demo, 'plan.md'), '# Plan\n')
git('init', '-q', '-b', 'main')
git('-c', 'user.email=demo@byndery', '-c', 'user.name=demo', 'add', '.')
git('-c', 'user.email=demo@byndery', '-c', 'user.name=demo', 'commit', '-qm', 'Start the plan')
writeFileSync(join(demo, 'plan.md'), '# Plan\n\nShip the terminal first.\n')
writeFileSync(join(demo, 'ideas.md'), 'later\n')
const demoMsys = '/' + demo[0].toLowerCase() + demo.slice(2).split(String.fromCharCode(92)).join('/')

// The shell keeps its history in the scratch profile, never in the user's home.
const msysPath = (p) => (process.platform === 'win32' ? '/' + p[0].toLowerCase() + p.slice(2).split(String.fromCharCode(92)).join('/') : p)
const app = await _electron.launch({
  args: ['.', repo, `--user-data-dir=${profile}`],
  cwd: repo,
  env: { ...process.env, HISTFILE: msysPath(join(profile, 'shell_history')) }
})
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 860))
await win.waitForFunction(() => window.__byndery?.terms.active?.marks.length > 0, null, { timeout: 20000 })

const marks = () => win.evaluate(() => window.__byndery.terms.active.marks.length)
const run = async (cmd, wait = 15000) => {
  const before = await marks()
  await win.evaluate(() => window.__byndery.terms.active.focus())
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await win.waitForFunction((n) => window.__byndery.terms.active.marks.length > n, before, { timeout: wait })
}

await run(`cd ${demoMsys}`)
await win.evaluate(() => window.__byndery.terms.active.xterm.clear())
await run('git log --oneline -1')
await run('false')
await run("Get-Date -Format 'dddd d MMMM' | Write-Output")
await run('ver')
await run('sleep 2.4')
await run('ls')
// The command memory, searched by text that appears only in an output.
await win.keyboard.press('Control+K')
await win.waitForSelector('.history:not([hidden])')
await win.keyboard.type('十一月')
await win.waitForTimeout(500)
const panel = await win.locator('.history').boundingBox()
await win.screenshot({ path: join(here, 'history.png'), clip: panel })
await win.keyboard.press('Escape')
await win.waitForTimeout(200)

const term = await win.locator('#terminals').boundingBox()
await win.screenshot({ path: join(here, 'prompt.png'), clip: { x: term.x, y: term.y + 32, width: term.width, height: 470 } })
// Back to the repository, with the tree synced to the terminal.
await run(`cd ${msysPath(repo)}`)
await win.locator('#follow-button').click()
await win.locator('.row.dir', { hasText: 'src' }).first().click()
await win.waitForTimeout(600)
await win.locator('.row.dir', { hasText: 'main' }).first().click()
await win.waitForTimeout(600)
await win.locator('.row', { hasText: 'pty.ts' }).first().dblclick()
await win.waitForTimeout(800)
await win.evaluate(() => window.__byndery.terms.active.focus())
await win.waitForTimeout(300)

await win.screenshot({ path: join(here, 'overview-light.png') })
const side = await win.locator('#sidebar').boundingBox()
await win.screenshot({ path: join(here, 'tree.png'), clip: { x: side.x, y: side.y, width: side.width, height: 420 } })

await win.emulateMedia({ colorScheme: 'dark' })
await win.waitForTimeout(500)
await win.screenshot({ path: join(here, 'overview-dark.png') })
await win.emulateMedia({ colorScheme: 'light' })

await win.keyboard.press('Control+Comma')
await win.waitForSelector('.settings:not([hidden])')
await win.locator('.settings-nav-item', { hasText: 'Commands' }).click()
await win.locator('[data-focus-key="route-try"]').fill('Get-ChildItem | Sort-Object Length')
await win.waitForFunction(() => document.querySelector('.route-result')?.textContent.includes('PowerShell'), null, { timeout: 15000 })
const page = await win.locator('.settings').boundingBox()
await win.screenshot({ path: join(here, 'settings.png'), clip: page })
await win.locator('.settings-nav-item.indent', { hasText: 'zsh' }).click()
await win.waitForTimeout(300)
await win.screenshot({ path: join(here, 'settings-profile.png'), clip: page })
await win.locator('.settings-nav-item', { hasText: 'Keyboard' }).click()
await win.waitForTimeout(300)
await win.screenshot({ path: join(here, 'settings-keys.png'), clip: page })

await app.close()
rmSync(profile, { recursive: true, force: true })
rmSync(demo, { recursive: true, force: true })
console.log('saved overview-light.png, overview-dark.png, prompt.png, history.png, tree.png, settings.png, settings-profile.png and settings-keys.png')
