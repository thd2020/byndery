import type { Bridge } from '../../shared/api'

declare global {
  interface Window {
    byndery: Bridge
  }
}

export const api: Bridge = window.byndery
export const isMac = api.platform === 'darwin'

/** Tiny event emitter, enough for the handful of app-wide events. */
export class Emitter<T> {
  private fns = new Set<(v: T) => void>()
  on(fn: (v: T) => void): () => void {
    this.fns.add(fn)
    return () => this.fns.delete(fn)
  }
  emit(v: T): void {
    for (const fn of this.fns) fn(v)
  }
}

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text != null) el.textContent = text
  return el
}

export const icon = (paths: string, viewBox = '0 0 16 16'): SVGSVGElement => {
  const t = document.createElement('template')
  t.innerHTML = `<svg viewBox="${viewBox}" aria-hidden="true">${paths}</svg>`
  return t.content.firstElementChild as SVGSVGElement
}

export const ICON = {
  close: '<path d="m4.5 4.5 7 7m0-7-7 7" />',
  chevron: '<path d="m6 4 4 4-4 4" />'
}
