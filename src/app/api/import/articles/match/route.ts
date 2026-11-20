import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ArticleImportMatchSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { matchArticleKeys } from '@/lib/import/articles/match'

export const maxDuration = 300

/**
 * POST /api/import/articles/match
 *
 * The article import reads its file in the browser (a supplier price list is
 * larger than any request or response the host carries) and asks here which
 * rows match an existing article: by article number, then by name, as the
 * parse route annotates and the execute route matches. Takes the keys only,
 * up to ARTICLE_MATCH_MAX_ROWS per call; answers one match or null per key,
 * in order. Writes nothing.
 */
export const POST = withRouteContext('register_import.articles.match', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const result = await validateBody(request, ArticleImportMatchSchema, {
    log,
    operation: 'register_import.articles.match',
  })
  if (!result.success) return result.response

  try {
    const { matches, duplicateCount } = await matchArticleKeys(supabase, companyId, result.data.rows)
    return NextResponse.json({ data: { matches, duplicate_count: duplicateCount } })
  } catch (err) {
    log.error('article import match failed', err as Error, { rowCount: result.data.rows.length })
    return errorResponseFromCode('REG_IMPORT_PARSE_FAILED', log, {
      requestId,
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    })
  }
})
