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
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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
        details: { reason: getUserErrorMessage(error) },
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

    // Same activate-and-retry contract as POST /api/articles: a class 1-3 account
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
      'currency', 'revenue_account', 'cost_price', 'ean', 'housework_type',
      'notes', 'article_number', 'active',
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
        details: { reason: getUserErrorMessage(error) },
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

// Articles are master data, while invoice lines hold frozen copies of the
// accounting values. An article may therefore be deleted only while no invoice
// line references it. The preflight also covers draft invoices.
export const DELETE = withRouteContext(
  'article.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ articleId: id })

    const { error: articleError } = await supabase
      .from('articles')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (articleError) {
      if (articleError.code === 'PGRST116') {
        return errorResponseFromCode('ARTICLE_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('article lookup before delete failed', articleError)
      return errorResponseFromCode('ARTICLE_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(articleError) },
      })
    }

    // invoice_items has NO company_id column: filtering on it made PostgREST
    // 42703 here, which the error branch below turned into ARTICLE_DELETE_FAILED
    // for EVERY delete (support: odinaero.se). Tenancy is already enforced by
    // the article lookup above: article_id is a UUID owned by this company.
    const { count: usageCount, error: usageError } = await supabase
      .from('invoice_items')
      .select('id', { count: 'exact', head: true })
      .eq('article_id', id)

    if (usageError) {
      opLog.error('article usage check failed', usageError)
      return errorResponseFromCode('ARTICLE_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(usageError) },
      })
    }

    if ((usageCount ?? 0) > 0) {
      return errorResponseFromCode('ARTICLE_IN_USE', opLog, { requestId })
    }

    const { error: deleteError, count: deletedCount } = await supabase
      .from('articles')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (deleteError) {
      if (deleteError.code === '23503') {
        return errorResponseFromCode('ARTICLE_IN_USE', opLog, { requestId })
      }
      opLog.error('article delete failed', deleteError)
      return errorResponseFromCode('ARTICLE_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(deleteError) },
      })
    }

    if (deletedCount === 0) {
      return errorResponseFromCode('ARTICLE_NOT_FOUND', opLog, { requestId })
    }

    await eventBus.emit({
      type: 'article.deleted',
      payload: { articleId: id, companyId, userId: user.id },
    })

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
