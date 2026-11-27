import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isSpendConnectConfigured } from '@/lib/spend/connect-client'
import { syncSpendConnection, type SpendSyncResult } from '@/lib/spend/sync'

export const maxDuration = 300

/**
 * No page is read later than this into the run. One page can wait 65 s at
 * Connect (lib/spend/connect-client.ts), so the last one started still ends
 * well inside maxDuration; the check runs before every page, not only
 * between connections (lib/spend/sync.ts deadlineMs).
 */
const TIME_BUDGET_MS = 200_000
const BATCH = 200

/**
 * GET /api/spend/cron, every five minutes.
 *
 * Receives the waiting expenses of every active spend connection whose next
 * run is due (lib/spend/sync.ts), sends the coding vocabulary when it
 * changed, and answers each expense to the provider. A provider gives an
 * export an hour, so the cadence stays well inside it. Each connection is
 * leased for the run, so this and a person's "Hämta nu" never take the same
 * expenses at once. Nothing is booked.
 *
 * Without a connector key the capability does not exist on this
 * installation, and the run ends at once.
 */
export const GET = withCronContext('cron.spend', async (_request, ctx) => {
  if (!isSpendConnectConfigured()) {
    return NextResponse.json({ success: true, skipped: true, reason: 'no connector key' })
  }
  const supabase = createServiceClientNoCookies()
  const deadlineMs = ctx.startedAt + TIME_BUDGET_MS

  const { data, error } = await supabase
    .from('spend_connections')
    .select('id')
    .eq('status', 'active')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true })
    .limit(BATCH)
  if (error) throw new Error(`spend cron candidates failed: ${error.message}`)
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)

  const results: SpendSyncResult[] = []
  let deferred = 0
  const summary = await ctx.forEach('spend_connection', ids, async (connectionId, itemCtx) => {
    if (Date.now() >= deadlineMs) {
      deferred += 1
      return
    }
    results.push(await syncSpendConnection(supabase, connectionId, { log: itemCtx.log, deadlineMs }))
  })

  const received = results.reduce((sum, r) => sum + r.received, 0)
  const rejected = results.reduce((sum, r) => sum + r.rejected, 0)
  const failed = results.filter((r) => r.status === 'failed').length
  // Connections the budget stopped between two pages; they run again next tick.
  const stoppedEarly = results.filter((r) => r.stoppedEarly).length
  ctx.log.info('spend summary', { connections: ids.length, received, rejected, failed, deferred, stoppedEarly })
  return NextResponse.json({
    success: true,
    connections: ids.length,
    received,
    rejected,
    failed,
    deferred,
    stoppedEarly,
    errors: summary.failed,
  })
})
