import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ARRIVAL_WINDOW_DAYS, runArrivalMatch } from '@/lib/underlag/arrival-match'

/**
 * GET /api/extensions/invoice-inbox/arrival-match/cron: the daily pass over
 * every document still in the arrival window that nothing has claimed.
 *
 * The arrival hook and the bank-sync hook do the timely work; this is the
 * net under them: a worker that died mid-run, a company whose bank feed is
 * a file import that emits no sync event, a rate that resolved later. Runs
 * for every company, no allowlist: the matcher's own autonomy gate is what
 * keeps it from linking anything a counterparty has not earned.
 */
export const maxDuration = 300

export const GET = withCronContext('cron.invoice_inbox_arrival_match', async (_request, ctx) => {
  loadExtensions()
  if (!extensionRegistry.get('invoice-inbox')) {
    ctx.log.warn('invoice-inbox extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Invoice inbox extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabase = createServiceClientNoCookies()
  const since = new Date()
  since.setDate(since.getDate() - ARRIVAL_WINDOW_DAYS)

  const rows = await fetchAllRows<{ company_id: string }>((range) =>
    supabase
      .from('invoice_inbox_items')
      .select('company_id')
      .is('matched_transaction_id', null)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
      .not('document_id', 'is', null)
      .gte('created_at', since.toISOString())
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const companyIds = [...new Set(rows.map((r) => r.company_id))]

  const runId = `arrival-cron-${new Date().toISOString().slice(0, 10)}`
  // A failed company is counted and logged; the cause stays in the log, the
  // response only says that it failed.
  const results: Array<{ companyId: string; linked: number; proposed: number; skipped: number; failed: boolean }> = []
  for (const companyId of companyIds) {
    try {
      const s = await runArrivalMatch(supabase, companyId, { trigger: 'cron', runId })
      results.push({ companyId, linked: s.linked, proposed: s.proposed, skipped: s.skipped, failed: false })
    } catch (err) {
      results.push({ companyId, linked: 0, proposed: 0, skipped: 0, failed: true })
      ctx.log.error('arrival match cron failed for company', err as Error, { companyId })
    }
  }

  const summary = {
    companies: companyIds.length,
    linked: results.reduce((n, r) => n + r.linked, 0),
    proposed: results.reduce((n, r) => n + r.proposed, 0),
    skipped: results.reduce((n, r) => n + r.skipped, 0),
    failed: results.filter((r) => r.failed).length,
  }
  ctx.log.info('arrival match cron complete', summary)
  return NextResponse.json({ data: { ...summary, results } })
})
