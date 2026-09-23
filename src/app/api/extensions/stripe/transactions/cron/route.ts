import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { syncStripeBalanceTransactions } from '@/extensions/general/stripe/lib/transaction-sync'
import type { StripeConnection } from '@/extensions/general/stripe/types'

export const maxDuration = 300

/**
 * GET /api/extensions/stripe/transactions/cron
 * Nightly balance-transaction sync for connections that opted in
 * (transaction_sync_enabled): imports the connected Stripe balance into the
 * transactions inbox as a bank-style feed on the 1686 cash account.
 *
 * Read-only against Stripe, and it never posts to the journal: rows land
 * unbooked (or pre-linked to entries the deterministic settle/payout flows
 * already created); booking stays a human decision. Idempotent via the
 * (company_id, external_id) unique index, so overlapping windows and re-runs
 * are no-ops. Unlike the 15-minute event sync, this does not emit events, so
 * no ensureInitialized() is needed.
 */
export const GET = withCronContext('cron.stripe_transaction_sync', async (_request, ctx) => {
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

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const { data: connections, error: connError } = await supabase
    .from('stripe_connections')
    .select('*')
    .eq('status', 'active')
    .eq('transaction_sync_enabled', true)
    .order('last_balance_txn_synced_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (connError) {
    ctx.log.error('failed to fetch stripe connections', connError, {
      message: connError.message,
      code: connError.code,
    })
    return errorResponse(connError, ctx.log, { requestId: ctx.requestId })
  }

  if (!connections || connections.length === 0) {
    return NextResponse.json({ message: 'No connections with transaction sync enabled', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 240_000 // leave a minute of margin inside maxDuration
  // Shared with syncStripeBalanceTransactions: it stops between ingest chunks
  // and persists its cursor, so a truncated connection resumes next night.
  const deadlineMs = startTime + TIME_BUDGET_MS

  const results: Array<{
    connectionId: string
    imported: number
    duplicates: number
    linked: number
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
      const summary = await syncStripeBalanceTransactions(supabase, connection, ctx.log, deadlineMs)
      if (summary.deadlineReached) {
        ctx.log.info('connection stopped early on time budget; remaining rows resume next run', {
          connectionId: connection.id,
        })
      }
      results.push({
        connectionId: connection.id,
        imported: summary.imported,
        duplicates: summary.duplicates,
        linked: summary.linked,
        status: summary.revoked ? 'revoked' : 'synced',
      })
    } catch (error) {
      ctx.log.error('stripe transaction sync failed for connection', error as Error, {
        connectionId: connection.id,
        companyId: connection.company_id,
      })
      results.push({
        connectionId: connection.id,
        imported: 0,
        duplicates: 0,
        linked: 0,
        status: 'error',
      })
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      imported: acc.imported + r.imported,
      linked: acc.linked + r.linked,
    }),
    { imported: 0, linked: 0 },
  )
  ctx.log.info('stripe transaction sync summary', {
    processed: results.length,
    totalImported: totals.imported,
    totalLinked: totals.linked,
    failed: results.filter((r) => r.status === 'error').length,
  })

  return NextResponse.json({ processed: results.length, ...totals, results })
})
