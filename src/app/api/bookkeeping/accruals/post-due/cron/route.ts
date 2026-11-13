import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { cancelAbandonedAccrualDrafts, postDueInstallments } from '@/lib/bookkeeping/accruals/service'
import { firstOfMonth } from '@/lib/bookkeeping/accruals/compute'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * GET /api/bookkeeping/accruals/post-due/cron, daily 05:15 UTC.
 *
 * Posts the monthly periodiseringsverifikat (source_type 'accrual') for every
 * pending installment whose calendar month has begun. Companies run in
 * isolated try/catch; one company's failure never blocks the rest. Per-
 * installment failures are recorded on the row (last_error) by the service
 * and retried on the next run: the periodiseringar page surfaces them.
 *
 * Idempotency: a month's verifikat and its pending→posted are one database
 * transaction (commit_accrual_installment), so a retry, an overlapping run or
 * a concurrent manual "Bokför förfallna" posts a month once, and a run that
 * is killed leaves each month either posted or still pending.
 *
 * Time: the run stops starting months RUN_BUDGET_MS in, well inside the
 * function limit (300 s, the platform default; this route sets none), since
 * one month is a handful of database calls. Months not reached stay pending
 * and are posted by the next run; the count is logged as an error so a run
 * that keeps falling behind is seen.
 *
 * First, the drafts killed runs left behind (no voucher number, older than
 * half an hour) are cancelled, in every company whether or not it has a
 * month due today (cancelAbandonedAccrualDrafts). A failure there is logged
 * and the posting goes on.
 */
const RUN_BUDGET_MS = 240_000

export const GET = withCronContext('cron.accrual_postings', async (_request, ctx) => {
  const supabase = createServiceClient()
  const todayIso = todayIsoStockholm()

  let abandonedDrafts = { cancelled: 0, failed: 0, locked: 0 }
  try {
    abandonedDrafts = await cancelAbandonedAccrualDrafts(supabase)
  } catch (error) {
    ctx.log.error('abandoned accrual drafts not looked for; the posting goes on', error as Error)
  }

  // fetchAllRows pages past PostgREST's 1000-row cap: a single unpaginated
  // select would silently drop companies once total due installments exceed
  // the cap, permanently starving the ones sorted last.
  let rows: Array<{ company_id: string }>
  try {
    rows = await fetchAllRows<{ company_id: string }>(({ from, to }) =>
      supabase
        .from('accrual_schedule_installments')
        .select('company_id')
        .eq('status', 'pending')
        .lte('period_month', firstOfMonth(todayIso))
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (error) {
    ctx.log.error('failed to load due accrual installments', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? getUserErrorMessage(error) : 'unknown' },
      { status: 500 },
    )
  }

  const companyIds = Array.from(new Set(rows.map((row) => row.company_id)))

  ctx.log.info('accrual posting cron starting', {
    companyCount: companyIds.length,
    todayIso,
  })

  const results: Array<{
    companyId: string
    posted: number
    failed: number
    skipped: number
  }> = []

  const deadline = ctx.startedAt + RUN_BUDGET_MS
  let companiesNotReached = 0
  let monthsDeferred = 0

  const summary = await ctx.forEach('company', companyIds, async (companyId, itemCtx) => {
    if (Date.now() >= deadline) {
      companiesNotReached++
      return
    }
    const result = await postDueInstallments(supabase, companyId, { deadline })
    monthsDeferred += result.deferred ?? 0
    results.push({
      companyId,
      posted: result.posted,
      failed: result.failed,
      skipped: result.skipped,
    })
    if (result.failed > 0) {
      itemCtx.log.warn('some accrual installments failed to post', {
        companyId,
        failed: result.failed,
      })
    }
  })

  if (companiesNotReached > 0 || monthsDeferred > 0) {
    ctx.log.error(
      'accrual posting stopped at its time budget; the months left stay pending for the next run',
      new Error('accrual posting run out of time'),
      { companiesNotReached, monthsDeferred, companyCount: companyIds.length },
    )
  }

  ctx.log.info('accrual posting cron summary', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    posted: results.reduce((sum, r) => sum + r.posted, 0),
  })

  return NextResponse.json({
    success: true,
    total: summary.total,
    succeeded: summary.succeeded - companiesNotReached,
    failed: summary.failed,
    not_reached: companiesNotReached,
    months_deferred: monthsDeferred,
    abandoned_drafts_cancelled: abandonedDrafts.cancelled,
    failures: summary.failures,
    results,
  })
})

export const POST = GET
