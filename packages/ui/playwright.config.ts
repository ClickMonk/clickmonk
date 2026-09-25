import { defineConfig } from '@playwright/test'

const out = process.env.CLICKMONK_E2E_OUT ?? 'test-results'

/**
 * The browser suite. Run only by the stack suite in test/stack/ui.test.ts,
 * inside Playwright's own image, against the shipped stack.
 *
 * `ignoreHTTPSErrors` because the stack's certificates come from an authority
 * that exists only inside the stack; nothing here ever reaches another host.
 * One worker, no retries: the suite drives one install in order, and a retry
 * would hide the flake the run exists to show.
 *
 * `timezoneId` puts the browser in a zone half an hour off the hour, with
 * daylight saving, where time logic that is right only in UTC shows itself.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: `${out}/results`,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${out}/report` }]],
  use: {
    baseURL: process.env.CLICKMONK_E2E_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    timezoneId: 'Australia/Adelaide',
  },
})
