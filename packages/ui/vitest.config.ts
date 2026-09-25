import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

// The interface's tests run in a zone that is neither UTC nor a whole hour
// from it, and has daylight saving: time logic that is right only in UTC fails
// here. Set in this file rather than by the script that runs it, so that the
// root gate, a filtered run and an editor's test runner all get it.
process.env.TZ = 'Australia/Adelaide'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'dist/**', 'dist-ts/**'],
  },
})
