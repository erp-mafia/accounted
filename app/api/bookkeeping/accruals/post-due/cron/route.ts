import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { postDueInstallments } from '@/lib/bookkeeping/accruals/service'
import { firstOfMonth } from '@/lib/bookkeeping/accruals/compute'

ensureInitialized()

/**
 * GET /api/bookkeeping/accruals/post-due/cron, daily 05:15 UTC.
 *
 * Posts the monthly periodiseringsverifikat (source_type 'accrual') for every
 * pending installment whose calendar month has begun. Companies run in
 * isolated try/catch; one company's failure never blocks the rest. Per-
 * installment failures are recorded on the row (last_error) by the service
 * and retried on the next run: the periodiseringar page surfaces them.
 *
 * Idempotency: posting flips the installment pending→posted with a CAS
 * claim, so a cron retry (or a concurrent manual "Bokför förfallna") can
 * never double-book a month.
 */
export const GET = withCronContext('cron.accrual_postings', async (_request, ctx) => {
  const supabase = createServiceClient()
  const todayIso = new Date().toISOString().slice(0, 10)

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
      { success: false, error: error instanceof Error ? error.message : 'unknown' },
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

  const summary = await ctx.forEach('company', companyIds, async (companyId, itemCtx) => {
    const result = await postDueInstallments(supabase, companyId)
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

  ctx.log.info('accrual posting cron summary', {
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    posted: results.reduce((sum, r) => sum + r.posted, 0),
  })

  return NextResponse.json({
    success: true,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    failures: summary.failures,
    results,
  })
})

export const POST = GET
