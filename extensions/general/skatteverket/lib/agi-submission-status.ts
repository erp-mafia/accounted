import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgiSubmissionState } from '@/lib/salary/agi-submission-state'

/**
 * The AGI submission record the run page renders, read from the two places
 * the receipt can live.
 *
 * `agi_submission_{period}` in extension_data is the in-flight cache: it
 * carries the underlag/signing-link states and, on the interactive
 * "Hämta kvittens" path, the signed receipt. The kvittens reconciliation
 * (agi-kvittens-reconcile.ts, driven by the kvittens cron and the
 * post-connect refresh) deliberately deletes that cache when it promotes the
 * declaration, so no stale "awaiting signature" view survives; it writes the
 * receipt to `agi_declarations` (kvittensnummer, submitted_at, response_data)
 * instead. Since the cron runs every 15 minutes while the panel only polls
 * three times after the signing link is created, that is the NORMAL outcome
 * for anyone who signs at an unhurried pace: without this fallback the
 * kvittensnummer, signatory and signing time are stored but never shown
 * (#1597). Together they form the verification chain for the filing
 * (BFL 5 kap 6§), so the panel must show them regardless of who fetched them.
 */

/** Columns the fallback reads from agi_declarations. */
export interface AgiDeclarationReceiptRow {
  salary_run_id?: string | null
  status: string
  kvittensnummer: string | null
  submitted_at: string | null
  response_data?: {
    signeradAv?: string | null
    signeradTid?: string | null
    submittedAtEstimated?: boolean | null
  } | null
}

/** Redovisningsperiod as the extension keys it: YYYYMM. */
const PERIOD_RE = /^\d{6}$/

/**
 * Parse the cached `agi_submission_{period}` value. The extension stores it
 * as a JSON string; a corrupt value reads as no record rather than a 500.
 */
export function parseCachedAgiSubmission(cached: unknown): AgiSubmissionState | null {
  if (!cached) return null
  if (typeof cached === 'object') return cached as AgiSubmissionState
  if (typeof cached !== 'string') return null
  try {
    const parsed = JSON.parse(cached) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as AgiSubmissionState) : null
  } catch {
    return null
  }
}

/**
 * Build a `signed` submission record from the agi_declarations row, or null
 * when the row carries no receipt (still generated / pending_signature).
 *
 * Deliberately no `salaryRunId`: regenerating the AGI for a correction
 * repoints the period's single row (UNIQUE per company+period) at the
 * correction run while the stored kvittens still belongs to the original.
 * Trusting the column would render the correction as filed with the
 * superseded receipt. Ownership is instead decided by
 * `resolveRunAgiSubmission` from `signeradTid` / `submittedAt` against the
 * run's own agi_submitted_at stamp (written from the same value) and from
 * `updatedAt` = the moment the receipt was recorded, which predates any
 * later correction's XML.
 */
export function agiSubmissionFromDeclaration(
  row: AgiDeclarationReceiptRow | null | undefined,
): AgiSubmissionState | null {
  if (!row?.kvittensnummer) return null
  if (row.status !== 'submitted' && row.status !== 'accepted') return null
  const response = row.response_data ?? null
  const signeradTid = response?.signeradTid ?? undefined
  const record: AgiSubmissionState = {
    status: 'signed',
    kvittensnummer: row.kvittensnummer,
    // signeradTid absent means the stamp is our reconciliation-time upper
    // bound, not Skatteverket's signing moment; the flag makes the panel say
    // so even for receipts recorded before the flag existed.
    submittedAtEstimated: response?.submittedAtEstimated === true || !signeradTid,
    source: 'declaration',
  }
  if (response?.signeradAv) record.signeradAv = response.signeradAv
  if (signeradTid) record.signeradTid = signeradTid
  if (row.submitted_at) {
    record.submittedAt = row.submitted_at
    record.updatedAt = row.submitted_at
  }
  return record
}

/**
 * The submission record for a period: the cache when present (it is the only
 * place the in-flight states live and, for the interactive path, the receipt
 * too), otherwise the receipt recorded on agi_declarations.
 */
export async function readAgiSubmissionStatus(
  supabase: SupabaseClient,
  companyId: string,
  period: string,
  cached: unknown,
): Promise<AgiSubmissionState | null> {
  const fromCache = parseCachedAgiSubmission(cached)
  if (fromCache) return { ...fromCache, source: 'cache' }
  if (!PERIOD_RE.test(period)) return null

  const { data } = await supabase
    .from('agi_declarations')
    .select('salary_run_id, status, kvittensnummer, submitted_at, response_data')
    .eq('company_id', companyId)
    .eq('period_year', parseInt(period.slice(0, 4), 10))
    .eq('period_month', parseInt(period.slice(4, 6), 10))
    .maybeSingle()

  return agiSubmissionFromDeclaration((data as AgiDeclarationReceiptRow | null) ?? null)
}
