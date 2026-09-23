import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Page text search for people and agents alike. The function behind it
 * (search_document_pages, websearch_to_tsquery in Swedish) wants every word;
 * "Almi lån" finds nothing when the pages say "Almi" and "kredit". A query of
 * several words that finds nothing is retried with the words joined by "or",
 * so the reader gets the pages that mention any of them, best first.
 */
export interface PageHit {
  document_id: string
  page_no: number
  file_name: string
  headline: string | null
  rank: number
}

export async function searchDocumentPages(supabase: SupabaseClient, companyId: string, query: string, limit: number): Promise<PageHit[]> {
  const hits = await run(supabase, companyId, query, limit)
  if (hits.length > 0) return hits
  const words = query.split(/\s+/).filter((w) => w.length >= 2 && !/^(or|and|och|eller)$/i.test(w))
  if (words.length < 2) return hits
  return run(supabase, companyId, words.join(' or '), limit)
}

async function run(supabase: SupabaseClient, companyId: string, query: string, limit: number): Promise<PageHit[]> {
  const { data, error } = await supabase.rpc('search_document_pages', { p_company_id: companyId, p_query: query, p_limit: limit })
  if (error) throw new Error(`page search failed: ${error.message}`)
  return (data ?? []) as PageHit[]
}
