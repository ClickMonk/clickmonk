import { describe, expect, it } from 'vitest'
import { AttemptCounter, ConcurrencyGate } from './attempts.js'

describe('counting failed attempts', () => {
  it('allows up to the limit of failures and then refuses', () => {
    const c = new AttemptCounter(3, 60_000)
    for (let i = 0; i < 3; i++) {
      expect(c.check('k', 0).allowed, `attempt ${i}`).toBe(true)
      c.fail('k', 0)
    }
    const refused = c.check('k', 0)
    expect(refused.allowed).toBe(false)
    expect(refused.failures).toBe(3)
    expect(refused.retryAfterMs).toBe(60_000)
  })

  it('counts each key on its own', () => {
    const c = new AttemptCounter(1, 60_000)
    c.fail('a', 0)
    expect(c.check('a', 0).allowed).toBe(false)
    expect(c.check('b', 0).allowed).toBe(true)
  })

  it('forgets a key that got the secret right', () => {
    const c = new AttemptCounter(1, 60_000)
    c.fail('k', 0)
    expect(c.check('k', 0).allowed).toBe(false)
    c.succeed('k')
    expect(c.check('k', 0).allowed).toBe(true)
  })

  it('starts a new window on time, and on a clock that stepped backwards', () => {
    const c = new AttemptCounter(1, 60_000)
    c.fail('k', 1000)
    expect(c.check('k', 60_999).allowed).toBe(false)
    expect(c.check('k', 61_000).allowed).toBe(true)
    c.fail('k', 61_000)
    expect(c.check('k', 61_000).allowed).toBe(false)
    expect(c.check('k', 5).allowed).toBe(true)
  })

  it('counts down to the window turning over', () => {
    const c = new AttemptCounter(1, 60_000)
    c.fail('k', 1000)
    expect(c.check('k', 31_000).retryAfterMs).toBe(30_000)
  })

  // Fails closed, unlike the abuser counter: admitting a key the bound left
  // out would make filling the map the way to buy unlimited guesses.
  it('refuses a key it has no room for, and says the bound did it', () => {
    const c = new AttemptCounter(3, 60_000, 2)
    c.fail('a', 0)
    c.fail('b', 0)
    const refused = c.check('c', 0)
    expect(refused.allowed).toBe(false)
    expect(refused.failures).toBe(0)
    expect(c.stats()).toEqual({ keys: 2, refused: 1, saturated: 1 })
    // A key already counted keeps its own allowance.
    expect(c.check('a', 0).allowed).toBe(true)
    // And the next window has room again.
    expect(c.check('c', 60_000).allowed).toBe(true)
  })

  it('does not grow past the bound even when a refused key keeps failing', () => {
    const c = new AttemptCounter(3, 60_000, 2)
    c.fail('a', 0)
    c.fail('b', 0)
    for (let i = 0; i < 100; i++) c.fail(`flood-${i}`, 0)
    expect(c.stats().keys).toBe(2)
  })
})

describe('bounding password checks in flight', () => {
  it('admits up to the limit and refuses the rest until one leaves', () => {
    const g = new ConcurrencyGate(2)
    expect(g.tryEnter()).toBe(true)
    expect(g.tryEnter()).toBe(true)
    expect(g.tryEnter()).toBe(false)
    expect(g.stats()).toEqual({ inFlight: 2, refused: 1 })
    g.leave()
    expect(g.tryEnter()).toBe(true)
  })

  it('never counts below zero, however often leave is called', () => {
    const g = new ConcurrencyGate(1)
    g.leave()
    g.leave()
    expect(g.stats().inFlight).toBe(0)
    expect(g.tryEnter()).toBe(true)
    expect(g.tryEnter()).toBe(false)
  })
})
