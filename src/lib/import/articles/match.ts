import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeNameKey as nameKey } from '@/lib/import/shared/column-utils'
import type { AnnotatedArticleRow } from './types'

/** What a file row is matched on: article number first, then name. */
export interface ArticleMatchKey {
  article_number: string | null
  name: string
}

export type ArticleDuplicateMatch = AnnotatedArticleRow['duplicate_match']

/**
 * The company's articles as a matcher: by article number first, then by
 * name (trimmed, case-insensitive). The review step's annotation and the
 * execute step match the same way, so what the review calls "matches an
 * existing article" is what the import then skips or updates.
 */
export async function loadArticleMatcher(
  supabase: SupabaseClient,
  companyId: string,
): Promise<(key: ArticleMatchKey) => ArticleDuplicateMatch> {
  const existing = await fetchAllRows<{ id: string; name: string; article_number: string | null }>(({ from, to }) =>
    supabase
      .from('articles')
      .select('id, name, article_number')
      .eq('company_id', companyId)
      .order('id')
      .range(from, to),
  )

  const byNumber = new Map<string, { id: string; name: string }>()
  const byName = new Map<string, { id: string; name: string }>()
  for (const a of existing) {
    if (a.article_number) byNumber.set(String(a.article_number), { id: a.id, name: a.name })
    const nk = nameKey(a.name)
    if (nk && !byName.has(nk)) byName.set(nk, { id: a.id, name: a.name })
  }

  return (key) => {
    if (key.article_number && byNumber.has(key.article_number)) {
      const e = byNumber.get(key.article_number)!
      return { article_id: e.id, matched_by: 'article_number', existing_name: e.name }
    }
    const nk = nameKey(key.name)
    if (nk && byName.has(nk)) {
      const e = byName.get(nk)!
      return { article_id: e.id, matched_by: 'name', existing_name: e.name }
    }
    return null
  }
}

/** Each key's match, in order, and how many matched. */
export async function matchArticleKeys(
  supabase: SupabaseClient,
  companyId: string,
  keys: readonly ArticleMatchKey[],
): Promise<{ matches: ArticleDuplicateMatch[]; duplicateCount: number }> {
  const match = await loadArticleMatcher(supabase, companyId)
  const matches = keys.map(match)
  return { matches, duplicateCount: matches.filter((m) => m !== null).length }
}
