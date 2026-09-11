import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { resolveCompanyCounterparts, resolverMode, type RunSummary } from '@/lib/parties/resolver/run'

ensureInitialized()

/**
 * GET /api/parties/resolver/cron, daily 05:45 UTC.
 *
 * Names the counterpart behind every new bank string, per company, after the
 * 05:00 bank sync and before people open the app. Writes only alias rows, a
 * display-time overlay; nothing in the ledger or the transactions changes.
 * COUNTERPARTY_RESOLVER_MODE=off is the kill switch.
 */
const ACTIVE_WINDOW_DAYS = 30

export const GET = withCronContext('cron.counterparty_resolver', async (_request, ctx) => {
  if (resolverMode() === 'off') {
    ctx.log.info('counterparty resolver skipped: mode off')
    return NextResponse.json({ success: true, skipped: true, reason: 'COUNTERPARTY_RESOLVER_MODE=off', total: 0 })
  }

  const supabase = createServiceClient()
  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400e3).toISOString().slice(0, 10)
  const { data, error } = await supabase.from('transactions').select('company_id').gte('date', since).limit(50000)
  if (error) {
    ctx.log.error('counterparty resolver could not list active companies', new Error(error.message))
    return NextResponse.json({ success: false, failed: true, total: 0 }, { status: 500 })
  }
  const companyIds = [...new Set((data ?? []).map((r) => (r as { company_id: string | null }).company_id).filter((id): id is string => !!id))]

  const results: RunSummary[] = []
  const summary = await ctx.forEach('company', companyIds, async (companyId, itemCtx) => {
    try {
      results.push(await resolveCompanyCounterparts(supabase, companyId))
    } catch (err) {
      itemCtx.log.error('counterparty resolver failed for company', err as Error, { companyId })
      throw err
    }
  })

  const totals = results.reduce(
    (acc, r) => ({
      strings: acc.strings + r.strings,
      planned: acc.planned + r.planned,
      written: acc.written + r.written,
      modelLines: acc.modelLines + r.modelLines,
      promoted: acc.promoted + r.promoted,
    }),
    { strings: 0, planned: 0, written: 0, modelLines: 0, promoted: 0 },
  )
  ctx.log.info('counterparty resolver summary', { total: summary.total, succeeded: summary.succeeded, failed: summary.failed, ...totals })
  return NextResponse.json({ success: true, total: summary.total, succeeded: summary.succeeded, failed: summary.failed, ...totals })
})
