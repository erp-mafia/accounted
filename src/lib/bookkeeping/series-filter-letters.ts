/**
 * The letters the verifikat list's series filter offers (crm#1680).
 *
 * The filter used to offer a fixed A-G, while a company's ledger can hold
 * any letter A-Z: an imported ledger keeps its own layout (J webshop, L lön,
 * M moms, N samlingsverifikat), and the standard set itself puts periodisering,
 * bokslut, lön and moms in H, I, K and M. The list API filters on one letter
 * A-Z (app/api/bookkeeping/journal-entries `series`), so this offers every
 * single-letter series the company has numbered vouchers in
 * (voucher_sequences), sorted. Other series shapes an import can carry
 * ('A_IM', '1') are left out: the API would ignore them and show every series.
 *
 * `used` null means the series could not be read: then every letter the API
 * accepts is offered rather than none. The active filter always stays an
 * option, so a selection never disappears from its own dropdown.
 */

import type { SupabaseDataClient } from '@/lib/supabase/data-client'

const SERIES_LETTER_RE = /^[A-Z]$/

export const ALL_SERIES_LETTERS: readonly string[] = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
)

export function seriesFilterLetters(
  used: Iterable<unknown> | null,
  active?: string | null,
): string[] {
  const letters = new Set<string>(used === null ? ALL_SERIES_LETTERS : [])
  const consider = (value: unknown) => {
    if (typeof value !== 'string') return
    const letter = value.trim()
    if (SERIES_LETTER_RE.test(letter)) letters.add(letter)
  }
  if (used !== null) for (const value of used) consider(value)
  consider(active)
  return Array.from(letters).sort()
}

/**
 * Every series the company has numbered vouchers in: one read of
 * voucher_sequences, a row per räkenskapsår and series (at most 125 rows per
 * company in production, far under a PostgREST page).
 */
export async function readSeriesInUse(supabase: SupabaseDataClient, companyId: string): Promise<Array<string | null>> {
  const { data, error } = await supabase
    .from('voucher_sequences')
    .select('voucher_series')
    .eq('company_id', companyId)
  if (error) throw error
  return ((data ?? []) as Array<{ voucher_series: string | null }>).map((row) => row.voucher_series)
}
