import { defineConfig } from 'vite'

// The renderer: plain TypeScript pages, served to Tauri's web view. The
// backend is the Rust crate in src-tauri.
export default defineConfig({
  root: 'src/renderer',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    target: ['chrome120', 'safari16'],
    chunkSizeWarningLimit: 2000
  }
})
