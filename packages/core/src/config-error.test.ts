import { describe, expect, it } from 'vitest'
import { formatConfigError } from './config-error.js'

describe('formatConfigError', () => {
  it('names every bad variable, one per line', () => {
    const text = formatConfigError({
      issues: [
        { path: ['CLICKMONK_POSTGRES_URL'], message: 'Required' },
        { path: ['CLICKMONK_SECRET'], message: 'must be at least 32 characters' },
      ],
    })
    expect(text).toBe(
      'invalid configuration:\n  CLICKMONK_POSTGRES_URL: Required\n  CLICKMONK_SECRET: must be at least 32 characters',
    )
  })
})
