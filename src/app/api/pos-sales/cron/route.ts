import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isPosConnectConfigured } from '@/lib/pos-sales/connect-client'
import { syncPosConnection, type PosSyncResult } from '@/lib/pos-sales/sync'

export const maxDuration = 300

/** Stop starting new connections this long into the run; one connection runs at most six provider calls. */
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
  const startedAt = Date.now()

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
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      deferred += 1
      return
    }
    results.push(await syncPosConnection(supabase, connectionId, { log: itemCtx.log }))
  })

  const fetched = results.reduce((sum, r) => sum + r.fetched.length, 0)
  const failed = results.filter((r) => r.status === 'failed').length
  ctx.log.info('pos sales summary', { connections: ids.length, fetched, failed, deferred })
  return NextResponse.json({
    success: true,
    connections: ids.length,
    fetched,
    failed,
    deferred,
    errors: summary.failed,
  })
})
