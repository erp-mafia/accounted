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
 * Armed only when a completed sie_imports row exists: source_type='import'
 * is accepted from API clients too (CreateJournalEntrySchema), so without
 * the gate a third-party backfill labeled 'import' would paint a false
 * pre-migration marker across a company that never migrated. With the gate,
 * such entries can still stretch a real migrator's cutoff, but a company
 * labeling API entries 'import' post-migration is doing exactly what the
 * label says.
 *
 * The importer's omföringsverifikation (skipped-voucher adjustment) is
 * excluded by its hardcoded description prefix: it is deliberately dated at
 * fiscal year end (sie-import.ts) and would reintroduce the future-date bug
 * for any import with skipped vouchers. Excluding by description rather
 * than by its 'M' voucher series keeps genuine series-M vouchers from the
 * source file in the max (prod has companies whose files use series M for
 * ordinary vouchers, e.g. moms). Known residual gap: bank movement covered
 * only by the omföring (skipped vouchers dated after the last cleanly
 * imported one) falls outside the cutoff; the duplicate-booking soft guard
 * remains the backstop there.
 *
 * Undo/replace of an import deletes or recreates these entries, so the
 * cutoff self-corrects with no stored state to maintain. Returns null when
 * the company has no completed migration: callers render no marker.
 */
export async function fetchMigrationCoverageEnd(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data: completedImport } = await supabase
    .from('sie_imports')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .limit(1)
    .maybeSingle()
  if (!completedImport) return null

  const { data } = await supabase
    .from('journal_entries')
    .select('entry_date')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .eq('source_type', 'import')
    .not('description', 'like', 'Omföringsverifikation:%')
    .order('entry_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { entry_date?: string } | null)?.entry_date ?? null
}
