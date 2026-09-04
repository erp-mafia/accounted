/**
 * In-memory per-token rate limiter for the public token-authenticated routes
 * (calendar feed, payslip PDF). The token IS the authentication on those
 * routes, so the limit is keyed by token, not by user.
 *
 * Process-local by design: a multi-instance deploy limits per instance, which
 * is acceptable for these low-value endpoints. Each route creates its own
 * limiter so the maps stay isolated.
 */
export function createTokenRateLimiter(options: { max: number; windowMs: number; cleanupEveryMs?: number }) {
  const { max, windowMs, cleanupEveryMs = 5 * 60_000 } = options
  const entries = new Map<string, { count: number; resetAt: number }>()
  let lastCleanup = Date.now()

  // Periodic sweep of expired entries so the map cannot grow without bound.
  function cleanup() {
    const now = Date.now()
    if (now - lastCleanup < cleanupEveryMs) return
    lastCleanup = now
    for (const [key, value] of entries) {
      if (now > value.resetAt) entries.delete(key)
    }
  }

  return {
    /** Count one request for `token`; false when the window's budget is spent. */
    allow(token: string): boolean {
      cleanup()
      const nowMs = Date.now()
      const entry = entries.get(token)
      if (entry && nowMs < entry.resetAt) {
        if (entry.count >= max) return false
        entry.count++
      } else {
        entries.set(token, { count: 1, resetAt: nowMs + windowMs })
      }
      return true
    },
  }
}
