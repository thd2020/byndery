import { app, BrowserWindow, net, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, chmodSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { UpdateState } from '../shared/api'

const REPOSITORY = 'thd2020/byndery'
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`
const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

interface Release {
  tag_name: string
  html_url: string
  assets: ReleaseAsset[]
}

interface UpdateTarget {
  os: 'win' | 'linux' | 'mac'
  arch: 'x64' | 'arm64'
  kind: 'nsis' | 'appimage' | 'manual'
}

let autoEnabled = true
let release: Release | null = null
let installerPath: string | null = null
let checking: Promise<UpdateState> | null = null
let state: UpdateState = {
  currentVersion: app.getVersion(),
  availableVersion: null,
  releasePage: null,
  status: 'idle',
  progress: 0,
  canCheck: app.isPackaged,
  supportsAutoUpdate: app.isPackaged && ['nsis', 'appimage'].includes(target().kind),
  installSupported: false,
  canInstall: false,
  autoEnabled,
  error: null
}

const settingsPath = (): string => join(app.getPath('userData'), 'update-settings.json')
const downloadsPath = (): string => join(app.getPath('userData'), 'updates')

function loadPreference(): void {
  try {
    autoEnabled = JSON.parse(readFileSync(settingsPath(), 'utf8')).autoEnabled !== false
  } catch {
    autoEnabled = true
  }
  state = { ...state, autoEnabled }
}

function emit(): void {
  const build = target()
  state = {
    ...state,
    currentVersion: app.getVersion(),
    canCheck: app.isPackaged,
    supportsAutoUpdate: app.isPackaged && (build.kind === 'nsis' || build.kind === 'appimage'),
    autoEnabled
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:changed', state)
  }
}

function target(): UpdateTarget {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') {
    const uninstaller = join(dirname(process.execPath), 'Uninstall byndery.exe')
    return { os: 'win', arch, kind: app.isPackaged && existsSync(uninstaller) ? 'nsis' : 'manual' }
  }
  if (process.platform === 'linux') return { os: 'linux', arch, kind: process.env.APPIMAGE ? 'appimage' : 'manual' }
  return { os: 'mac', arch, kind: 'manual' }
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, '').split('.').map(Number)
  const right = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return difference
  }
  return 0
}

function assetName(version: string, build: UpdateTarget): string {
  const ext = build.kind === 'appimage' ? 'AppImage' : build.os === 'win' ? 'exe' : 'dmg'
  return `byndery-${version}-${build.os}-${build.arch}.${ext}`
}

function latestPageRedirect(): Promise<string | null> {
  return new Promise((resolve) => {
    const request = net.request({ url: RELEASES_URL, method: 'HEAD', redirect: 'manual' })
    request.on('redirect', (_status, _method, url) => {
      resolve(url)
      request.abort()
    })
    request.on('response', () => resolve(null))
    request.on('error', () => resolve(null))
    request.end()
  })
}

async function checksumFromSidecar(url: string, name: string): Promise<string | null> {
  const response = await net.fetch(`${url}.sha256`)
  if (!response.ok) return null
  const line = (await response.text()).trim()
  const match = /^([a-f\d]{64})\s+\*?(.+)$/.exec(line)
  return match && match[2].trim() === name ? match[1].toLowerCase() : null
}

async function fetchRelease(build: UpdateTarget): Promise<Release | null> {
  try {
    const response = await net.fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `byndery/${app.getVersion()}` }
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    return (await response.json()) as Release
  } catch (apiError) {
    const page = await latestPageRedirect()
    const version = page ? /\/tag\/v?([^/]+)$/.exec(new URL(page).pathname)?.[1] : null
    if (!page || !version) throw apiError
    const name = assetName(version, build)
    const tag = `v${version}`
    const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`
    const digest = await checksumFromSidecar(url, name)
    return {
      tag_name: tag,
      html_url: page,
      assets: digest ? [{ name, browser_download_url: url, size: 0, digest: `sha256:${digest}` }] : []
    }
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function download(asset: ReleaseAsset, expectedHash: string): Promise<string> {
  mkdirSync(downloadsPath(), { recursive: true })
  const file = join(downloadsPath(), asset.name)
  const part = `${file}.part`
  if (existsSync(file) && (await sha256(file)) === expectedHash) return file
  rmSync(part, { force: true })
  const response = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': `byndery/${app.getVersion()}` } })
  if (!response.ok || !response.body) throw new Error(`Could not download ${asset.name}`)

  let received = 0
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    state = { ...state, status: 'downloading', progress: asset.size ? Math.min(1, received / asset.size) : 0 }
    emit()
  })
  try {
    await pipeline(body, createWriteStream(part))
    if ((await sha256(part)) !== expectedHash) throw new Error(`Checksum mismatch for ${asset.name}`)
    renameSync(part, file)
    return file
  } catch (error) {
    rmSync(part, { force: true })
    throw error
  }
}

function expectedHash(asset: ReleaseAsset, version: string): Promise<string | null> {
  const digest = /^sha256:([a-f\d]{64})$/i.exec(asset.digest ?? '')?.[1]
  if (digest) return Promise.resolve(digest.toLowerCase())
  const tag = `v${version}`
  const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset.name}`
  return checksumFromSidecar(url, asset.name)
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return getUpdateState()
  if (checking) return checking
  checking = (async () => {
    state = { ...state, status: 'checking', error: null, progress: 0 }
    emit()
    try {
      const build = target()
      const latest = await fetchRelease(build)
      if (!latest) {
        release = null
        installerPath = null
        state = { ...state, status: 'idle', availableVersion: null, releasePage: null, installSupported: false, canInstall: false }
        emit()
        return getUpdateState()
      }
      const version = latest.tag_name.replace(/^v/, '')
      if (compareVersions(version, app.getVersion()) <= 0) {
        release = null
        installerPath = null
        state = { ...state, status: 'idle', availableVersion: null, releasePage: latest.html_url, installSupported: false, canInstall: false }
        emit()
        return getUpdateState()
      }

      release = latest
      const name = assetName(version, build)
      const asset = latest.assets.find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? null
      state = { ...state, availableVersion: version, releasePage: latest.html_url, installSupported: false, canInstall: false, status: 'idle', progress: 0 }
      if (build.kind !== 'manual' && asset && autoEnabled) {
        state = { ...state, installSupported: true }
        const digest = await expectedHash(asset, version)
        if (!digest) throw new Error(`No SHA-256 checksum was published for ${asset.name}`)
        installerPath = await download(asset, digest)
        state = { ...state, status: 'ready', canInstall: true, progress: 1 }
        if (Notification.isSupported()) {
          new Notification({ title: 'byndery update ready', body: `Version ${version} will install when you close byndery.` }).show()
        }
      } else if (build.kind !== 'manual' && asset) {
        state = { ...state, installSupported: true }
      }
      emit()
      return getUpdateState()
    } catch (error) {
      state = { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) }
      emit()
      return getUpdateState()
    }
  })().finally(() => {
    checking = null
  })
  return checking
}

export function setAutoUpdatesEnabled(enabled: boolean): UpdateState {
  autoEnabled = enabled
  mkdirSync(dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ autoEnabled }), 'utf8')
  state = { ...state, autoEnabled }
  emit()
  if (enabled) void checkForUpdates()
  return getUpdateState()
}

function installDownloadedUpdate(relaunch: boolean): boolean {
  if (!installerPath || !release) return false
  const file = installerPath
  installerPath = null
  const build = target()
  if (build.kind === 'nsis') {
    // /S keeps the install folder and shortcuts; --force-run opens byndery again afterwards.
    const child = spawn(file, ['/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' })
    child.once('error', (error) => {
      state = { ...state, status: 'error', error: error.message }
      emit()
    })
    child.unref()
    if (relaunch) app.quit()
    return true
  }
  if (build.kind === 'appimage' && process.env.APPIMAGE) {
    const destination = process.env.APPIMAGE
    const staged = `${destination}.new`
    copyFileSync(file, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, destination)
    rmSync(file, { force: true })
    if (relaunch) {
      app.relaunch({ execPath: destination, args: [] })
      app.quit()
    }
    return true
  }
  return false
}

export async function installUpdateNow(): Promise<UpdateState> {
  if (!release || !state.availableVersion || !state.releasePage) return getUpdateState()
  if (target().kind === 'manual' || !state.installSupported) {
    await shell.openExternal(state.releasePage)
    return getUpdateState()
  }
  try {
    if (state.status !== 'ready') {
      const build = target()
      const name = assetName(state.availableVersion, build)
      const asset = release.assets.find((item) => item.name.toLowerCase() === name.toLowerCase())
      if (!asset) throw new Error(`The release has no installer for ${build.os} ${build.arch}`)
      const digest = await expectedHash(asset, state.availableVersion)
      if (!digest) throw new Error(`No SHA-256 checksum was published for ${asset.name}`)
      installerPath = await download(asset, digest)
      state = { ...state, status: 'ready', canInstall: true, progress: 1 }
      emit()
    }
    if (installDownloadedUpdate(true)) state = { ...state, status: 'idle' }
    else state = { ...state, status: 'error', error: 'The update cannot replace this installation.' }
  } catch (error) {
    state = { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
  emit()
  return getUpdateState()
}

export function installPendingOnQuit(): void {
  if (!autoEnabled || state.status !== 'ready' || !installerPath) return
  try {
    installDownloadedUpdate(false)
  } catch (error) {
    state = { ...state, status: 'error', error: error instanceof Error ? error.message : String(error) }
    emit()
  }
}

export function startUpdater(): void {
  loadPreference()
  if (!app.isPackaged) return
  const first = setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
  const repeat = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
  first.unref()
  repeat.unref()
}
