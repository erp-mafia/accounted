/**
 * A refresh loop for a browser tab that spends a request only when the answer
 * can have changed what the user sees.
 *
 * Why: the dashboard chrome polled its status routes on a fixed clock, on
 * every navigation and on every focus. Each request pays the middleware
 * (session refresh plus active-company resolution) before its own query, and
 * /api/import/sie/holds alone answered about 72 000 requests a day while
 * almost every answer was the same empty list.
 *
 * - `refresh()` fetches now (mount, a same-browser change signal). A refresh
 *   that arrives while a fetch is in flight runs once more after it, so a
 *   change announced mid-request is never answered with the older result.
 * - `nudge()` is for navigation, window focus and the tab becoming visible:
 *   it fetches only when the last successful fetch is at least
 *   `staleAfterMs(last)` old. A nudge while the tab is hidden stops the timer.
 * - After a fetch the next timed refresh is `intervalMs(last)` away, or none
 *   when that is null. A failed fetch keeps the last result and retries after
 *   `intervalMs(last) ?? retryMs`.
 * - A hidden tab never fetches; the nudge on its return resumes the loop.
 */

export interface VisiblePollerOptions<T> {
  load: (signal: AbortSignal) => Promise<T>
  onResult: (value: T) => void
  /** Delay to the next timed refresh after `last`; null for none. */
  intervalMs: (last: T | undefined) => number | null
  /** How old the last success must be before a nudge fetches again. */
  staleAfterMs: (last: T | undefined) => number
  /** Retry delay after a failure when `intervalMs` gives none. */
  retryMs: number | null
  isVisible: () => boolean
  now?: () => number
}

export interface VisiblePoller {
  refresh: () => void
  nudge: () => void
  stop: () => void
}

export function createVisiblePoller<T>(options: VisiblePollerOptions<T>): VisiblePoller {
  const now = options.now ?? Date.now
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let rerun = false
  let last: T | undefined
  let lastSuccessAt = Number.NEGATIVE_INFINITY

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function schedule(delay: number | null) {
    clearTimer()
    if (delay === null || controller.signal.aborted || !options.isVisible()) return
    timer = setTimeout(() => {
      timer = undefined
      void run(false)
    }, Math.max(0, delay))
  }

  async function run(force: boolean): Promise<void> {
    if (controller.signal.aborted) return
    if (inFlight) {
      if (force) rerun = true
      return
    }
    clearTimer()
    if (!options.isVisible()) return
    inFlight = true
    let failed = false
    try {
      const value = await options.load(controller.signal)
      if (!controller.signal.aborted) {
        last = value
        lastSuccessAt = now()
        options.onResult(value)
      }
    } catch {
      // Keep the last known result on screen while disconnected.
      failed = true
    } finally {
      inFlight = false
    }
    if (controller.signal.aborted) return
    if (rerun) {
      rerun = false
      return run(true)
    }
    schedule(failed ? options.intervalMs(last) ?? options.retryMs : options.intervalMs(last))
  }

  return {
    refresh: () => void run(true),
    nudge: () => {
      if (controller.signal.aborted || inFlight) return
      if (!options.isVisible()) {
        clearTimer()
        return
      }
      const age = now() - lastSuccessAt
      if (age >= options.staleAfterMs(last)) {
        void run(false)
        return
      }
      // Fresh enough: resume a timer the hidden tab stopped, from where it was.
      if (timer === undefined) {
        const interval = options.intervalMs(last)
        if (interval !== null) schedule(interval - age)
      }
    },
    stop: () => {
      controller.abort()
      clearTimer()
    },
  }
}
