import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from '@/lib/utils'

/** Ids per `.in()` filter: they travel in the query string (same bound as lib/portfolio and lib/clients). */
const IN_CLAUSE_CHUNK = 150

export interface CompanySettingsName {
  company_id: string
  company_name: string | null
}

/**
 * The display names (company_settings.company_name) of the given companies.
 *
 * The ids are named on purpose. Leaving them out and letting RLS do the
 * scoping returns the same rows and reads as the cheaper form; it is the
 * opposite. The policy qual (company_id IN user_company_ids()) becomes a
 * filter on the scan, never an index condition, so Postgres reads every
 * company's settings row to hand back the caller's own: on production
 * (2026-11-12) the dashboard layout's bare select scanned 3 768 rows for 24,
 * 1 080 buffers and 15 ms, on every dashboard render (100 278 calls since
 * 2026-09-11), and that grows with the number of companies. With the ids it is
 * one probe of company_settings_company_id_key per company.
 *
 * Naming the caller's membership ids cannot change the answer: the two SELECT
 * policies on company_settings admit user_company_ids() and
 * invoicer_company_ids(), which are the caller's own company_members rows, so
 * a company outside the membership list was never returned.
 *
 * A failed read contributes no names (the caller falls back to
 * companies.name), as the bare select did.
 */
export async function fetchCompanySettingsNames(
  supabase: SupabaseClient,
  companyIds: readonly string[],
): Promise<CompanySettingsName[]> {
  const ids = [...new Set(companyIds)]
  if (ids.length === 0) return []
  const pages = await Promise.all(
    chunk(ids, IN_CLAUSE_CHUNK).map(async (part) => {
      const { data } = await supabase
        .from('company_settings')
        .select('company_id, company_name')
        .in('company_id', part)
      return (data ?? []) as CompanySettingsName[]
    }),
  )
  return pages.flat()
}
