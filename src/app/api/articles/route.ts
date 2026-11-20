import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateArticleSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createArticle } from '@/lib/articles/article-commands'
import { articleRefusalResponse } from '@/lib/articles/article-refusal-response'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// GET /api/articles: list the active company's articles. `?include_inactive=1`
// returns soft-deactivated ones too (the register page can show an archive view).
export const GET = withRouteContext(
  'article.list',
  async (request, ctx) => {
    const { supabase, companyId } = ctx

    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1'

    // Article registers can exceed PostgREST's silent 1000-row cap (imported
    // product catalogs), so paginate. The secondary order on id gives the
    // stable total order .range() paging requires - name alone is not unique.
    // Errors thrown here surface via the wrapper's canonical envelope.
    const data = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('articles')
        .select('*')
        .eq('company_id', companyId)
      if (!includeInactive) query = query.eq('active', true)
      return query
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    })

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'article.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CreateArticleSchema, {
      log,
      operation: 'article.create',
    })
    if (!result.success) return result.response
    const body = result.data

    // The one create path (lib/articles/article-commands.ts), shared with the
    // approval of an agent's staged gnubok_create_article.
    const outcome = await createArticle({ supabase, companyId: companyId!, userId: user.id, log }, body)
    if (!outcome.ok) return articleRefusalResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('article.create: unexpected dry-run outcome')
    const data = outcome.data

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
