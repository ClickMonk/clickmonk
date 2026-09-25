import { expect, it } from 'vitest'

// Every time test in this package assumes this. If it fails, the config's TZ
// line did not take effect, and every other time test is testing UTC.
it('runs in Adelaide', () => {
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Australia/Adelaide')
  expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(-570)
  expect(new Date('2026-12-01T00:00:00Z').getTimezoneOffset()).toBe(-630)
})
