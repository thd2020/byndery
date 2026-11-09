import type { Settings } from '../../shared/api'
import { api, h } from './bridge'

/**
 * The settings sheet. It holds only settings that work on this platform, and
 * every change applies at once, also to terminals that are already open.
 */
export class SettingsSheet {
  private el: HTMLDivElement
  private body: HTMLDivElement
  private settings: Settings | null = null
  private restoreFocus: HTMLElement | null = null

  constructor() {
    this.el = h('div', 'sheet')
    this.el.hidden = true
    this.el.setAttribute('role', 'dialog')
    this.el.setAttribute('aria-label', 'Settings')
    const head = h('div', 'sheet-head')
    head.append(h('span', 'sheet-title', 'Settings'))
    this.body = h('div', 'sheet-body')
    this.el.append(head, this.body)
    document.body.append(this.el)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) {
        e.preventDefault()
        this.close()
      }
    })
    document.addEventListener('mousedown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as Node)) this.close()
    })
    api.settings.onChange((s) => {
      this.settings = s
      if (!this.el.hidden) this.render()
    })
  }

  get isOpen(): boolean {
    return !this.el.hidden
  }

  async open(): Promise<void> {
    this.restoreFocus = document.activeElement as HTMLElement | null
    this.settings = await api.settings.get()
    this.render()
    this.el.hidden = false
    ;(this.el.querySelector('input') as HTMLInputElement | null)?.focus()
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.restoreFocus?.focus()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else void this.open()
  }

  private render(): void {
    const s = this.settings
    if (!s) return
    // A change re-renders the sheet; keep focus on the box that was changed.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key
    this.body.replaceChildren()
    if (api.platform === 'win32') {
      const group = h('fieldset', 'sheet-group')
      group.append(h('legend', '', 'Commands at the prompt'))
      const on = Object.values(s.commands).filter(Boolean).length
      const box = (key: keyof Settings['commands'], label: string): void => {
        const row = h('label', 'sheet-check')
        const input = h('input')
        input.type = 'checkbox'
        input.checked = s.commands[key]
        // At least one system has to run plain lines.
        input.disabled = input.checked && on === 1
        input.dataset.key = key
        input.addEventListener('change', () => void api.settings.set({ commands: { ...s.commands, [key]: input.checked } }))
        row.append(input, h('span', '', label))
        group.append(row)
      }
      box('linux', 'Linux')
      box('powershell', 'PowerShell')
      box('cmd', 'cmd')
      this.body.append(group)
    }
    const memory = h('fieldset', 'sheet-group')
    memory.append(h('legend', '', 'Command history'))
    const row = h('label', 'sheet-check')
    const input = h('input')
    input.type = 'checkbox'
    input.checked = s.memory
    input.dataset.key = 'memory'
    input.addEventListener('change', () => void api.settings.set({ memory: input.checked }))
    row.append(input, h('span', '', 'Remember commands and output'))
    const clear = h('button', 'text-btn sheet-action', 'Clear History…')
    clear.dataset.key = 'clear-history'
    clear.addEventListener('click', async () => {
      const choice = await api.confirm('Clear the command history?', 'Every remembered command and its output is deleted from this computer.', ['Clear', 'Cancel'])
      if (choice === 0) await api.history.clear()
    })
    memory.append(row, clear)
    this.body.append(memory)
    if (focused) (this.body.querySelector(`[data-key="${focused}"]`) as HTMLElement | null)?.focus()
  }
}
