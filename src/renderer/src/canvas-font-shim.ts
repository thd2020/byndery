// xterm.js 6.0's WebGL renderer sets the canvas font to `${italic} ${weight}
// ${size}px ${family}`, which starts with a space when the text is not italic.
// Chromium 142 (Electron 45) rejects a font string with leading whitespace and
// keeps the default "10px sans-serif", so every glyph in the atlas came out in
// a small proportional face. Trimming the value before the canvas parses it
// fixes that without patching xterm. Remove once xterm stops emitting the space.

for (const proto of [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype]) {
  const desc = Object.getOwnPropertyDescriptor(proto, 'font')
  if (!desc?.set || !desc.get) continue
  const { get, set } = desc
  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: desc.enumerable,
    get,
    set(this: CanvasRenderingContext2D, v: string) {
      set.call(this, typeof v === 'string' ? v.trim() : v)
    }
  })
}

export {}
