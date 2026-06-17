import { NextResponse } from 'next/server'
import { parseArticlesFile } from '@/lib/import/articles/parser'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ArticleColumnOverridesSchema } from '@/lib/api/schemas'
import type {
  AnnotatedArticleRow,
  ArticleImportParseResult,
  DetectedArticleColumns,
} from '@/lib/import/articles/types'

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.ods']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** Lowercased dedup key for matching an article by name. */
function nameKey(value: string | null): string | null {
  if (!value) return null
  return value.trim().toLowerCase() || null
}

/**
 * POST /api/import/articles/parse
 *
 * Accepts an Excel/CSV file via FormData, auto-detects columns, parses rows,
 * and annotates each row with any duplicate-match against existing articles
 * (by article number first, then by name).
 */
export const POST = withRouteContext(
  'register_import.articles.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const columnOverridesRaw = formData.get('column_overrides') as string | null

    if (!file) {
      return errorResponseFromCode('REG_IMPORT_NO_FILE', log, { requestId })
    }

    if (file.size > MAX_FILE_SIZE) {
      return errorResponseFromCode('REG_IMPORT_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return errorResponseFromCode('REG_IMPORT_INVALID_FORMAT', log, {
        requestId,
        details: { extension: ext, allowed: ALLOWED_EXTENSIONS },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    let columnOverrides: DetectedArticleColumns | undefined
    if (columnOverridesRaw) {
      let raw: unknown
      try {
        raw = JSON.parse(columnOverridesRaw)
      } catch {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
      // Validate shape/indices before trusting it to drive the parser.
      const parsed = ArticleColumnOverridesSchema.safeParse(raw)
      if (!parsed.success) {
        return errorResponseFromCode('REG_IMPORT_INVALID_COLUMN_OVERRIDES', opLog, { requestId })
      }
      columnOverrides = parsed.data
    }

    try {
      const buffer = await file.arrayBuffer()
      const parsed = parseArticlesFile(buffer, file.name, columnOverrides)

      // Fetch existing articles for duplicate detection.
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
      const annotated: AnnotatedArticleRow[] = parsed.rows.map((r) => {
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

      const result: ArticleImportParseResult = {
        filename: parsed.filename,
        sheet_name: parsed.sheet_name,
        total_rows: annotated.length,
        detected_columns: parsed.detected_columns,
        headers: parsed.headers,
        preview_rows: parsed.preview_rows,
        rows: annotated,
        duplicate_count: duplicateCount,
        warnings: parsed.warnings,
      }

      return NextResponse.json({ data: result })
    } catch (err) {
      opLog.error('article import parse failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
