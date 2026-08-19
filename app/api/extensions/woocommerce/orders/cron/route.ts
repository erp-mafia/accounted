import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { isWooCommerceConfigured } from '@/extensions/general/woocommerce/lib/credentials'
import { syncWooCommerceOrders } from '@/extensions/general/woocommerce/lib/order-sync'
import type { WooCommerceConnection } from '@/extensions/general/woocommerce/types'

export const maxDuration = 300

/**
 * GET /api/extensions/woocommerce/orders/cron
 * Nightly order sync for connections that opted in (transaction_sync_enabled):
 * upserts each connected store's orders and refunds into webshop_orders
 * (the Orders page), replacing the earlier transactions-inbox feed.
 *
 * Read-only against the stores, and it never posts to the journal: rows land
 * unbooked; booking stays a human decision on the Orders page. Idempotent via
 * the (company_id, external_id) unique index; overlap re-polls become status
 * updates. Emits no events, so no ensureInitialized() is needed.
 */
export const GET = withCronContext('cron.woocommerce_order_sync', async (_request, ctx) => {
  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one: the registry (generated from
  // extensions.config.json) is what actually switches an extension on. A
  // scheduled-but-disabled cron must fail visibly (503) instead of quietly
  // doing the work anyway.
  loadExtensions()
  if (!extensionRegistry.get('woocommerce')) {
    ctx.log.warn('woocommerce extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'WooCommerce extension is not enabled', code: 'EXTENSION_DISABLED' },
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
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ message: 'WooCommerce not configured', processed: 0 })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const { data: connections, error: connError } = await supabase
    .from('woocommerce_connections')
    .select('*')
    .eq('status', 'active')
    .eq('transaction_sync_enabled', true)
    .order('last_order_synced_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (connError) {
    ctx.log.error('failed to fetch woocommerce connections', connError, {
      message: connError.message,
      code: connError.code,
    })
    return errorResponse(connError, ctx.log, { requestId: ctx.requestId })
  }

  if (!connections || connections.length === 0) {
    return NextResponse.json({
      message: 'No connections with transaction sync enabled',
      processed: 0,
    })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 240_000 // leave a minute of margin inside maxDuration
  // Shared with syncWooCommerceOrders: it stops between pages and persists
  // its cursor, so a truncated connection resumes next night.
  const deadlineMs = startTime + TIME_BUDGET_MS

  const results: Array<{
    connectionId: string
    inserted: number
    updated: number
    status: 'synced' | 'revoked' | 'error'
  }> = []

  for (const connection of connections as WooCommerceConnection[]) {
    if (Date.now() >= deadlineMs) {
      ctx.log.info('time budget reached', { processedSoFar: results.length })
      break
    }

    if (!(await hasCapability(supabase, connection.company_id, CAPABILITY.woocommerce_sync))) {
      ctx.log.info('skip: capability not entitled', { companyId: connection.company_id })
      continue
    }

    try {
      const summary = await syncWooCommerceOrders(supabase, connection, ctx.log, deadlineMs)
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
      ctx.log.error('woocommerce order sync failed for connection', error as Error, {
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

  const totalInserted = results.reduce((acc, r) => acc + r.inserted, 0)
  ctx.log.info('woocommerce order sync summary', {
    processed: results.length,
    totalInserted,
    failed: results.filter((r) => r.status === 'error').length,
  })

  return NextResponse.json({ processed: results.length, inserted: totalInserted, results })
})
