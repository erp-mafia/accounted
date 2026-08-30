import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * End of the company's SIE-migration data coverage: the latest entry_date
 * among posted imported verifikat. Drives the quiet "från perioden före din
 * migrering" marker on inbox rows.
 *
 * Derived from journal_entries, NOT from sie_imports.fiscal_year_end: a SIE
 * file exported mid-year still declares the full fiscal year in #RAR 0, so
 * for a mid-year migrator fiscal_year_end is a FUTURE date and every new
 * bank transaction satisfied `date <= cutoff` until New Year (the 2026-08-30
 * user report). The imported vouchers themselves end where the old system's
 * data ends, which is the boundary the marker is about.
 *
 * Only the SIE importer creates source_type='import' entries, so the max is
 * exactly migration coverage. Series M is excluded because the importer's
 * omföringsverifikation (adjustment for skipped vouchers) is deliberately
 * dated at fiscal year end and would reintroduce the future-date bug. If a
 * company's SIE file genuinely uses series M its latest voucher may be
 * missed, which only narrows the marker, never future-dates it.
 *
 * Undo/replace of an import deletes or recreates these entries, so the
 * cutoff self-corrects with no stored state to maintain. Returns null when
 * the company has no completed migration: callers render no marker.
 */
export async function fetchMigrationCoverageEnd(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('journal_entries')
    .select('entry_date')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .eq('source_type', 'import')
    .neq('voucher_series', 'M')
    .order('entry_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { entry_date?: string } | null)?.entry_date ?? null
}
