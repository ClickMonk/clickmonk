import { describe, expect, it } from 'vitest'
import { RATE_WINDOW_MS, RateCounter } from './rate.js'

// Times are offsets from an arbitrary start; the counter never reads a clock.
const T = 1_000_000

describe('RateCounter', () => {
  it('counts each address on its own, this request included', () => {
    const r = new RateCounter()
    expect(r.hit('192.0.2.1', T)).toBe(1)
    expect(r.hit('192.0.2.1', T + 1)).toBe(2)
    expect(r.hit('192.0.2.2', T + 2)).toBe(1)
    expect(r.hit('192.0.2.1', T + 3)).toBe(3)
  })

  it('counts IPv6 per /64', () => {
    const r = new RateCounter()
    expect(r.hit('2001:db8:0:1::1', T)).toBe(1)
    // Same /64: shares bits 0-63 and differs in every bit of 64-127.
    expect(r.hit('2001:db8:0:1:ffff:ffff:ffff:fffe', T)).toBe(2)
    // A different /64.
    expect(r.hit('2001:db8:0:2::1', T)).toBe(1)
  })

  it('starts again when the window turns over', () => {
    const r = new RateCounter()
    r.hit('192.0.2.1', T)
    expect(r.hit('192.0.2.1', T + RATE_WINDOW_MS - 1)).toBe(2)
    expect(r.hit('192.0.2.1', T + RATE_WINDOW_MS)).toBe(1)
  })

  it('starts again when the clock moves backwards', () => {
    const r = new RateCounter()
    r.hit('192.0.2.1', T)
    expect(r.hit('192.0.2.1', T - 1)).toBe(1)
  })

  it('counts nothing for a request with no address', () => {
    const r = new RateCounter()
    expect(r.hit('', T)).toBe(0)
    expect(r.hit('', T)).toBe(0)
    expect(r.stats()).toEqual({ addresses: 0, untracked: 0 })
  })

  it('holds at most maxAddresses, and keeps counting the ones it holds', () => {
    const r = new RateCounter(2)
    r.hit('192.0.2.1', T)
    r.hit('192.0.2.2', T)
    // Full: a new address is not held, so each request reads as its first.
    expect(r.hit('192.0.2.3', T)).toBe(1)
    expect(r.hit('192.0.2.3', T)).toBe(1)
    expect(r.hit('192.0.2.1', T)).toBe(2)
    expect(r.stats()).toEqual({ addresses: 2, untracked: 2 })
    // A new window has room again, and the untracked count resets with it.
    r.hit('192.0.2.3', T + RATE_WINDOW_MS)
    expect(r.hit('192.0.2.3', T + RATE_WINDOW_MS)).toBe(2)
    expect(r.stats()).toEqual({ addresses: 1, untracked: 0 })
  })
})
