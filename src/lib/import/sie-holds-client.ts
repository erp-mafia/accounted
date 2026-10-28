/**
 * Client side of the SIE import hold banner (components/import/SIEImportHoldBanner):
 * the fetch, its refresh schedule, and the same-browser signal that a hold may
 * have changed.
 *
 * Schedule. A hold exists only while an import or undo job is unfinished
 * (running or paused), and the banner follows it every 5 s for its first two
 * minutes in this tab, then every minute: a hold that outlives that is a
 * paused job waiting for someone, or one left behind, and a tab left open on
 * it polled 720 times an hour. An announcement restarts the fast window, so
 * a resumed job is followed closely again. Otherwise the
 * answer changes only when a job starts or someone acknowledges an
 * opening-balance review, so there is no timer: navigation, focus and the tab
 * coming back refetch once the last answer is a minute old while a review is
 * on screen, five minutes when nothing is. The screens that start, resume or
 * undo a job and the review dialog call announceSIEHoldsChanged(), which
 * refetches at once in this tab and the browser's other tabs; a job started
 * elsewhere (an agent, another member) shows on the next page load or within
 * five minutes of use. Both RPCs that set a hold (start_sie_import_job, the
 * undo request) set it before they answer, so the refetch an announcement
 * triggers already sees it.
 */

export type HeldPeriod = {
  id: string
  name: string
  import_hold: string | null
  opening_balance_review_token?: string | null
  opening_balance_entry_id?: string | null
}

/** While a hold is new the banner follows the job at this pace. */
export const SIE_HOLD_POLL_MS = 5_000
/** How long this tab follows the same hold at SIE_HOLD_POLL_MS. */
export const SIE_HOLD_FAST_WINDOW_MS = 2 * 60_000
/** A hold seen for longer than the fast window is followed at this pace. */
export const SIE_HOLD_WAITING_POLL_MS = 60_000
/** A review on screen: navigation and focus refetch at most this often. */
export const SIE_HOLD_REVIEW_STALE_MS = 60_000
/** Nothing on screen: navigation and focus refetch at most this often. */
export const SIE_HOLD_IDLE_STALE_MS = 5 * 60_000
/** A failed fetch with no hold known retries after this long. */
export const SIE_HOLD_RETRY_MS = 60_000

const CHANGED_CHANNEL = 'accounted-sie-holds'
const CHANGED_EVENT = 'accounted:sie-holds-changed'

function hasHold(periods: HeldPeriod[] | undefined): boolean {
  return !!periods?.some((period) => period.import_hold)
}

/** `heldForMs`: how long this tab has seen the same hold (createSIEHoldClock). */
export function sieHoldPollInterval(periods: HeldPeriod[] | undefined, heldForMs = 0): number | null {
  if (!hasHold(periods)) return null
  return heldForMs < SIE_HOLD_FAST_WINDOW_MS ? SIE_HOLD_POLL_MS : SIE_HOLD_WAITING_POLL_MS
}

export interface SIEHoldClock {
  /** Milliseconds this tab has seen the same holds; a new or changed hold starts over. */
  heldFor: (periods: HeldPeriod[] | undefined) => number
  /** Start the fast window over (an announced start, resume or undo). */
  restart: () => void
}

export function createSIEHoldClock(now: () => number = Date.now): SIEHoldClock {
  let key: string | null = null
  let since = 0
  return {
    heldFor: (periods) => {
      const next = (periods ?? [])
        .filter((period) => period.import_hold)
        .map((period) => `${period.id}:${period.import_hold}`)
        .join(',')
      if (next !== key) {
        key = next
        since = now()
      }
      return now() - since
    },
    restart: () => {
      key = null
    },
  }
}

export function sieHoldStaleAfter(periods: HeldPeriod[] | undefined): number {
  if (hasHold(periods)) return SIE_HOLD_POLL_MS
  return periods?.some((period) => period.opening_balance_review_token)
    ? SIE_HOLD_REVIEW_STALE_MS
    : SIE_HOLD_IDLE_STALE_MS
}

export async function fetchSIEHolds(signal: AbortSignal): Promise<HeldPeriod[]> {
  const response = await fetch('/api/import/sie/holds', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`SIE holds answered ${response.status}`)
  const { data } = (await response.json()) as { data: HeldPeriod[] }
  return data
}

/**
 * Say that a hold or an opening-balance review may have changed: an import or
 * undo job was started or resumed, or a review was acknowledged. A
 * BroadcastChannel reaches every subscriber in this tab and the browser's
 * other tabs (the same post-then-close pattern as notifySessionExpired); a
 * window event stands in where BroadcastChannel is missing.
 */
export function announceSIEHoldsChanged(): void {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANGED_CHANNEL)
    channel.postMessage('changed')
    channel.close()
  } else if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGED_EVENT))
  }
}

/** Subscribe to announceSIEHoldsChanged() from this tab and the browser's others. */
export function onSIEHoldsChanged(listener: () => void): () => void {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANGED_CHANNEL)
    channel.onmessage = () => listener()
    return () => channel.close()
  }
  if (typeof window === 'undefined') return () => {}
  const handler = () => listener()
  window.addEventListener(CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHANGED_EVENT, handler)
}
