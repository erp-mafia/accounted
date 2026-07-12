/**
 * Shared types for report drill-down to source vouchers.
 *
 * Every aggregated row (trial balance row, VAT ruta, AR customer, supplier
 * row) can be expanded to show the underlying journal entries that
 * contributed to it. The endpoints under
 * `/api/reports/<report>/<key>/sources` return these in a paginated form.
 */

/**
 * A single contributing line from a journal entry. Voucher number + series
 * uniquely identify the verifikat, while `journal_entry_id` is the route
 * target for `/bookkeeping/[id]`.
 */
export type ReportSourceLine = {
  journal_entry_id: string
  voucher_number: number
  voucher_series: string
  date: string
  description: string
  debit: number
  credit: number
  /** SIE dim → code tags on the line; omitted when untagged. */
  dimensions?: Record<string, string>
}

/**
 * Lazy-fetcher signature for client-side expansion. The component calls this
 * the first time the user expands a row.
 */
export type ReportSourceFetcher = () => Promise<{
  lines: ReportSourceLine[]
  next_cursor?: string | null
}>

/**
 * Response envelope for the lazy-fetch endpoints. The page-level reports
 * never include the full `lines[]` to avoid eager loading thousands of
 * entries on a trial balance.
 */
export type ReportSourceResponse = {
  account_number?: string
  account_name?: string
  ruta?: string
  customer_id?: string
  supplier_id?: string
  lines: ReportSourceLine[]
  next_cursor: string | null
}

/**
 * Loader state passed to subscribers. Mirrors the React hook output so the
 * pure (node-testable) loader can drive the same semantics as the hook.
 */
export interface SourceLoaderState {
  lines: ReportSourceLine[] | null
  loading: boolean
  error: string | null
}

/**
 * Pure-TS loader: encapsulates the fetch + cache + error semantics used by
 * the React hook in `components/reports/ReportRowExpansion`. Returning a
 * minimal subscription protocol keeps the React layer thin and testable.
 *
 * Repeated calls to `load()` after a successful fetch are no-ops, so toggling
 * a row open/closed never refetches.
 */
export function createSourceLoader(
  fetcher: ReportSourceFetcher,
  onChange: (state: SourceLoaderState) => void
) {
  let state: SourceLoaderState = { lines: null, loading: false, error: null }

  const emit = (next: Partial<SourceLoaderState>) => {
    state = { ...state, ...next }
    onChange(state)
  }

  return {
    getState: () => state,
    load: async () => {
      if (state.lines !== null || state.loading) return
      emit({ loading: true, error: null })
      try {
        const result = await fetcher()
        emit({ lines: result.lines, loading: false })
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Kunde inte hämta verifikat'
        emit({ error: message, loading: false })
      }
    },
  }
}
