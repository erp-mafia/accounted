import type { SupabaseClient } from '@supabase/supabase-js'
import { precheckFiscalPeriod } from './sie-import'
import type { FiscalYearPrecheck } from './types'

/**
 * Whether an SIE import of a fiscal year will be admitted, read from the
 * database's own rule (crm#1272).
 *
 * start_sie_import_job refuses an import for what the year already holds.
 * The preflight used to test a copy of part of that rule (completed imports
 * whose year overlaps), so it answered ok for a year with an ingående balans
 * booked by hand, and the import was refused after approval. Both now read
 * sie_import_admission_refusal (migration 20261016221500), and the year the
 * import would use is resolved by precheckFiscalPeriod, the read-only half of
 * ensureFiscalPeriod: an ok here means the import is not refused for anything
 * these two can see. The database still decides at submit; state can change
 * in between.
 */

/** submitSIEJob's refusal when createFiscalPeriod is off and no year contains the file's dates. */
export const NO_MATCHING_FISCAL_YEAR = 'Inget matchande räkenskapsår hittades.'

export type SIEAdmissionRefusal =
  /** Another import of the company is not finished, or another run holds the year. */
  | { reason: 'unfinished_import'; importId: string | null }
  /** The year holds an import's verifikat, or an import record overlaps it. */
  | { reason: 'existing_import'; importId: string | null }
  /**
   * The year has an IB verifikat no import owns, and this import would book
   * the file's IB on top of it. Admitted with importOpeningBalances false.
   */
  | { reason: 'opening_balance'; entryId: string; voucher: string; entryDate: string; message: string }

export interface SIEAdmission {
  /** How the file's year relates to the company's years; conflict and invalid refuse. */
  fiscalYear: FiscalYearPrecheck
  /** Null when the year's content admits the import. */
  refusal: SIEAdmissionRefusal | null
}

interface RawRefusal {
  reason?: string
  import_id?: string | null
  entry_id?: string
  voucher?: string
  entry_date?: string
  message?: string
}

function toRefusal(raw: RawRefusal | null): SIEAdmissionRefusal | null {
  if (!raw?.reason) return null
  if (raw.reason === 'opening_balance') {
    return {
      reason: 'opening_balance',
      entryId: String(raw.entry_id ?? ''),
      voucher: String(raw.voucher ?? ''),
      entryDate: String(raw.entry_date ?? ''),
      message: String(raw.message ?? ''),
    }
  }
  if (raw.reason === 'unfinished_import' || raw.reason === 'existing_import') {
    return { reason: raw.reason, importId: raw.import_id ?? null }
  }
  // A reason this code does not know yet is still a refusal: answering ok
  // for it is the failure this module exists to prevent.
  return { reason: 'existing_import', importId: raw.import_id ?? null }
}

/**
 * The admission verdict for importing the year `fiscalYear` with these
 * options. Read-only. Throws when the rule cannot be read: a preflight that
 * answered ok on a failed read would repeat the bug it fixes.
 */
export async function checkSIEImportAdmission(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYear: { start: string; end: string },
  options: { importOpeningBalances: boolean; createFiscalPeriod?: boolean },
): Promise<SIEAdmission> {
  const precheck = await precheckFiscalPeriod(supabase, companyId, fiscalYear.start, fiscalYear.end)
  if (precheck.verdict === 'conflict' || precheck.verdict === 'invalid') {
    return { fiscalYear: precheck, refusal: null }
  }
  // Without createFiscalPeriod the import uses an existing year only
  // (submitSIEJob), and refuses when none contains the file's dates.
  if (precheck.verdict === 'create' && options.createFiscalPeriod === false) {
    return {
      fiscalYear: { verdict: 'invalid', message: NO_MATCHING_FISCAL_YEAR },
      refusal: null,
    }
  }
  const { data, error } = await supabase.rpc('sie_import_admission_refusal', {
    p_company_id: companyId,
    p_period_id: precheck.verdict === 'match' ? precheck.periodId : null,
    p_period_start: fiscalYear.start,
    p_period_end: fiscalYear.end,
    p_supersedes_import_id: null,
    p_import_opening_balances: options.importOpeningBalances,
  })
  if (error) throw new Error(`SIE admission check failed: ${error.message}`)
  return { fiscalYear: precheck, refusal: toRefusal(data as RawRefusal | null) }
}
