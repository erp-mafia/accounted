import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { UpdateArticleSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { checkRevenueAccount } from '@/lib/articles/validate-revenue-account'
import { AccountsNotInChartError, accountsNotInChartResponse } from '@/lib/bookkeeping/errors'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Article } from '@/types'

ensureInitialized()

export const GET = withRouteContext(
  'article.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ articleId: id })

    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('ARTICLE_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('article fetch failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    return NextResponse.json({ data })
  },
)

export const PATCH = withRouteContext(
  'article.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ articleId: id })

    const result = await validateBody(request, UpdateArticleSchema, {
      log: opLog,
      operation: 'article.update',
    })
    if (!result.success) return result.response
    const body = result.data

    // Same activate-and-retry contract as POST /api/articles: a class-3 account
    // that just isn't activated yet returns ACCOUNTS_NOT_IN_CHART.
    if (body.revenue_account) {
      const status = await checkRevenueAccount(supabase, companyId!, body.revenue_account)
      if (status === 'activatable') {
        return accountsNotInChartResponse(new AccountsNotInChartError([body.revenue_account]))
      }
      if (status === 'invalid') {
        return errorResponseFromCode('ARTICLE_REVENUE_ACCOUNT_INVALID', opLog, { requestId })
      }
    }

    // Sparse update: only the fields the caller actually sent.
    const updateData: Record<string, unknown> = {}
    for (const key of [
      'name', 'name_en', 'type', 'unit', 'price_excl_vat', 'vat_rate',
      'revenue_account', 'cost_price', 'ean', 'housework_type', 'notes',
      'article_number', 'active',
    ] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    const { data, error } = await supabase
      .from('articles')
      .update(updateData)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('ARTICLE_NOT_FOUND', opLog, { requestId })
      }
      if (error.code === '23505') {
        return errorResponseFromCode('ARTICLE_DUPLICATE_NUMBER', opLog, {
          requestId,
          details: { articleNumber: body.article_number },
        })
      }
      opLog.error('article update failed', error)
      return errorResponseFromCode('ARTICLE_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    await eventBus.emit({
      type: 'article.updated',
      payload: { article: data as Article, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

// DELETE soft-deactivates (active = false) rather than hard-deleting. Articles
// are master data referenced by historical invoice lines via a (frozen) copy;
// keeping the row preserves the register's audit trail and the article number.
// Re-activate by PATCHing { active: true }.
export const DELETE = withRouteContext(
  'article.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ articleId: id })

    const { data, error } = await supabase
      .from('articles')
      .update({ active: false })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('ARTICLE_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('article deactivate failed', error)
      return errorResponseFromCode('ARTICLE_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    await eventBus.emit({
      type: 'article.updated',
      payload: { article: data as Article, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
