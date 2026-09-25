import { defineConfig } from '@playwright/test'

// Placeholder until the browser suite is written: an empty test directory so
// `playwright test` has a valid config to run against from day one, rather
// than every later task inventing its own.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.CSP_SERVER_URL ?? 'http://127.0.0.1:8788',
  },
  reporter: [['list']],
})
