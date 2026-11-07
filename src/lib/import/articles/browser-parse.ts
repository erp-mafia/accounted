import {
  ARTICLE_MATCH_MAX_ROWS,
  type AnnotatedArticleRow,
  type ArticleImportParseResult,
  type DetectedArticleColumns,
} from './types'

/**
 * The largest article file the browser reads. A supplier price list of
 * 165 000 rows (crm#1383) is a few MB to some tens of MB as xlsx or CSV;
 * beyond this the tab itself struggles to hold the workbook.
 */
export const ARTICLE_BROWSER_MAX_FILE_BYTES = 50 * 1024 * 1024

export type ArticleBrowserParseOutcome =
  | { ok: true; result: ArticleImportParseResult }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'match_failed'; message: string | null }

/**
 * The article import's parse step, run in the browser. A price list is
 * larger than the 4.5 MB the hosted platform carries in a request, and its
 * parsed rows larger than it carries in a response, so the file never goes
 * to the server: the same parser as POST /api/import/articles/parse reads it
 * here, and only the match keys (article number, name) go to POST
 * /api/import/articles/match, in batches of ARTICLE_MATCH_MAX_ROWS. The
 * answer has the parse route's shape, so the review step is the same.
 */
export async function parseArticleFileInBrowser(
  file: File,
  overrides?: DetectedArticleColumns,
  fetchImpl: typeof fetch = fetch,
): Promise<ArticleBrowserParseOutcome> {
  if (file.size > ARTICLE_BROWSER_MAX_FILE_BYTES) return { ok: false, reason: 'too_large' }

  const { parseArticlesFile } = await import('./parser')
  const parsed = await parseArticlesFile(await file.arrayBuffer(), file.name, overrides)

  const matches: AnnotatedArticleRow['duplicate_match'][] = []
  let duplicateCount = 0
  for (let i = 0; i < parsed.rows.length; i += ARTICLE_MATCH_MAX_ROWS) {
    const keys = parsed.rows
      .slice(i, i + ARTICLE_MATCH_MAX_ROWS)
      .map((r) => ({ article_number: r.article_number, name: r.name }))
    const res = await fetchImpl('/api/import/articles/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: keys }),
    })
    // A platform error (413, 504) answers in plain text, not JSON.
    const body = (await res.json().catch(() => null)) as
      | { data?: { matches: AnnotatedArticleRow['duplicate_match'][]; duplicate_count: number }; error?: { message_sv?: string } }
      | null
    if (!res.ok || !body?.data) {
      return { ok: false, reason: 'match_failed', message: body?.error?.message_sv ?? null }
    }
    matches.push(...body.data.matches)
    duplicateCount += body.data.duplicate_count
  }

  const rows: AnnotatedArticleRow[] = parsed.rows.map((r, i) => ({ ...r, duplicate_match: matches[i] ?? null }))
  return {
    ok: true,
    result: {
      filename: parsed.filename,
      sheet_name: parsed.sheet_name,
      total_rows: rows.length,
      detected_columns: parsed.detected_columns,
      headers: parsed.headers,
      preview_rows: parsed.preview_rows,
      rows,
      duplicate_count: duplicateCount,
      warnings: parsed.warnings,
    },
  }
}
