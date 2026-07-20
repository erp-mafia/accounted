/**
 * Month-end close run (granskningskö): month-scoped readiness checks over a
 * company's ledger, the precursor to locking the month via
 * company_settings.bookkeeping_locked_through. Spec: dev_docs/niche_factory.md
 * §0 (workflows plane) + dev_docs/agent_first_vision.md §5 (flow-run).
 */

export type MonthEndCheckKey =
  | 'unbooked_transactions'
  | 'unattested_supplier_invoices'
  | 'bank_unreconciled'
  | 'draft_entries'
  | 'missing_receipts_high_value'

/**
 * 'unknown' = the check itself failed to run. Readiness fails CLOSED: an
 * unknown check blocks the month lock exactly like a blocker, because "we
 * could not verify" must never render as "verified".
 */
export type MonthEndCheckStatus = 'pass' | 'blocker' | 'warning' | 'unknown'

export interface MonthEndCheck {
  key: MonthEndCheckKey
  status: MonthEndCheckStatus
  /** Offending-item count where meaningful; null when the check errored. */
  count: number | null
  /** Numeric context (e.g. reconciliation difference in SEK). */
  amount?: number
}

export interface MonthEndReadinessReport {
  companyId: string
  /** ISO year-month, e.g. "2026-06". */
  month: string
  /** Inclusive ISO date range covering the month. */
  start: string
  end: string
  /** company_settings.bookkeeping_locked_through at read time. */
  lockedThrough: string | null
  /** True when the month is already behind the company lock date. */
  alreadyLocked: boolean
  checks: MonthEndCheck[]
  /** True when no check is a blocker or unknown (warnings do not block). */
  ready: boolean
}
