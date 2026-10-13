import { parseArticlesFile } from '@/lib/import/articles/parser'
import { registerParseRoute } from '@/lib/import/shared/register-parse-route'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ArticleColumnOverridesSchema } from '@/lib/api/schemas'
import type { AnnotatedArticleRow, DetectedArticleColumns, ParsedArticleRow } from '@/lib/import/articles/types'
import { normalizeNameKey as nameKey } from '@/lib/import/shared/column-utils'

/**
 * POST /api/import/articles/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses rows,
 * and annotates each row with any duplicate-match against existing articles
 * (by article number first, then by name).
 */
export const POST = registerParseRoute<DetectedArticleColumns, ParsedArticleRow, AnnotatedArticleRow>({
  operation: 'register_import.articles.parse',
  register: 'article',
  parse: parseArticlesFile,
  // Validate shape/indices before trusting it to drive the parser.
  validateOverrides: (raw) => {
    const parsed = ArticleColumnOverridesSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  },
  async annotate(supabase, companyId, rows) {
    const existing = await fetchAllRows(({ from, to }) =>
      supabase
        .from('articles')
        .select('id, name, article_number')
        .eq('company_id', companyId)
        .range(from, to),
    )

    const byNumber = new Map<string, { id: string; name: string }>()
    const byName = new Map<string, { id: string; name: string }>()
    for (const a of existing) {
      if (a.article_number) byNumber.set(String(a.article_number), { id: a.id, name: a.name })
      const nk = nameKey(a.name)
      if (nk && !byName.has(nk)) byName.set(nk, { id: a.id, name: a.name })
    }

    let duplicateCount = 0
    const annotated: AnnotatedArticleRow[] = rows.map((r) => {
      let match: AnnotatedArticleRow['duplicate_match'] = null
      if (r.article_number && byNumber.has(r.article_number)) {
        const e = byNumber.get(r.article_number)!
        match = { article_id: e.id, matched_by: 'article_number', existing_name: e.name }
      } else {
        const nk = nameKey(r.name)
        if (nk && byName.has(nk)) {
          const e = byName.get(nk)!
          match = { article_id: e.id, matched_by: 'name', existing_name: e.name }
        }
      }
      if (match) duplicateCount++
      return { ...r, duplicate_match: match }
    })
    return { rows: annotated, duplicateCount }
  },
})
