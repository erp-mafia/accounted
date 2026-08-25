/**
 * Defaults for the SIE-import opening-balance (Ingående balanser) voucher.
 *
 * Pure module: imported by both the import engine (server) and the import
 * wizard (client), so it must stay free of Supabase/engine dependencies.
 *
 * Issue #1882: the IB voucher used to be hardcoded to series A and created
 * BEFORE the file's vouchers, so it consumed the A series' next number and
 * shifted every A voucher one number higher than in the source system. The
 * default series must therefore never collide with the series the file's
 * own vouchers use.
 */

/**
 * Default series for the IB voucher. 'M' matches the series the import
 * engine already uses for its other system voucher (the migration
 * adjustment / omföringsverifikation in sie-import.ts) and is not part of
 * the common Swedish source-system conventions (A huvudserie, B automat,
 * F kundfakturor, I inbetalningar, J bokslut, L leverantörsfakturor,
 * N löner, U utbetalningar).
 */
export const DEFAULT_OPENING_BALANCE_SERIES = 'M'

/**
 * Candidate series tried in order when the file's own vouchers already use
 * the preferred default. Letters with a conventional meaning in Swedish
 * bookkeeping (A, B, F, I, J, L, N, U) are deliberately excluded so the IB
 * voucher never lands in a series a migrated company recognizes as
 * something else.
 */
const SERIES_CANDIDATES = ['M', 'O', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'X', 'Y', 'Z'] as const

/**
 * Pick the default IB-voucher series: the first candidate not used by the
 * file's own vouchers. Falls back to 'M' in the (practically impossible)
 * case where a file uses every candidate; the user can still override in
 * the wizard.
 */
export function defaultOpeningBalanceSeries(seriesInFile: Iterable<string>): string {
  const used = new Set<string>()
  for (const s of seriesInFile) {
    const normalized = typeof s === 'string' ? s.trim().toUpperCase() : ''
    if (normalized) used.add(normalized)
  }
  for (const candidate of SERIES_CANDIDATES) {
    if (!used.has(candidate)) return candidate
  }
  return DEFAULT_OPENING_BALANCE_SERIES
}

/**
 * Smart default for the wizard's "Importera ingående balanser" toggle.
 * OFF when the file carries no IB, and OFF on re-import when the fiscal
 * year already has a posted opening-balance voucher: importing again would
 * create a duplicate "Ingående balanser" verifikat (the field report behind
 * issue #1882 had five accumulated ones).
 */
export function defaultImportOpeningBalancesOn(args: {
  hasOpeningBalances: boolean
  existingIbEntryCount: number
}): boolean {
  return args.hasOpeningBalances && args.existingIbEntryCount === 0
}
