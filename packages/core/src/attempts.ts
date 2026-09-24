/**
 * Counting failed attempts against a secret, in fixed windows, in memory.
 *
 * Used twice: for the admin login, keyed by the client the attempt came from,
 * and for a link's password page, keyed by client and link together. A client
 * is what `rateKey` counts — one IPv4 address, or one IPv6 /64, because an IPv6
 * client usually holds a whole /64 and could otherwise buy a fresh allowance
 * per request. Both are gates in front of a deliberately slow hash, so the
 * count is what stops one client from spending the process's CPU on guesses.
 *
 * **This counter fails closed**, which is the opposite of the abuser counter
 * on the redirect path. When the map is full and the window has not turned
 * over, a key that is not already in it is refused rather than let through:
 * letting it through would make filling the map the way to buy unlimited
 * guesses. The cost is the other direction — an attacker who fills the map
 * refuses everyone's password attempts for the rest of the window (never
 * their clicks, only the password form and the login) — so the bound is high
 * and the window is short.
 */

/** Keys held per window. About 5 MB of Map at the default. */
export const DEFAULT_MAX_ATTEMPT_KEYS = 50_000

export interface AttemptResult {
  /** False: refused. The caller answers without checking the secret. */
  allowed: boolean
  /** Failures recorded for this key in this window, before this attempt. */
  failures: number
  /** Milliseconds until the window turns over, for a Retry-After header. */
  retryAfterMs: number
}

export class AttemptCounter {
  private windowStart = Number.NEGATIVE_INFINITY
  private readonly failures = new Map<string, number>()
  private refused = 0
  private saturated = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = DEFAULT_MAX_ATTEMPT_KEYS,
  ) {}

  private roll(nowMs: number): void {
    // A clock stepped backwards starts a new window rather than never ending this one.
    if (nowMs - this.windowStart >= this.windowMs || nowMs < this.windowStart) {
      this.failures.clear()
      this.windowStart = nowMs
      this.refused = 0
      this.saturated = 0
    }
  }

  /**
   * Whether this key may make another attempt now. Nothing is counted here:
   * the caller records the outcome with `fail()` or `succeed()`, so a correct
   * password never counts against the key that used it.
   */
  check(key: string, nowMs: number): AttemptResult {
    this.roll(nowMs)
    const retryAfterMs = Math.max(0, this.windowStart + this.windowMs - nowMs)
    const failures = this.failures.get(key) ?? 0
    if (failures >= this.limit) {
      this.refused++
      return { allowed: false, failures, retryAfterMs }
    }
    // Full window, and this key is not in it: refused, because admitting it
    // would make a flood of keys the way to buy unlimited guesses.
    if (failures === 0 && this.failures.size >= this.maxKeys) {
      this.refused++
      this.saturated++
      return { allowed: false, failures, retryAfterMs }
    }
    return { allowed: true, failures, retryAfterMs }
  }

  /** Records a wrong secret for this key. */
  fail(key: string, nowMs: number): void {
    this.roll(nowMs)
    const failures = this.failures.get(key) ?? 0
    if (failures === 0 && this.failures.size >= this.maxKeys) return
    this.failures.set(key, failures + 1)
  }

  /** Forgets this key's failures: the secret was right. */
  succeed(key: string): void {
    this.failures.delete(key)
  }

  /** Keys with failures this window, attempts refused, and how many of those were the bound. */
  stats(): { keys: number; refused: number; saturated: number } {
    return { keys: this.failures.size, refused: this.refused, saturated: this.saturated }
  }
}

/**
 * How many password checks a process will run at once.
 *
 * A password check is deliberately expensive — 16 or 32 MiB and tens of
 * milliseconds — which is exactly what makes an unbounded number of them a
 * way to stop the process. Callers that verify a password (the admin's
 * sign-in, a link's password page) take a slot first and answer "try again"
 * rather than queueing, so a flood costs a refusal per request instead of the
 * event loop.
 */
export class ConcurrencyGate {
  private inFlight = 0
  private refused = 0

  constructor(private readonly limit: number) {}

  /** True when the caller may proceed; it must then call `leave()`. */
  tryEnter(): boolean {
    if (this.inFlight >= this.limit) {
      this.refused++
      return false
    }
    this.inFlight++
    return true
  }

  leave(): void {
    if (this.inFlight > 0) this.inFlight--
  }

  stats(): { inFlight: number; refused: number } {
    return { inFlight: this.inFlight, refused: this.refused }
  }
}
