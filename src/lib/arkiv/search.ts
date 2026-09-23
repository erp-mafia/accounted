import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { PREDICATES, predicateDef, type FactSubjectKind } from '@/lib/arkiv/facts/predicates'
import { searchDocumentPages } from '@/lib/documents/read/search'

/**
 * Arkiv phase 9c: one search over the record, shared by the page and the
 * agent tool. Documents are found by page text (best page first, with the
 * matching passage), agreements by title or counterparty, facts by value or
 * by the Swedish name of the predicate. Every hit carries a record_ref and,
 * where it was read from a page, the page: the person opens it, the agent
 * passes it to gnubok_get_record. Retrieval only; how a hit is titled for a
 * person is the route's job.
 */
export const SEARCH_KINDS = ['document', 'agreement', 'fact'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

export interface SearchItem {
  record_ref: string
  kind: SearchKind
  title: string
  snippet: string | null
  document_id: string | null
  page: number | null
}

export const SEARCH_QUERY_MIN = 2
export const SEARCH_QUERY_MAX = 200
export const SEARCH_LIMIT_DEFAULT = 10
export const SEARCH_LIMIT_MAX = 50

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && (SEARCH_KINDS as readonly string[]).includes(value)
}

/** The user's words as a LIKE pattern: wildcards in the query are plain spaces. */
export const likePattern = (query: string): string => `%${query.replace(/[%_]/g, ' ')}%`

export async function searchRecords(
  supabase: SupabaseClient,
  companyId: string,
  rawQuery: string,
  opts: { kinds?: readonly SearchKind[]; limit?: number } = {},
): Promise<SearchItem[]> {
  const query = rawQuery.trim()
  if (query.length < SEARCH_QUERY_MIN) throw new Error(`query must be at least ${SEARCH_QUERY_MIN} characters`)
  const kinds = new Set<SearchKind>(opts.kinds && opts.kinds.length ? opts.kinds : SEARCH_KINDS)
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? SEARCH_LIMIT_DEFAULT)))
  const like = likePattern(query)
  const items: SearchItem[] = []

  if (kinds.has('document')) {
    const hits = await searchDocumentPages(supabase, companyId, query, limit)
    for (const hit of hits) {
      items.push({ record_ref: `document:${hit.document_id}`, kind: 'document', title: hit.file_name, snippet: hit.headline, document_id: hit.document_id, page: hit.page_no })
    }
  }

  if (kinds.has('agreement')) {
    const { data, error } = await supabase
      .from('agreements')
      .select('id, title, counterparty_name, kind, ends_on')
      .eq('company_id', companyId)
      .or(`title.ilike.${like},counterparty_name.ilike.${like}`)
      .limit(limit)
    if (error) throw dbError(error)
    for (const a of (data ?? []) as Array<{ id: string; title: string; counterparty_name: string | null; kind: string; ends_on: string | null }>) {
      items.push({
        record_ref: `agreement:${a.id}`,
        kind: 'agreement',
        title: a.title,
        snippet: [a.kind, a.counterparty_name, a.ends_on ? `till ${a.ends_on}` : null].filter(Boolean).join(' · '),
        document_id: null,
        page: null,
      })
    }
  }

  if (kinds.has('fact')) {
    // "momsperiod" is the Swedish label of vat_period: a query that names a predicate the way people do finds its facts.
    const labelled = Object.values(PREDICATES)
      .filter((p) => p.label.toLowerCase().includes(query.toLowerCase()))
      .map((p) => p.predicate)
    const factFilter = labelled.length ? `value_text.ilike.${like},predicate.ilike.${like},predicate.in.(${labelled.join(',')})` : `value_text.ilike.${like},predicate.ilike.${like}`
    const { data, error } = await supabase
      .from('company_facts')
      .select('id, predicate, value_text, subject_kind, subject_id, source_document_id')
      .eq('company_id', companyId)
      .is('sys_to', null)
      .neq('rank', 'deprecated')
      .or(factFilter)
      .limit(limit)
    if (error) throw dbError(error)
    for (const f of (data ?? []) as Array<{ id: string; predicate: string; value_text: string; subject_kind: FactSubjectKind; subject_id: string; source_document_id: string | null }>) {
      items.push({
        record_ref: `fact:${f.id}`,
        kind: 'fact',
        title: `${predicateDef(f.predicate)?.label ?? f.predicate}: ${f.value_text}`,
        snippet: `${f.subject_kind}:${f.subject_id}`,
        document_id: f.source_document_id,
        page: null,
      })
    }
  }

  return items
}
