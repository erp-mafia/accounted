import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/search?q=<text>&limit=<n>
 * Full-text search over the company's document page text (Arkiv phase 1).
 * Returns hits ordered by rank with a highlighted snippet per page.
 */
const querySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = withRouteContext('document.search', async (request, ctx) => {
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { q, limit } = parsed.data

  const { data, error } = await ctx.supabase.rpc('search_document_pages', {
    p_company_id: ctx.companyId,
    p_query: q,
    p_limit: limit,
  })
  if (error) {
    ctx.log.error('document search failed', { reason: error.message })
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
  return NextResponse.json({ data: data ?? [] })
})
