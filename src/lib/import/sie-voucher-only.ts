import type { ParsedSIEFile } from './types'

/**
 * A verifikat-only SIE file (crm#1049).
 *
 * A card provider, payroll or POS system exports its own verifikat as a SIE
 * file with no balances at all (the SIE 4I shape: #VER, but no #IB, #UB or
 * #RES), meant to be added to books kept elsewhere. Over a year that already
 * holds an import, such a file is appended: only its vouchers the books do
 * not hold are added, as their own batch (sie-append.ts, issue #108). It never
 * replaces the year's import, which would drop every verifikat the file does
 * not carry: submitSIEJob refuses that at every door, and the wizard and
 * gnubok_sie_preflight offer only "Lägg till verifikationerna" for it.
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
