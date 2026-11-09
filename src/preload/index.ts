import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Bridge } from '../shared/api'

const sys = ipcRenderer.sendSync('sys:info') as { windowsBuild?: number; home: string }

const bridge: Bridge = {
  platform: process.platform,
  sys,
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    setTitleBarColors: (bg, fg) => ipcRenderer.send('win:titleBarColors', bg, fg),
    onMaximized: (cb) => void ipcRenderer.on('win:maximized', (_e, m: boolean) => cb(m))
  },
  workspace: {
    initial: () => ipcRenderer.invoke('ws:initial'),
    pick: () => ipcRenderer.invoke('ws:pick')
  },
  term: {
    create: (cwd, cols, rows) => ipcRenderer.invoke('term:create', cwd, cols, rows),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    ack: (id, n) => ipcRenderer.send('term:ack', id, n),
    resize: (id, c, r) => ipcRenderer.send('term:resize', id, c, r),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (cb) => void ipcRenderer.on('term:data', (_e, id: number, d: string) => cb(id, d)),
    onExit: (cb) => void ipcRenderer.on('term:exit', (_e, id: number, code: number) => cb(id, code))
  },
  fs: {
    list: (d) => ipcRenderer.invoke('fs:list', d),
    read: (p) => ipcRenderer.invoke('fs:read', p),
    write: (p, t) => ipcRenderer.invoke('fs:write', p, t),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
    watch: (r) => ipcRenderer.invoke('fs:watch', r),
    onChange: (cb) => void ipcRenderer.on('fs:change', (_e, c) => cb(c)),
    reveal: (p) => ipcRenderer.send('fs:reveal', p),
    openExternal: (p) => ipcRenderer.send('fs:openExternal', p),
    find: (r) => ipcRenderer.invoke('fs:find', r),
    rename: (a, b) => ipcRenderer.invoke('fs:rename', a, b),
    trash: (p) => ipcRenderer.invoke('fs:trash', p),
    create: (p, d) => ipcRenderer.invoke('fs:create', p, d),
    pathForFile: (f) => webUtils.getPathForFile(f)
  },
  git: {
    status: (r) => ipcRenderer.invoke('git:status', r),
    show: (p) => ipcRenderer.invoke('git:show', p)
  },
  clipboard: {
    write: (t) => ipcRenderer.send('clip:write', t),
    read: () => ipcRenderer.invoke('clip:read')
  },
  history: {
    record: (r) => ipcRenderer.send('history:record', r),
    search: (q) => ipcRenderer.invoke('history:search', q),
    output: (id) => ipcRenderer.invoke('history:output', id),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (cb) => void ipcRenderer.on('settings:changed', (_e, s) => cb(s))
  },
  menu: (items) => ipcRenderer.invoke('menu:popup', items),
  confirm: (m, d, b) => ipcRenderer.invoke('dialog:confirm', m, d, b),
  devtools: () => ipcRenderer.send('win:devtools')
}

contextBridge.exposeInMainWorld('byndery', bridge)
