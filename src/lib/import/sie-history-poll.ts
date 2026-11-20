/**
 * Refresh pace of the SIE import history (components/import/SIEImportHistory).
 *
 * The history polled GET /api/import/sie every 5 s for as long as it was
 * open, hidden tab included, and each answer carried every column of twenty
 * rows. It still follows a moving job (queued through finalizing, or an undo)
 * every 5 s, which is what the poll is for. When nothing moves, an unchanged
 * page doubles the wait up to a minute, and any change goes back to 5 s; a
 * hidden tab does not fetch and catches up within 5 s of coming back. A
 * paused job waits for a person and counts as not moving.
 */

export const SIE_HISTORY_POLL_MS = 5_000
export const SIE_HISTORY_IDLE_MAX_MS = 60_000

const MOVING_STATES: ReadonlySet<string> = new Set([
  'queued', 'preparing', 'running', 'reconciling', 'finalizing', 'undoing',
])

/** The columns of a history row that the page renders and that can change. */
export interface SIEHistoryPollRow {
  id: string
  status: string
  job_state?: string | null
  transactions_count: number
  repair_outcome?: string | null
}

export interface SIEHistoryPollGate {
  /** Whether a fetch is due at `now`. */
  due: (now: number) => boolean
  /** A page arrived at `now`: set the wait before the next fetch. */
  record: (rows: SIEHistoryPollRow[], now: number) => void
}

function signatureOf(rows: SIEHistoryPollRow[]): string {
  return JSON.stringify(rows.map((row) => [
    row.id, row.status, row.job_state ?? null, row.transactions_count, row.repair_outcome ?? null,
  ]))
}

export function createSIEHistoryPollGate(): SIEHistoryPollGate {
  let delay = SIE_HISTORY_POLL_MS
  let lastFetchAt = Number.NEGATIVE_INFINITY
  let signature: string | null = null
  return {
    due: (now) => now - lastFetchAt >= delay,
    record: (rows, now) => {
      const next = signatureOf(rows)
      const moving = rows.some((row) => !!row.job_state && MOVING_STATES.has(row.job_state))
      delay = moving || next !== signature
        ? SIE_HISTORY_POLL_MS
        : Math.min(delay * 2, SIE_HISTORY_IDLE_MAX_MS)
      signature = next
      lastFetchAt = now
    },
  }
}

/**
 * Tick every 5 s and fetch when the gate says so and the tab is visible.
 * `fetchPage` records its rows on the gate itself, so a fetch made outside
 * the loop (after an undo) resets the pace too. Stops when `signal` aborts.
 */
export function startSIEHistoryPolling(options: {
  gate: SIEHistoryPollGate
  fetchPage: () => Promise<void>
  isVisible: () => boolean
  signal: AbortSignal
  now?: () => number
}): void {
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (options.isVisible() && options.gate.due(now())) await options.fetchPage()
    if (!options.signal.aborted) timer = setTimeout(() => void tick(), SIE_HISTORY_POLL_MS)
  }
  options.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  timer = setTimeout(() => void tick(), 0)
}
