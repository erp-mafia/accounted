/**
 * When the verifikat list comes back empty, does it need the all-years
 * "does this ledger hold any committed entry" probe?
 *
 * The probe's only reader is the pristine start card ("no verifikat yet"),
 * and that card renders only with no search and no dialog filter (series,
 * date range, missing underlag) active. With any of those set, the probe's
 * answer cannot change what renders, yet the empty state waited for it, and
 * on a ten-year ledger that all-years read took seconds (crm#1390: the
 * "Verifikat utan underlag" view with nothing missing sat on a spinner).
 *
 * Kept framework-free so it is unit-tested (component code is outside the
 * lib/ + app/api/ test scope).
 */

export interface EmptyListScope {
  periodId: string | null
  search: string
  seriesFilter: string
  dateFrom: string
  dateTo: string
  showMissingOnly: boolean
}

/**
 * - `from_total`: nothing narrows the list, so its own total (0) already
 *   answers the question; no request.
 * - `probe`: only the fiscal-year scope narrows it; ask across all years.
 * - `skip`: a search or a dialog filter is active, so the pristine card
 *   cannot render whatever the answer; no request.
 */
export type LedgerProbePlan = 'from_total' | 'probe' | 'skip'

export function planLedgerProbe(scope: EmptyListScope): LedgerProbePlan {
  const pristineCardPossible =
    !scope.search &&
    scope.seriesFilter === 'all' &&
    !scope.dateFrom &&
    !scope.dateTo &&
    !scope.showMissingOnly
  if (!pristineCardPossible) return 'skip'
  return scope.periodId ? 'probe' : 'from_total'
}
