/**
 * The manual routes every cursor-based connector feed (Shopify, WooCommerce,
 * Zettle, Stripe) serves under /api/extensions/ext/<id>/: status, "Synka nu",
 * the backfill, the nightly-sync toggle and disconnect.
 *
 * Each connector carried its own copy of these five handlers, and the copies
 * had drifted: Zettle alone answered 409 on a sync that lost the lock (and put
 * a backfill's cursor back), WooCommerce alone accepted a connection_id, and
 * Stripe alone looked its connection up on the session client. The factory is
 * the one implementation; a connector supplies its table, cursor and sync
 * function, and keeps only what is genuinely its own (connect, callbacks, a
 * richer status).
 *
 * Core code: extensions import this, never the other way round.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContextApiRoute, ExtensionContext, ExtensionLogger } from '@/lib/extensions/types'
import type { CoreEvent } from '@/lib/events/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import type { CapabilityKey } from '@/lib/entitlements/keys'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { backfillDateErrorMessage, parseBackfillFrom, type BackfillDateError } from './cursor-window'
import { ledgerCoveredThrough } from '@/lib/bookkeeping/ledger-coverage'

const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }
/** Per user and connector; the MCP door shares the panel's budget. */
export const RATE_LIMIT_BACKFILL = { maxRequests: 5, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }

/**
 * Wall clock a single manual run may spend before it stops and resumes later.
 * Without a deadline a huge sync would be killed at the dispatcher's
 * maxDuration (300 s) with no cursor persisted; with one it stops cleanly,
 * reports a partial sync and resumes where it stopped on the next press.
 */
export const MANUAL_SYNC_BUDGET_MS = 240_000

const LOCKED_MESSAGE = 'En synkronisering pågår redan. Försök igen om en stund.'
const SYNC_FAILED_MESSAGE = 'Synkroniseringen misslyckades. Försök igen.'

/** What every connector's sync answers; extra counts pass through to the panel. */
export interface FeedSyncSummary {
  deadlineReached?: boolean
  /** Another run held the connection's sync lock: nothing ran. */
  locked?: boolean
  revoked?: boolean
}

export interface FeedConnectionRow {
  id: string
  company_id: string
  status: string
}

export interface FeedConnectorSpec<C extends FeedConnectionRow, S extends FeedSyncSummary> {
  /** The extension id: rate-limit prefixes and the `<id>.disconnected` event. */
  extensionId: 'shopify' | 'woocommerce' | 'zettle' | 'stripe'
  /** The connections table, one row per connect attempt. */
  table: string
  /** The paid capability every feed route checks. */
  capability: CapabilityKey
  /** The sync cursor (ISO): the backfill moves it back to the chosen date. */
  cursorColumn: string
  maxBackfillYears: number
  /**
   * The cursor (ISO) a validated backfill start day ('YYYY-MM-DD') becomes.
   * Default: midnight UTC. A connector that dates its rows on the Swedish
   * calendar day starts the chosen day at Swedish midnight instead, or the
   * first hour or two of that day would fall outside its own backfill.
   */
  backfillCursor?: (day: string) => string
  /**
   * The ledger account(s) the connector's money settles on (1686 for every
   * feed today). A hand-entered voucher on one of them says the books already
   * hold that day, and a backfill starts after it (crm#1386).
   */
  settlementAccounts: readonly string[]
  /** 404 copy when the company has no active connection (Swedish). */
  notConnectedMessage: string
  /** Columns safe to hand to the browser: never the encrypted credentials. */
  statusColumns: string
  isConfigured: () => boolean
  /**
   * One run on the service client: the connection's secrets are withheld
   * from end-user roles, and the cursor and ingest writes are service paths.
   */
  sync: (supabase: SupabaseClient, connection: C, deadlineMs: number | undefined) => Promise<S>
  /**
   * The manual run's time budget. Null runs unbounded: Stripe persists its
   * cursor per ingest chunk, so a run cut off at the ceiling resumes anyway.
   */
  manualSyncBudgetMs?: number | null
  disconnect: {
    /** Columns the lookup reads besides id and status. */
    columns: string
    /** The remote revoke needs a secret end-user roles cannot read. */
    lookupWithServiceRole?: boolean
    /** Best-effort revoke at the provider; a throw is logged and the local revoke goes on. */
    revokeRemote?: (connection: Record<string, unknown>, log: ExtensionLogger) => Promise<void>
    /** Credential and handshake columns cleared on revoke. */
    clearColumns: string[]
    /** The provider identity the disconnect event carries (shopDomain, storeUrl, ...). */
    eventIdentity: (connection: Record<string, unknown>) => Record<string, string | null>
  }
}

function budgetDeadline(spec: { manualSyncBudgetMs?: number | null }): number | undefined {
  const budget = spec.manualSyncBudgetMs === undefined ? MANUAL_SYNC_BUDGET_MS : spec.manualSyncBudgetMs
  return budget === null ? undefined : Date.now() + budget
}

async function featureGate(
  ctx: ExtensionContext,
  capability: CapabilityKey,
  prefix: string,
  limit: { maxRequests: number; windowMs: number },
): Promise<Response | null> {
  const capabilityBlocked = await requireCapability(ctx.supabase, ctx.companyId, capability)
  if (capabilityBlocked) return capabilityBlocked
  const rl = await checkRateLimit({ prefix, identifier: ctx.userId, ...limit })
  return rl.ok ? null : rl.response!
}

/**
 * GET /status for a connector with one connection per company: the active
 * row, or else the most recent one so the panel can show its pending, error
 * or revoked state.
 */
export function feedStatusRoute<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute {
  return {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx: ExtensionContext) => {
      const { data: rows } = await ctx.supabase
        .from(spec.table)
        .select(spec.statusColumns)
        .eq('company_id', ctx.companyId)
        .order('created_at', { ascending: false })
        .limit(10)
      const list = (rows ?? []) as unknown as Array<{ status: string }>
      const connection = list.find((r) => r.status === 'active') ?? list[0] ?? null
      return NextResponse.json({ configured: spec.isConfigured(), connection })
    },
  }
}

/**
 * POST /sync ("Synka nu"): every active connection of the company, or the one
 * named by connection_id, within one time budget. The button ignores
 * transaction_sync_enabled (that flag gates the nightly cron): pressing it IS
 * the opt-in.
 */
export function feedSyncRoute<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute {
  return {
    method: 'POST',
    path: '/sync',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const gated = await featureGate(ctx, spec.capability, `${spec.extensionId}:sync`, RATE_LIMIT_SYNC)
      if (gated) return gated

      const body = (await request.json().catch(() => ({}))) as { connection_id?: unknown }
      // Service role, scoped to the caller's active company (the dispatcher
      // resolved it from their membership).
      const serviceClient = createServiceClientNoCookies()
      let query = serviceClient
        .from(spec.table)
        .select('*')
        .eq('company_id', ctx.companyId)
        .eq('status', 'active')
      if (typeof body.connection_id === 'string') query = query.eq('id', body.connection_id)
      const { data } = await query.order(spec.cursorColumn, { ascending: true, nullsFirst: true })
      const connections = (data ?? []) as unknown as C[]
      if (connections.length === 0) {
        return NextResponse.json({ error: spec.notConnectedMessage }, { status: 404 })
      }

      const deadlineMs = budgetDeadline(spec)
      // One entry per processed connection, plus an explicit skipped count:
      // a run that only reported its last summary hid per-connection failures
      // and reported success for zero work when the deadline expired early.
      const results: Array<{ connection_id: string; summary: S }> = []
      let skipped = 0
      try {
        for (const connection of connections) {
          if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
            skipped += 1
            continue
          }
          results.push({ connection_id: connection.id, summary: await spec.sync(serviceClient, connection, deadlineMs) })
        }
      } catch (error) {
        ctx.log.error(`[${spec.extensionId}] Manual sync failed`, {
          message: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json({ error: SYNC_FAILED_MESSAGE }, { status: 502 })
      }

      if (results.length > 0 && results.every((r) => r.summary.locked)) {
        return NextResponse.json({ error: LOCKED_MESSAGE }, { status: 409 })
      }
      return NextResponse.json({
        success: true,
        results,
        skipped,
        // The panel's toast reads one summary: it syncs one connection at a time.
        transactions: results[results.length - 1]?.summary ?? null,
      })
    },
  }
}

/** What a backfill answers, for the route and for the MCP door alike. */
export type FeedBackfillResult<S> =
  | {
      ok: true
      connectionId: string
      /** The cursor the run started from; null when the books already hold every day asked for. */
      from: string | null
      /** The last day the books already held, when it moved the start (crm#1386). */
      bookedThrough: string | null
      summary: S
    }
  | { ok: false; status: number; error: string; reason: FeedBackfillRefusal }

/** Why a backfill did not run, for a door that answers in codes instead of HTTP. */
export type FeedBackfillRefusal =
  | BackfillDateError
  | 'not_connected'
  | 'several_connections'
  | 'ledger_unreadable'
  | 'cursor_unsaved'
  | 'locked'
  | 'sync_failed'

export interface FeedBackfillInput {
  /** The chosen start day, 'YYYY-MM-DD' (validated here). */
  from: unknown
  connectionId?: unknown
  /** Fetch days the books already hold too: the caller knows they are not in them. */
  includeBooked?: unknown
}

/**
 * Move the cursor back to the chosen day and sync from there. The cursor is
 * the start date, so a backfill is just the cursor moved back: no second
 * column that could disagree with it. The run pushes it forward again, and
 * the ingest dedups on external_id, so re-reading an already imported range
 * changes nothing.
 *
 * External-id dedup only knows rows the feed itself imported. A period the
 * books already hold (a migrated ledger, a hand-entered samlingsverifikat on
 * the settlement account) would come back as unbooked rows that book the
 * same money twice, so the start never reaches into it unless the caller
 * says includeBooked (crm#1386, lib/bookkeeping/ledger-coverage.ts). When every day asked
 * for is already in the books the cursor stays where it is and the run is an
 * ordinary sync.
 *
 * `supabase` writes the cursor (the session client on the route, so RLS and
 * the writer-role trigger gate it); `serviceClient` reads the connection,
 * whose secrets end-user roles cannot see, and runs the sync.
 */
export async function runFeedBackfill<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
  deps: { supabase: SupabaseClient; serviceClient: SupabaseClient; companyId: string; log: ExtensionLogger },
  input: FeedBackfillInput,
): Promise<FeedBackfillResult<S>> {
  const { supabase, serviceClient, companyId, log } = deps
  const parsed = parseBackfillFrom(input.from, spec.maxBackfillYears)
  if ('error' in parsed) {
    return {
      ok: false,
      status: 400,
      error: backfillDateErrorMessage(parsed.error, spec.maxBackfillYears),
      reason: parsed.error,
    }
  }
  const requestedDay = parsed.iso.slice(0, 10)

  // A start date belongs to one connection: connection_id may be omitted
  // only when the company has a single active one.
  let query = serviceClient
    .from(spec.table)
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'active')
  if (typeof input.connectionId === 'string') query = query.eq('id', input.connectionId)
  const { data } = await query.limit(2)
  const connections = (data ?? []) as unknown as C[]
  if (connections.length === 0) {
    return { ok: false, status: 404, error: spec.notConnectedMessage, reason: 'not_connected' }
  }
  if (connections.length > 1) {
    return {
      ok: false,
      status: 400,
      error: 'Flera anslutningar är aktiva. Ange vilken som ska hämtas (connection_id).',
      reason: 'several_connections',
    }
  }
  const connection = connections[0]
  const previousCursor = (connection as unknown as Record<string, unknown>)[spec.cursorColumn] ?? null

  let bookedThrough: string | null = null
  if (input.includeBooked !== true) {
    try {
      bookedThrough = await ledgerCoveredThrough(serviceClient, companyId, spec.settlementAccounts, requestedDay)
    } catch (error) {
      log.error(`[${spec.extensionId}] Could not read the books before a backfill`, {
        message: error instanceof Error ? error.message : String(error),
        connection_id: connection.id,
      })
      return { ok: false, status: 500, error: 'Kunde inte läsa bokföringen. Försök igen.', reason: 'ledger_unreadable' }
    }
  }
  const startDay = bookedThrough ? addDaysIso(bookedThrough, 1) : requestedDay
  // Every day asked for is already in the books: nothing older to fetch.
  const cursorIso =
    startDay > todayIsoStockholm()
      ? null
      : spec.backfillCursor
        ? spec.backfillCursor(startDay)
        : `${startDay}T00:00:00.000Z`

  if (cursorIso !== null) {
    const { error: cursorError } = await supabase
      .from(spec.table)
      .update({ [spec.cursorColumn]: cursorIso, error_message: null })
      .eq('id', connection.id)
      .eq('company_id', companyId)
      .eq('status', 'active')
    if (cursorError) {
      log.error(`[${spec.extensionId}] Failed to move the sync cursor for backfill`, {
        message: cursorError.message,
        connection_id: connection.id,
      })
      return { ok: false, status: 500, error: 'Kunde inte spara startdatumet. Försök igen.', reason: 'cursor_unsaved' }
    }
  }

  try {
    const summary = await spec.sync(
      serviceClient,
      cursorIso === null ? connection : { ...connection, [spec.cursorColumn]: cursorIso },
      budgetDeadline(spec),
    )
    if (summary.locked) {
      // Nothing ran, and the concurrent run holds its own cursor in
      // memory: leaving the date in place would let it overwrite the
      // backfill silently. Put the cursor back and let the user retry.
      if (cursorIso !== null) {
        await supabase
          .from(spec.table)
          .update({ [spec.cursorColumn]: previousCursor })
          .eq('id', connection.id)
          .eq('company_id', companyId)
      }
      return { ok: false, status: 409, error: LOCKED_MESSAGE, reason: 'locked' }
    }
    return { ok: true, connectionId: connection.id, from: cursorIso, bookedThrough, summary }
  } catch (error) {
    // The cursor stays at the chosen date on purpose: the next run
    // resumes the backfill from where this one failed.
    log.error(`[${spec.extensionId}] Backfill sync failed`, {
      message: error instanceof Error ? error.message : String(error),
      connection_id: connection.id,
    })
    return { ok: false, status: 502, error: SYNC_FAILED_MESSAGE, reason: 'sync_failed' }
  }
}

/**
 * POST /backfill: the panel's "Hämta äldre" (runFeedBackfill). Body:
 * `{ from, connection_id?, include_booked? }`.
 */
export function feedBackfillRoute<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute {
  return {
    method: 'POST',
    path: '/backfill',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const gated = await featureGate(ctx, spec.capability, `${spec.extensionId}:backfill`, RATE_LIMIT_BACKFILL)
      if (gated) return gated

      const body = (await request.json().catch(() => ({}))) as {
        from?: unknown
        connection_id?: unknown
        include_booked?: unknown
      }
      const result = await runFeedBackfill(
        spec,
        {
          supabase: ctx.supabase,
          serviceClient: createServiceClientNoCookies(),
          companyId: ctx.companyId,
          log: ctx.log,
        },
        { from: body.from, connectionId: body.connection_id, includeBooked: body.include_booked },
      )
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status })
      }
      return NextResponse.json({
        success: true,
        from: result.from,
        booked_through: result.bookedThrough,
        connection_id: result.connectionId,
        transactions: result.summary,
      })
    },
  }
}

/** POST /transaction-sync: switch the nightly sync on or off. */
export function feedTransactionSyncRoute<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute {
  return {
    method: 'POST',
    path: '/transaction-sync',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const gated = await featureGate(
        ctx,
        spec.capability,
        `${spec.extensionId}:transaction-sync-toggle`,
        RATE_LIMIT_SYNC,
      )
      if (gated) return gated

      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown; connection_id?: unknown }
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled (boolean) krävs.' }, { status: 400 })
      }

      let update = ctx.supabase
        .from(spec.table)
        .update({ transaction_sync_enabled: body.enabled })
        .eq('company_id', ctx.companyId)
        .eq('status', 'active')
      if (typeof body.connection_id === 'string') update = update.eq('id', body.connection_id)
      const { data: updated, error: updateError } = await update.select('id')

      if (updateError) {
        return NextResponse.json({ error: 'Kunde inte spara inställningen. Försök igen.' }, { status: 500 })
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: spec.notConnectedMessage }, { status: 404 })
      }
      return NextResponse.json({ success: true, enabled: body.enabled })
    },
  }
}

/**
 * DELETE /disconnect: best-effort revoke at the provider, then drop our copy
 * of the credentials outright (nothing reads them after revoke, and a
 * reconnect inserts a fresh row). The row itself stays as the audit trail.
 */
export function feedDisconnectRoute<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute {
  return {
    method: 'DELETE',
    path: '/disconnect',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const rl = await checkRateLimit({
        prefix: `${spec.extensionId}:disconnect`,
        identifier: ctx.userId,
        ...RATE_LIMIT_DISCONNECT,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: unknown }
      // The local revoke below stays on the session client, so RLS and the
      // writer-role trigger still gate it whichever client looked the row up.
      const lookupClient = spec.disconnect.lookupWithServiceRole ? createServiceClientNoCookies() : ctx.supabase
      const base = lookupClient
        .from(spec.table)
        .select(`id, status, ${spec.disconnect.columns}`)
        .eq('company_id', ctx.companyId)
      const query =
        typeof body.connection_id === 'string'
          ? base.eq('id', body.connection_id).limit(1)
          : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
      const { data: rows, error: findError } = await query
      const connection = (rows?.[0] ?? null) as unknown as (Record<string, unknown> & { id: string }) | null
      if (findError || !connection) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
      }

      if (spec.disconnect.revokeRemote) {
        try {
          await spec.disconnect.revokeRemote(connection, ctx.log)
        } catch (err) {
          ctx.log.warn(`[${spec.extensionId}] Remote revoke failed; continuing local revoke`, {
            message: err instanceof Error ? err.message : String(err),
            connection_id: connection.id,
          })
        }
      }

      const cleared = Object.fromEntries(spec.disconnect.clearColumns.map((column) => [column, null]))
      const { error: updateError } = await ctx.supabase
        .from(spec.table)
        .update({ status: 'revoked', ...cleared, disconnected_at: new Date().toISOString() })
        .eq('id', connection.id)
        .eq('company_id', ctx.companyId)
      if (updateError) {
        ctx.log.error(`[${spec.extensionId}] Failed to mark connection revoked`, {
          message: updateError.message,
          connection_id: connection.id,
        })
        return NextResponse.json({ error: 'Kunde inte koppla från. Försök igen.' }, { status: 500 })
      }

      try {
        await ctx.emit({
          type: `${spec.extensionId}.disconnected`,
          payload: {
            connectionId: connection.id,
            ...spec.disconnect.eventIdentity(connection),
            reason: 'user',
            userId: ctx.userId,
            companyId: ctx.companyId,
          },
        } as CoreEvent)
      } catch {
        // Audit event failure must not block the disconnect itself.
      }

      return NextResponse.json({ success: true })
    },
  }
}

/** The five shared routes a single-connection connector serves, status first. */
export function feedConnectorRoutes<C extends FeedConnectionRow, S extends FeedSyncSummary>(
  spec: FeedConnectorSpec<C, S>,
): ContextApiRoute[] {
  return [
    feedStatusRoute(spec),
    feedSyncRoute(spec),
    feedBackfillRoute(spec),
    feedTransactionSyncRoute(spec),
    feedDisconnectRoute(spec),
  ]
}
