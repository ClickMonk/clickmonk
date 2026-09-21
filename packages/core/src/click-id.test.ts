import { describe, expect, it } from 'vitest'
import { uuidv7 } from './click-id.js'

describe('uuidv7', () => {
  it('has version 7 and the RFC 9562 variant', () => {
    const id = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(0xff))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const id = uuidv7(1_700_000_000_000, new Uint8Array(10))
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000)
  })

  it('sorts by time as a string', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(a < b).toBe(true)
  })
})
