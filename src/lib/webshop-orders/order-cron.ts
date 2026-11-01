/**
 * The nightly sync shared by the webshop order crons (Shopify, WooCommerce,
 * Zettle) and the Stripe balance feed. Each route says which extension,
 * table, cursor, capability and sync function it runs; what a run is lives
 * here once:
 *
 *   - a disabled extension answers 200 skipped: each route runs on
 *     withServiceCronContext with requireExtension, whose gate answers before
 *     this runner is reached, and whose service client arrives as ctx.supabase;
 *   - candidates are the active, opted-in connections, oldest cursor first,
 *     snapshotted page by page before any sync moves a cursor;
 *   - a connection whose company is not entitled is skipped without using
 *     the cap or touching its cursor, so a front of such rows cannot starve
 *     the entitled ones behind it;
 *   - at most MAX_SYNCED syncs inside a 240 s budget, shared with each sync,
 *     which stops between pages and keeps its cursor for the next run;
 *   - rows a sync could not write (OrderSyncSummary.errors) are logged as an
 *     error per connection: the sync logs each at warn and holds its cursor
 *     below a failed write, so before this a failing connection read as
 *     synced.
 *
 * Read-only against the stores, and it never posts to the journal: rows land
 * unbooked (webshop_orders; the Stripe feed's transactions). Emits no events.
 *
 * Core cannot import an extension, so the extension's own functions arrive
 * through the spec.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { hasCapability } from '@/lib/entitlements/has-capability'
import type { CapabilityKey } from '@/lib/entitlements/keys'
import type { Logger } from '@/lib/logger'

/** Cap of entitled connections synced per cron invocation. */
export const MAX_SYNCED = 50
/** Page size when scanning candidates ordered by their order cursor. */
export const CANDIDATE_PAGE_SIZE = 100
/** Hard stop so a flood of non-entitled rows cannot burn the budget scanning. */
export const MAX_CANDIDATES_SCANNED = 2000
/** Leaves a minute of margin inside the routes' maxDuration of 300 s. */
export const TIME_BUDGET_MS = 240_000

export interface OrderSyncSummary {
  inserted: number
  updated: number
  /** Rows the sync could not write (or skipped as unreadable); its own warnings say which. */
  errors?: number
  deadlineReached?: boolean
  revoked?: boolean
  /** A manual sync holds the claim; it advances the cursor itself. */
  locked?: boolean
}

export interface WebshopOrderCronSpec<C extends { id: string; company_id: string }> {
  /** Registry id, e.g. 'shopify', for logs. */
  extensionId: string
  /** Name in logs and answers, e.g. 'Shopify'. */
  label: string
  /** Connection table, e.g. 'shopify_connections'. */
  table: string
  /**
   * The sync cursor the candidates are ordered by, oldest first. Each sync
   * moves it forward (its scanned-through watermark included), which is what
   * rotates a connection to the back. Defaults to last_order_synced_at.
   */
  cursorColumn?: string
  capability: CapabilityKey
  isConfigured: () => boolean
  sync: (supabase: SupabaseClient, connection: C, log: Logger, deadlineMs: number) => Promise<OrderSyncSummary>
  /** Housekeeping before the candidates are read; its failure is the spec's to log. */
  beforeSync?: (supabase: SupabaseClient, log: Logger) => Promise<void>
}

/** What the runner needs of withServiceCronContext's context. */
export interface WebshopCronContext {
  requestId: string
  log: Logger
  supabase: SupabaseClient
}

type ConnectionResult = {
  connectionId: string
  inserted: number
  updated: number
  status: 'synced' | 'revoked' | 'locked' | 'error'
}

/** One nightly run. The route's wrapper has checked that the extension is enabled. */
export async function runWebshopOrderCron<C extends { id: string; company_id: string }>(
  ctx: WebshopCronContext,
  spec: WebshopOrderCronSpec<C>,
  now: () => number = Date.now,
): Promise<Response> {
  // The budget covers the whole run, housekeeping included: maxDuration is
  // wall-clock for the route, so the deadline is fixed before any await.
  const deadlineMs = now() + TIME_BUDGET_MS

  if (!spec.isConfigured()) {
    return NextResponse.json({ message: `${spec.label} not configured`, processed: 0 })
  }

  const supabase = ctx.supabase
  if (spec.beforeSync) await spec.beforeSync(supabase, ctx.log)

  // Snapshot the candidate list BEFORE syncing any of it. Each sync moves its
  // row's cursor to "now" (to the tail of this ordering), so
  // paging with a live offset would re-fetch already-synced rows on page 2
  // and never reach the eligible rows that slid into the gap.
  const candidates: C[] = []
  for (let offset = 0; offset < MAX_CANDIDATES_SCANNED; offset += CANDIDATE_PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from(spec.table)
      .select('*')
      .eq('status', 'active')
      .eq('transaction_sync_enabled', true)
      .order(spec.cursorColumn ?? 'last_order_synced_at', { ascending: true, nullsFirst: true })
      .range(offset, offset + CANDIDATE_PAGE_SIZE - 1)
    if (error) {
      ctx.log.error(`failed to fetch ${spec.extensionId} connections`, error, {
        message: error.message,
        code: error.code,
      })
      return errorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!page || page.length === 0) break
    candidates.push(...(page as C[]))
    if (page.length < CANDIDATE_PAGE_SIZE) break
  }

  if (candidates.length === 0) {
    return NextResponse.json({ message: 'No connections with transaction sync enabled', processed: 0 })
  }

  const results: ConnectionResult[] = []
  let scanned = 0
  let rowErrors = 0
  for (const connection of candidates) {
    if (results.length >= MAX_SYNCED) break
    if (now() >= deadlineMs) {
      ctx.log.info('time budget reached', { processedSoFar: results.length, scanned })
      break
    }
    scanned += 1

    if (!(await hasCapability(supabase, connection.company_id, spec.capability))) {
      ctx.log.info('skip: capability not entitled', { companyId: connection.company_id })
      continue
    }

    try {
      const summary = await spec.sync(supabase, connection, ctx.log, deadlineMs)
      if (summary.locked) {
        results.push({ connectionId: connection.id, inserted: 0, updated: 0, status: 'locked' })
        continue
      }
      if (summary.deadlineReached) {
        ctx.log.info('connection stopped early on time budget; remaining rows resume next run', {
          connectionId: connection.id,
        })
      }
      if (summary.errors) {
        rowErrors += summary.errors
        ctx.log.error(`${spec.extensionId} sync left rows unwritten`, {
          connectionId: connection.id,
          companyId: connection.company_id,
          errors: summary.errors,
        })
      }
      results.push({
        connectionId: connection.id,
        inserted: summary.inserted,
        updated: summary.updated,
        status: summary.revoked ? 'revoked' : 'synced',
      })
    } catch (error) {
      ctx.log.error(`${spec.extensionId} order sync failed for connection`, error as Error, {
        connectionId: connection.id,
        companyId: connection.company_id,
      })
      results.push({ connectionId: connection.id, inserted: 0, updated: 0, status: 'error' })
    }
  }

  const totalInserted = results.reduce((acc, r) => acc + r.inserted, 0)
  ctx.log.info(`${spec.extensionId} order sync summary`, {
    processed: results.length,
    scanned,
    totalInserted,
    failed: results.filter((r) => r.status === 'error').length,
    rowErrors,
  })

  return NextResponse.json({ processed: results.length, inserted: totalInserted, results })
}
