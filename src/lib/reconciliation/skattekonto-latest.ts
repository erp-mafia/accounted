/**
 * The skattekonto reconciliation summary persisted at every sync, so cheap
 * readers (the Hem notice, the attention resource) can say "the skattekonto
 * does not agree with the ledger by X" without recomputing the bridge on
 * every render. Written by the skatteverket extension's sync (which imports
 * this file: extensions may import core, never the other way around), read
 * from extension_data (extension_id 'skatteverket') by core.
 */

export const SKATTEKONTO_EXTENSION_ID = 'skatteverket'

/** extension_data key under which the sync stores the latest summary. */
export const SKATTEKONTO_RECONCILIATION_LATEST_KEY = 'skattekonto_reconciliation_latest'

/** extension_data key of the user's drift tolerance (SEK); mirrors the extension's setting. */
export const SKATTEKONTO_DRIFT_TOLERANCE_KEY = 'skattekonto_drift_tolerance'

/** Default tolerance when none is configured; mirrors the extension's DEFAULT_TOLERANCE_SEK. */
export const DEFAULT_SKATTEKONTO_TOLERANCE_SEK = 1

export interface SkattekontoReconciliationLatest {
  /** ISO timestamp of the saldo snapshot the summary was computed against. */
  as_of: string
  /** ISO timestamp the summary was computed (the sync run). */
  computed_at: string
  external_balance: number | null
  ledger_balance: number | null
  unexplained_difference: number | null
  counts: {
    proposed: number
    unmatched_external: number
    unmatched_ledger: number
  }
}

/**
 * Pure: the unexplained amount worth surfacing, or null when the skattekonto
 * agrees with the ledger (within tolerance), the summary is missing, or the
 * outside balance is unknown.
 */
export function skattekontoUnexplainedFrom(
  latest: SkattekontoReconciliationLatest | null | undefined,
  tolerance: number = DEFAULT_SKATTEKONTO_TOLERANCE_SEK,
): number | null {
  if (!latest || latest.unexplained_difference == null || latest.external_balance == null) return null
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : DEFAULT_SKATTEKONTO_TOLERANCE_SEK
  return Math.abs(latest.unexplained_difference) > tol ? latest.unexplained_difference : null
}
