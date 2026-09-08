import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { isZettleConfigured } from '@/extensions/general/zettle/lib/credentials'
import { syncZettlePurchases } from '@/extensions/general/zettle/lib/order-sync'
import type { ZettleConnection } from '@/extensions/general/zettle/types'

export const maxDuration = 300

/** Cap of entitled connections synced per cron invocation. */
const MAX_SYNCED = 50
/** Page size when scanning candidates ordered by purchase cursor. */
const CANDIDATE_PAGE_SIZE = 100
/** Hard stop so a flood of non-entitled rows cannot burn the whole budget scanning. */
const MAX_CANDIDATES_SCANNED = 2000

/**
 * GET /api/extensions/zettle/orders/cron
 * Nightly purchase sync for connections that opted in (transaction_sync_enabled):
 * upserts each connected org's paid purchases and refunds into webshop_orders.
 *
 * Candidates are paged by last_order_synced_at. Entitlement skips do not advance
 * that cursor (it controls purchase recovery) and do not consume the sync cap,
 * so a front of non-entitled rows cannot starve eligible connections behind them.
 */
export const GET = withCronContext('cron.zettle_order_sync', async (_request, ctx) => {
  loadExtensions()
  if (!extensionRegistry.get('zettle')) {
    ctx.log.warn('zettle extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Zettle extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }
  if (!isZettleConfigured()) {
    return NextResponse.json({ message: 'Zettle not configured', processed: 0 })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  const TIME_BUDGET_MS = 240_000
  const deadlineMs = startTime + TIME_BUDGET_MS

  const results: Array<{
    connectionId: string
    inserted: number
    updated: number
    status: 'synced' | 'revoked' | 'error'
  }> = []

  let offset = 0
  let scanned = 0
  let hadCandidates = false

  while (
    results.length < MAX_SYNCED &&
    scanned < MAX_CANDIDATES_SCANNED &&
    Date.now() < deadlineMs
  ) {
    const { data: page, error: connError } = await supabase
      .from('zettle_connections')
      .select('*')
      .eq('status', 'active')
      .eq('transaction_sync_enabled', true)
      .order('last_order_synced_at', { ascending: true, nullsFirst: true })
      .range(offset, offset + CANDIDATE_PAGE_SIZE - 1)

    if (connError) {
      ctx.log.error('failed to fetch zettle connections', connError, {
        message: connError.message,
        code: connError.code,
      })
      return errorResponse(connError, ctx.log, { requestId: ctx.requestId })
    }

    if (!page || page.length === 0) break
    hadCandidates = true

    for (const connection of page as ZettleConnection[]) {
      scanned += 1
      if (Date.now() >= deadlineMs) {
        ctx.log.info('time budget reached', { processedSoFar: results.length, scanned })
        break
      }
      if (results.length >= MAX_SYNCED) break

      if (!(await hasCapability(supabase, connection.company_id, CAPABILITY.zettle_sync))) {
        ctx.log.info('skip: capability not entitled', { companyId: connection.company_id })
        continue
      }

      try {
        const summary = await syncZettlePurchases(supabase, connection, ctx.log, deadlineMs)
        if (summary.deadlineReached) {
          ctx.log.info('connection stopped early on time budget; remaining rows resume next run', {
            connectionId: connection.id,
          })
        }
        results.push({
          connectionId: connection.id,
          inserted: summary.inserted,
          updated: summary.updated,
          status: summary.revoked ? 'revoked' : 'synced',
        })
      } catch (error) {
        ctx.log.error('zettle purchase sync failed for connection', error as Error, {
          connectionId: connection.id,
          companyId: connection.company_id,
        })
        results.push({
          connectionId: connection.id,
          inserted: 0,
          updated: 0,
          status: 'error',
        })
      }
    }

    offset += page.length
    if (page.length < CANDIDATE_PAGE_SIZE) break
  }

  if (!hadCandidates) {
    return NextResponse.json({
      message: 'No connections with transaction sync enabled',
      processed: 0,
    })
  }

  const totalInserted = results.reduce((acc, r) => acc + r.inserted, 0)
  ctx.log.info('zettle purchase sync summary', {
    processed: results.length,
    scanned,
    totalInserted,
    failed: results.filter((r) => r.status === 'error').length,
  })

  return NextResponse.json({ processed: results.length, inserted: totalInserted, results })
})
