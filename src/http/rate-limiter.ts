import { HttpError } from '../errors.js'

interface Counter {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly counters = new Map<string, Counter>()

  check(key: string, maximum: number, windowMs: number): void {
    const now = Date.now()
    const existing = this.counters.get(key)
    if (existing === undefined || existing.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowMs })
      this.prune(now)
      return
    }
    existing.count += 1
    if (existing.count > maximum) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests', { retryAfter })
    }
  }

  private prune(now: number): void {
    if (this.counters.size < 2000) return
    for (const [key, value] of this.counters) {
      if (value.resetAt <= now) this.counters.delete(key)
    }
  }
}
