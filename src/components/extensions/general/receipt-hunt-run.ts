/**
 * What one press of "Leta i mejlen" does, and when it stops.
 *
 * Kept apart from the React hook (use-receipt-hunt.ts) so the stop conditions
 * are tested without a DOM: each is a claim the result line makes to the
 * person, and a wrong one tells them their receipts do not exist.
 *
 * Why a loop of passes rather than one long request: a pass is bounded by the
 * serverless ceiling, and each receipt costs a download plus a model read, so
 * a backlog does not clear inside one invocation. A queue drained by cron
 * would be the other option, but the finest schedule this app runs is hourly.
 *
 * It stops when a pass fetches nothing new. That is the honest signal that
 * the mailboxes hold nothing more for the purchases still open, and it is why
 * MAX_PASSES is a backstop rather than a budget.
 */

/** One pass, as POST /api/receipt-hunt/run answers it. */
export interface HuntPass {
  purchasesWithoutReceipt?: number
  searched: number
  fetched: number
  proposed: number
  remaining: number
  /** Mailboxes that refused the search. Non-zero means "we could not look". */
  searchFailures?: number
}

export interface HuntProgress {
  passes: number
  fetched: number
  proposed: number
}

export type HuntOutcome =
  /** A pass found nothing new, the backstop was reached, or the person stopped it. */
  | { kind: 'finished'; fetched: number; proposed: number; remaining: number }
  /**
   * A mailbox could not be read. Zero fetched then says nothing about what is
   * in there, so this must never be reported as "nothing found".
   */
  | { kind: 'mailbox_unreadable'; fetched: number; proposed: number; remaining: number }
  /** The company does not hold the paid `ai` capability (403 capability_blocked). */
  | { kind: 'blocked'; fetched: number; proposed: number }
  /** Another pass is already running for this company (409): wait for it. */
  | { kind: 'busy'; fetched: number; proposed: number }
  /** The company's daily pass budget is spent (429): pressing again cannot help today. */
  | { kind: 'limited'; fetched: number; proposed: number }
  /** Our side failed: network, a 5xx, or an answer that is not a pass. */
  | { kind: 'failed'; fetched: number; proposed: number }

/**
 * Each pass fetches a few receipts, so this is far more than any real backlog
 * needs. It exists so a pass that keeps reporting work it never completes
 * cannot run forever.
 */
export const MAX_PASSES = 25

function readPass(body: unknown): HuntPass | null {
  const data = (body as { data?: unknown } | null)?.data as Record<string, unknown> | undefined
  if (!data) return null
  const count = (key: string) => (typeof data[key] === 'number' && Number.isFinite(data[key]) ? (data[key] as number) : null)
  const fetched = count('fetched')
  if (fetched === null) return null
  return {
    purchasesWithoutReceipt: count('purchasesWithoutReceipt') ?? undefined,
    searched: count('searched') ?? 0,
    fetched,
    proposed: count('proposed') ?? 0,
    remaining: count('remaining') ?? 0,
    searchFailures: count('searchFailures') ?? 0,
  }
}

async function isCapabilityRefusal(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const body = (await response.json().catch(() => null)) as { capability_blocked?: unknown } | null
  return body?.capability_blocked === true
}

export async function runReceiptHunt({
  request,
  shouldStop,
  onPass,
  maxPasses = MAX_PASSES,
}: {
  /** One POST to the run route. */
  request: () => Promise<Response>
  /** Read before every pass, so a stop takes effect after the current one. */
  shouldStop: () => boolean
  /** After each pass, so a caller can refresh what that pass changed. */
  onPass?: (progress: HuntProgress) => void
  maxPasses?: number
}): Promise<HuntOutcome> {
  let passes = 0
  let fetched = 0
  let proposed = 0
  let remaining = 0

  try {
    while (!shouldStop() && passes < maxPasses) {
      const response = await request()
      if (!response.ok) {
        if (await isCapabilityRefusal(response)) return { kind: 'blocked', fetched, proposed }
        if (response.status === 409) return { kind: 'busy', fetched, proposed }
        if (response.status === 429) return { kind: 'limited', fetched, proposed }
        return { kind: 'failed', fetched, proposed }
      }

      const pass = readPass(await response.json().catch(() => null))
      if (!pass) return { kind: 'failed', fetched, proposed }

      passes++
      fetched += pass.fetched
      proposed += pass.proposed
      remaining = pass.remaining
      onPass?.({ passes, fetched, proposed })

      if ((pass.searchFailures ?? 0) > 0) {
        return { kind: 'mailbox_unreadable', fetched, proposed, remaining }
      }
      if (pass.fetched === 0) return { kind: 'finished', fetched, proposed, remaining }
    }
    return { kind: 'finished', fetched, proposed, remaining }
  } catch {
    return { kind: 'failed', fetched, proposed }
  }
}
