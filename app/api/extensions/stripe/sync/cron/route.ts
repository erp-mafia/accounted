import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { syncStripeConnection } from '@/extensions/general/stripe/lib/sync'
import type { StripeConnection } from '@/extensions/general/stripe/types'

// settleInvoicePayment emits invoice.paid; the Stripe extension's own
// link-deactivation handler (and webhook fan-out) must be wired before the
// first emit on a cold instance.
ensureInitialized()

export const maxDuration = 300

/**
 * GET /api/extensions/stripe/sync/cron
 * Polls each active Stripe connection's event stream every 15 minutes and
 * applies checkout payments to invoices (deterministic match, 1686 clearing).
 *
 * Processes up to 50 connections per run, oldest-synced first. Idempotent:
 * event claims are unique per (connection, event), so overlapping windows and
 * re-runs are no-ops.
 */
export const GET = withCronContext('cron.stripe_sync', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_CONNECT_CLIENT_ID) {
    return NextResponse.json({ message: 'Stripe Connect not configured', processed: 0 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: connections, error: connError } = await supabase
    .from('stripe_connections')
    .select('*')
    .eq('status', 'active')
    .order('last_event_created_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (connError) {
    ctx.log.error('failed to fetch stripe connections', connError, {
      message: connError.message,
      code: connError.code,
    })
    return errorResponse(connError, ctx.log, { requestId: ctx.requestId })
  }

  if (!connections || connections.length === 0) {
    return NextResponse.json({ message: 'No active connections to sync', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 240_000 // leave a minute of margin inside maxDuration
  // Absolute deadline shared with syncStripeConnection so a single
  // connection's event batch cannot blow the budget on its own: the sync
  // stops between events and persists its cursor up to what it processed.
  const deadlineMs = startTime + TIME_BUDGET_MS

  const results: Array<{
    connectionId: string
    settled: number
    needsReview: number
    ignored: number
    status: 'synced' | 'revoked' | 'error'
  }> = []

  for (const connection of connections as StripeConnection[]) {
    if (Date.now() >= deadlineMs) {
      ctx.log.info('time budget reached', { processedSoFar: results.length })
      break
    }

    if (!(await hasCapability(supabase, connection.company_id, CAPABILITY.stripe_payments))) {
      ctx.log.info('skip: capability not entitled', { companyId: connection.company_id })
      continue
    }

    try {
      const summary = await syncStripeConnection(supabase, connection, ctx.log, deadlineMs)
      if (summary.deadlineReached) {
        ctx.log.info('connection stopped early on time budget; remaining events resume next run', {
          connectionId: connection.id,
        })
      }
      results.push({
        connectionId: connection.id,
        settled: summary.settled,
        needsReview: summary.needsReview,
        ignored: summary.ignored,
        status: summary.revoked ? 'revoked' : 'synced',
      })
    } catch (error) {
      ctx.log.error('stripe sync failed for connection', error as Error, {
        connectionId: connection.id,
        companyId: connection.company_id,
      })
      await supabase
        .from('stripe_connections')
        .update({ error_message: 'Synkroniseringen misslyckades. Försöker igen automatiskt.' })
        .eq('id', connection.id)
      results.push({
        connectionId: connection.id,
        settled: 0,
        needsReview: 0,
        ignored: 0,
        status: 'error',
      })
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      settled: acc.settled + r.settled,
      needsReview: acc.needsReview + r.needsReview,
    }),
    { settled: 0, needsReview: 0 },
  )
  ctx.log.info('stripe sync summary', {
    processed: results.length,
    totalSettled: totals.settled,
    totalNeedsReview: totals.needsReview,
    failed: results.filter((r) => r.status === 'error').length,
  })

  return NextResponse.json({ processed: results.length, ...totals, results })
})
