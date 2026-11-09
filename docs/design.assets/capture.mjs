// Regenerates the screenshots in this folder from the running app.
//   npm run build && node docs/design.assets/capture.mjs
// It opens byndery on this repository, runs a few commands in the terminal,
// opens the design memo, and saves the shots next to this script.

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
await win.keyboard.press('Control+R')
await win.waitForSelector('.history:not([hidden])')
await win.keyboard.type('十一月')
await win.waitForTimeout(500)
const panel = await win.locator('.history').boundingBox()
await win.screenshot({ path: join(here, 'history.png'), clip: panel })
await win.keyboard.press('Escape')
await win.waitForTimeout(200)

const term = await win.locator('#terminals').boundingBox()
await win.screenshot({ path: join(here, 'prompt.png'), clip: { x: term.x, y: term.y + 32, width: term.width, height: 470 } })
await win.locator('.row', { hasText: 'docs' }).first().click()
await win.locator('.row', { hasText: 'design.md' }).first().dblclick()
await win.waitForTimeout(800)
await win.evaluate(() => window.__byndery.terms.active.focus())
await win.waitForTimeout(300)

await win.screenshot({ path: join(here, 'overview-light.png') })

await win.emulateMedia({ colorScheme: 'dark' })
await win.waitForTimeout(500)
await win.screenshot({ path: join(here, 'overview-dark.png') })
await win.emulateMedia({ colorScheme: 'light' })

await win.keyboard.press('Control+Comma')
await win.waitForSelector('.sheet:not([hidden]) input')
await win.waitForTimeout(200)
const sheet = await win.locator('.sheet').boundingBox()
await win.screenshot({ path: join(here, 'settings.png'), clip: { x: sheet.x - 16, y: sheet.y - 8, width: sheet.width + 32, height: sheet.height + 24 } })

await app.close()
rmSync(profile, { recursive: true, force: true })
rmSync(demo, { recursive: true, force: true })
console.log('saved overview-light.png, overview-dark.png, prompt.png, history.png and settings.png')
