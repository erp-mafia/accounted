import type { SupabaseDataClient } from '@/lib/supabase/data-client'

/**
 * End of the company's SIE-migration data coverage: the latest entry_date
 * among posted imported verifikat.
 *
 * Derived from journal_entries, not sie_imports.fiscal_year_end: a mid-year
 * file still declares the whole fiscal year. Armed only by a completed import,
 * since API clients can mark their own entries as imports. The importer's
 * omföringsverifikation is excluded: its fiscal-year-end date says nothing
 * about how far the source ledger reached.
 */
export async function fetchMigrationCoverageEnd(
  supabase: SupabaseDataClient,
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
