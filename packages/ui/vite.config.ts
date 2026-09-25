import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // No preload helper injected into the page: the bundle is one chunk (no
    // route is lazy), so there is nothing to preload, and the page carries no
    // script of its own for the content security policy to refuse.
    modulePreload: false,
  },
})
