/**
 * Pacing for a queue of inbox uploads.
 *
 * The inbox takes a fixed number of uploads per company and calendar minute
 * (lib/rate-limits/inbox.ts). A person who drops a month of receipts at once
 * sends them faster than that, and the queue used to send every remaining
 * file into the refusal: on 2026-11-09 one drop of 115 files left 85 refused
 * in under two minutes, each with its own error toast and no way to tell
 * which files had made it. The refusal is short and says when it ends, so
 * the queue waits it out and sends the same file again.
 *
 * Only the per-minute refusal is waited out. The daily limit answers with an
 * hour in Retry-After: that response is returned as it is, for the caller to
 * show.
 */

/** A refusal that asks for a longer wait than this is not waited out. */
export const PACED_UPLOAD_MAX_WAIT_SEC = 60

/**
 * How many times one file waits. The window is a calendar minute, so one wait
 * is normally enough; a second covers a wait that ended a moment before the
 * server's minute did, and a third another tab uploading for the same company.
 */
const MAX_WAITS_PER_FILE = 3

/** Past the minute boundary by this much before sending again (clock skew). */
const BOUNDARY_MARGIN_SEC = 2

export interface PacedUploadOptions {
  /** Seconds the queue will now wait before it sends the file again; null when the wait is over. */
  onWait?: (seconds: number | null) => void
  /**
   * Asked after each wait: false abandons the file (the page it was dropped
   * on is gone) and resolves to the refusal without sending again.
   */
  shouldContinue?: () => boolean
  /** Injectable for tests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * How long to wait before sending the same upload again, or null when the
 * response is not a short rate-limit refusal.
 *
 * The limit resets when the server's calendar minute ends, so the Date header
 * (the server's clock, not the browser's) gives the real wait; Retry-After is
 * the flat upper bound the route answers with, used when Date is missing.
 */
export function pacedUploadWaitSec(response: Response): number | null {
  if (response.status !== 429) return null
  const retryAfter = Number(response.headers.get('Retry-After'))
  if (!Number.isFinite(retryAfter) || retryAfter <= 0 || retryAfter > PACED_UPLOAD_MAX_WAIT_SEC) return null
  const serverNow = Date.parse(response.headers.get('Date') ?? '')
  if (!Number.isFinite(serverNow)) return retryAfter
  const secondsIntoMinute = Math.floor(serverNow / 1000) % 60
  return Math.min(retryAfter, 60 - secondsIntoMinute + BOUNDARY_MARGIN_SEC)
}

/**
 * Send one upload, waiting out a per-minute refusal and sending it again.
 *
 * `send` is called once per attempt and must build its request anew each
 * time. Resolves to the response that ended the sequence: the first one that
 * is not a short rate-limit refusal, or the last refusal once the file has
 * waited MAX_WAITS_PER_FILE times, so callers keep their `if (!res.ok)`
 * handling.
 */
export async function sendPacedUpload(
  send: () => Promise<Response>,
  options: PacedUploadOptions = {},
): Promise<Response> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let response = await send()
  for (let waits = 0; waits < MAX_WAITS_PER_FILE; waits++) {
    const waitSec = pacedUploadWaitSec(response)
    if (waitSec === null) return response
    options.onWait?.(waitSec)
    try {
      await sleep(waitSec * 1000)
    } finally {
      options.onWait?.(null)
    }
    if (options.shouldContinue && !options.shouldContinue()) return response
    response = await send()
  }
  return response
}
