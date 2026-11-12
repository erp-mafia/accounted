import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isPosConnectConfigured } from '@/lib/pos-sales/connect-client'
import { syncPosConnection, type PosSyncResult } from '@/lib/pos-sales/sync'

export const maxDuration = 300

/**
 * No day is fetched later than this into the run. One day can wait 65 s at
 * Connect (lib/pos-sales/connect-client.ts), so the last one started still
 * ends well inside maxDuration. The check used to sit only between
 * connections, and one connection is up to six days: a connection started
 * at 199 s could run to 590 s.
 */
const TIME_BUDGET_MS = 200_000
const BATCH = 200

/**
 * GET /api/pos-sales/cron, hourly at :25.
 *
 * Fetches the closed business days of every active POS connection whose
 * next run is due (the morning after each day, catch-up runs hourly while
 * days are missing, backoff after failures; lib/pos-sales/sync.ts). Each
 * connection is leased for the run, so this and a person's "Hämta" never
 * call the provider for the same venue at once. Nothing is booked.
 *
 * Without a connector key the capability does not exist on this
 * installation, and the run ends at once.
 */
export const GET = withCronContext('cron.pos_sales', async (_request, ctx) => {
  if (!isPosConnectConfigured()) {
    return NextResponse.json({ success: true, skipped: true, reason: 'no connector key' })
  }
  const supabase = createServiceClientNoCookies()
  const deadlineMs = ctx.startedAt + TIME_BUDGET_MS

  const { data, error } = await supabase
    .from('pos_connections')
    .select('id')
    .eq('status', 'active')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true })
    .limit(BATCH)
  if (error) throw new Error(`pos cron candidates failed: ${error.message}`)
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)

  const results: PosSyncResult[] = []
  let deferred = 0
  const summary = await ctx.forEach('pos_connection', ids, async (connectionId, itemCtx) => {
    if (Date.now() >= deadlineMs) {
      deferred += 1
      return
    }
    results.push(await syncPosConnection(supabase, connectionId, { log: itemCtx.log, deadlineMs }))
  })

  const fetched = results.reduce((sum, r) => sum + r.fetched.length, 0)
  const failed = results.filter((r) => r.status === 'failed').length
  // Connections the budget stopped between two days; they run again next hour.
  const stoppedEarly = results.filter((r) => r.stoppedEarly).length
  ctx.log.info('pos sales summary', { connections: ids.length, fetched, failed, deferred, stoppedEarly })
  return NextResponse.json({
    success: true,
    connections: ids.length,
    fetched,
    failed,
    deferred,
    stoppedEarly,
    errors: summary.failed,
  })
})
