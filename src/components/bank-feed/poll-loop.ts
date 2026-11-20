/**
 * One request at a time: the next poll is scheduled when the previous one
 * answered, never on a fixed clock, so a slow answer cannot pile requests up.
 * The same loop drives the BankID consent (every second, the animated QR
 * changes that often) and the payments verification (every 15 seconds).
 *
 * A failed poll is sorted here, for every caller (crm#1355): a refusal no
 * retry changes (an HTTP 4xx other than 408 and 429: the connection is gone,
 * the session ended, the request is not allowed) ends the loop at once; any
 * other failure (the network, a 5xx, a timeout, a rate limit) is retried on
 * the next tick, at most MAX_POLL_FAILURES times in a row. Either way the
 * loop ends instead of asking forever, and onGiveUp tells the caller why, so
 * a waiting screen can say so. Stopping aborts the request in flight and
 * cancels the pending tick.
 */

/** Failed polls in a row (with no answer in between) before the loop gives up. */
export const MAX_POLL_FAILURES = 10

/** Why the loop ended on a failure: the server refused the poll itself, or nothing answered for MAX_POLL_FAILURES polls. */
export type PollGiveUpReason = 'refused' | 'unreachable'

/**
 * A failure that asking again cannot change: the error carries an HTTP 4xx
 * status other than 408 (timeout) and 429 (too many requests). A thrown
 * fetch (the network) carries none and a 5xx is the server's own trouble,
 * so both are retried.
 */
export function isPermanentPollFailure(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

export interface PollLoopOptions<T> {
  poll: (signal: AbortSignal) => Promise<T>
  /** Return true to keep polling, false to stop. */
  onResult: (result: T) => boolean
  intervalMs: number
  /** Whether the first poll runs at once (default: after one interval). */
  immediate?: boolean
  /** Called once when the loop ends on a failure instead of a result, with the last error. */
  onGiveUp?: (error: unknown, reason: PollGiveUpReason) => void
  /** Failed polls in a row tolerated before giving up (default MAX_POLL_FAILURES). */
  maxFailures?: number
}

/** Start the loop; the returned function stops it. */
export function startPollLoop<T>({
  poll,
  onResult,
  intervalMs,
  immediate = false,
  onGiveUp,
  maxFailures = MAX_POLL_FAILURES,
}: PollLoopOptions<T>): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let failures = 0

  const tick = async () => {
    timer = null
    let result: T
    try {
      result = await poll(controller.signal)
    } catch (error) {
      if (stopped) return
      failures += 1
      const reason: PollGiveUpReason | null = isPermanentPollFailure(error) ? 'refused' : failures >= maxFailures ? 'unreachable' : null
      if (reason) {
        onGiveUp?.(error, reason)
        return
      }
      timer = setTimeout(tick, intervalMs)
      return
    }
    if (stopped) return
    failures = 0
    if (!onResult(result)) return
    timer = setTimeout(tick, intervalMs)
  }

  if (immediate) void tick()
  else timer = setTimeout(tick, intervalMs)

  return () => {
    stopped = true
    controller.abort()
    if (timer) clearTimeout(timer)
  }
}
