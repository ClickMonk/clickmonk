import { rateKey } from '@clickmonk/ipdata'

export const RATE_WINDOW_MS = 60_000
/** At most this many addresses are counted per window: about 10 MB. */
export const DEFAULT_MAX_ADDRESSES = 100_000

/**
 * Requests per client in fixed one-minute windows, for the abuser class.
 * Held in memory only: a restart starts a new window, which a per-minute
 * threshold can afford.
 *
 * A client is `rateKey`'s idea of one, which is a /64 for IPv6 and an address
 * for IPv4; a string that is not an address is not counted at all, so this
 * counter fails open rather than counting every unreadable value as one client.
 *
 * Bounded: at most `maxAddresses` addresses per window. Once the window is
 * full, an address not already in it is not counted (it reads as its first
 * request) until the window turns over. Addresses already counted keep
 * counting, so a flood of new addresses cannot hide one that is already
 * abusive. A fixed window lets an address send up to twice the threshold
 * across a window boundary before it is caught.
 */
export class RateCounter {
  private windowStart = Number.NEGATIVE_INFINITY
  private readonly counts = new Map<string, number>()
  private untracked = 0

  constructor(private readonly maxAddresses = DEFAULT_MAX_ADDRESSES) {}

  /** Counts this request; returns the address's requests in this window, this one included. 0 for no address. */
  hit(ip: string, nowMs: number): number {
    // A clock that moved backwards starts a new window rather than never ending this one.
    if (nowMs - this.windowStart >= RATE_WINDOW_MS || nowMs < this.windowStart) {
      this.counts.clear()
      this.windowStart = nowMs
      this.untracked = 0
    }
    const key = rateKey(ip)
    if (key === null) return 0
    const n = this.counts.get(key)
    if (n !== undefined) {
      this.counts.set(key, n + 1)
      return n + 1
    }
    if (this.counts.size >= this.maxAddresses) {
      this.untracked++
      return 1
    }
    this.counts.set(key, 1)
    return 1
  }

  /** For the health endpoint: addresses counted, and requests from addresses the bound left uncounted, this window. */
  stats(): { addresses: number; untracked: number } {
    return { addresses: this.counts.size, untracked: this.untracked }
  }
}
