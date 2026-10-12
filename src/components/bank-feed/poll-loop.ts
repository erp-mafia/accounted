/**
 * One request at a time: the next poll is scheduled when the previous one
 * answered, never on a fixed clock, so a slow answer cannot pile requests up.
 * A failed poll (network, a 5xx) is retried on the next tick; stopping aborts
 * the request in flight and cancels the pending tick. The same loop drives
 * the BankID consent (every second, the animated QR changes that often) and
 * the payments verification (every 15 seconds).
 */

export interface PollLoopOptions<T> {
  poll: (signal: AbortSignal) => Promise<T>
  /** Return true to keep polling, false to stop. */
  onResult: (result: T) => boolean
  intervalMs: number
  /** Whether the first poll runs at once (default: after one interval). */
  immediate?: boolean
  /** Called for a failed poll; return false to stop instead of retrying. */
  onError?: (error: unknown) => boolean
}

/** Start the loop; the returned function stops it. */
export function startPollLoop<T>({ poll, onResult, intervalMs, immediate = false, onError }: PollLoopOptions<T>): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const tick = async () => {
    timer = null
    let result: T
    try {
      result = await poll(controller.signal)
    } catch (error) {
      if (stopped) return
      if (onError && !onError(error)) return
      timer = setTimeout(tick, intervalMs)
      return
    }
    if (stopped) return
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
