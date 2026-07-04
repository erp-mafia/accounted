import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateArticleSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { ensureArticleNumber } from '@/lib/articles/ensure-article-number'
import { checkRevenueAccount } from '@/lib/articles/validate-revenue-account'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Article } from '@/types'

ensureInitialized()

// GET /api/articles: list the active company's articles. `?include_inactive=1`
// returns soft-deactivated ones too (the register page can show an archive view).
export const GET = withRouteContext(
  'article.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === '1'

    let query = supabase
      .from('articles')
      .select('*')
      .eq('company_id', companyId)
    if (!includeInactive) query = query.eq('active', true)

    const { data, error } = await query.order('name', { ascending: true })

    if (error) {
      log.error('article list failed', error)
      return errorResponse(error, log, { requestId })
    }

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

    // Guard the optional revenue-account override against the chart of accounts.
    // A class-3 account that merely isn't activated yet gets the standard
    // ACCOUNTS_NOT_IN_CHART envelope so the client can offer activate-and-retry.
    if (body.revenue_account) {
      const status = await checkRevenueAccount(supabase, companyId!, body.revenue_account)
      if (status === 'activatable') {
        return accountsNotInChartResponse(new AccountsNotInChartError([body.revenue_account]))
      }
      if (status === 'invalid') {
        return errorResponseFromCode('ARTICLE_REVENUE_ACCOUNT_INVALID', log, { requestId })
      }
    }

    const { data, error } = await supabase
      .from('articles')
      .insert({
        user_id: user.id,
        company_id: companyId,
        name: body.name,
        name_en: body.name_en ?? null,
        type: body.type ?? 'tjanst',
        unit: body.unit ?? 'st',
        price_excl_vat: body.price_excl_vat,
        vat_rate: body.vat_rate ?? 25,
        revenue_account: body.revenue_account ?? null,
        cost_price: body.cost_price ?? null,
        ean: body.ean ?? null,
        housework_type: body.housework_type ?? null,
        notes: body.notes ?? null,
        article_number: body.article_number ?? null,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('ARTICLE_DUPLICATE_NUMBER', log, {
          requestId,
          details: { articleNumber: body.article_number },
        })
      }
      log.error('article insert failed', error)
      return errorResponseFromCode('ARTICLE_CREATE_FAILED', log, {
        requestId,
        details: { reason: error.message },
      })
    }

    // Auto-number when the caller didn't supply one. Non-fatal: an unnumbered
    // article is still usable and can be numbered later.
    if (!data.article_number) {
      try {
        data.article_number = await ensureArticleNumber(supabase, companyId!, data.id)
      } catch (err) {
        log.warn('article number assignment failed', err as Error, { articleId: data.id })
      }
    }

    await eventBus.emit({
      type: 'article.created',
      payload: { article: data as Article, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
