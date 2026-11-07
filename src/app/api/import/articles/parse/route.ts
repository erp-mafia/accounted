import { parseArticlesFile } from '@/lib/import/articles/parser'
import { registerParseRoute } from '@/lib/import/shared/register-parse-route'
import { ArticleColumnOverridesSchema } from '@/lib/api/schemas'
import type { AnnotatedArticleRow, DetectedArticleColumns, ParsedArticleRow } from '@/lib/import/articles/types'
import { matchArticleKeys } from '@/lib/import/articles/match'

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
    const { matches, duplicateCount } = await matchArticleKeys(supabase, companyId, rows)
    const annotated: AnnotatedArticleRow[] = rows.map((r, i) => ({ ...r, duplicate_match: matches[i] }))
    return { rows: annotated, duplicateCount }
  },
})
