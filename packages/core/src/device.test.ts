import { describe, expect, it } from 'vitest'
import { classifyDevice } from './device.js'

describe('classifyDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'ios',
    ],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 'ios'],
    ['Mozilla/5.0 (iPod touch; CPU iPhone OS 12_0 like Mac OS X)', 'ios'],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',
      'android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      'desktop',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
      'desktop',
    ],
    ['curl/8.5.0', 'desktop'],
    ['', 'desktop'],
  ] as const)('%s -> %s', (ua, want) => {
    expect(classifyDevice(ua)).toBe(want)
  })

  it('treats a missing user-agent as desktop', () => {
    expect(classifyDevice(undefined)).toBe('desktop')
  })

  it('only reads the first 512 characters', () => {
    expect(classifyDevice(`${'x'.repeat(600)} Android 14`)).toBe('desktop')
  })
})
