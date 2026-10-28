import type { SupabaseClient } from '@supabase/supabase-js'
import { checkDuplicatePeriodImport } from './sie-import'
import type { ParsedSIEFile } from './types'

/**
 * A verifikat-only SIE file over a year that is already imported (crm#1049).
 *
 * A card provider, payroll or POS system exports its own verifikat as a SIE
 * file with no balances at all (the SIE 4I shape: #VER, but no #IB, #UB or
 * #RES), meant to be added to books kept elsewhere. The SIE import reads a
 * whole räkenskapsår, so such a file over a year that already holds an import
 * is either refused by the database ("ångra den tidigare importen", advice
 * that would throw away the year) or, with "ersätt", replaces the year's
 * import and with it every verifikat the file does not carry. The parse
 * route and gnubok_sie_preflight refuse such a file up front with a sentence
 * that says what to do today (book the file's verifikat as ordinary
 * verifikat), and submitSIEJob refuses it as a replacement at every door.
 * Adding the verifikat through the import is a follow-up (see the MR).
 */

/** The file carries verifikat and no balance of any kind. */
export function isVoucherOnlySIE(
  parsed: Pick<ParsedSIEFile, 'vouchers' | 'openingBalances' | 'closingBalances' | 'resultBalances'> &
    Partial<Pick<ParsedSIEFile, 'objectOpeningBalances' | 'objectClosingBalances'>>,
): boolean {
  return (
    parsed.vouchers.length > 0 &&
    parsed.openingBalances.length === 0 &&
    parsed.closingBalances.length === 0 &&
    parsed.resultBalances.length === 0 &&
    (parsed.objectOpeningBalances ?? []).length === 0 &&
    (parsed.objectClosingBalances ?? []).length === 0
  )
}

export interface VoucherOnlyFileRefusal {
  code: 'SIE_IMPORT_VOUCHERS_ONLY_FILE'
  details: {
    existing_import_id: string
    fiscal_year_start: string
    fiscal_year_end: string
    vouchers: number
  }
}

/**
 * The refusal for a verifikat-only file whose year already holds a completed
 * import, or null. Every other file, and a verifikat-only file for a year
 * with no import, is left to the existing rules.
 */
export async function voucherOnlyFileRefusal(
  supabase: SupabaseClient,
  companyId: string,
  parsed: ParsedSIEFile,
): Promise<VoucherOnlyFileRefusal | null> {
  const { fiscalYearStart, fiscalYearEnd } = parsed.stats
  if (!fiscalYearStart || !fiscalYearEnd || !isVoucherOnlySIE(parsed)) return null
  const existing = await checkDuplicatePeriodImport(supabase, companyId, fiscalYearStart, fiscalYearEnd)
  if (!existing) return null
  return {
    code: 'SIE_IMPORT_VOUCHERS_ONLY_FILE',
    details: {
      existing_import_id: existing.id,
      fiscal_year_start: fiscalYearStart,
      fiscal_year_end: fiscalYearEnd,
      vouchers: parsed.vouchers.length,
    },
  }
}
