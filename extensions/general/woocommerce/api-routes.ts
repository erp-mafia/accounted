import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isWooCommerceConfigured, encryptCredential } from './lib/credentials'
import { normalizeStoreUrl, testConnectionAndFetchStoreInfo } from './lib/api-client'
import { buildAuthorizeUrl } from './lib/connect'
import { syncWooCommerceOrders } from './lib/order-sync'
import type { WooCommerceConnection, WooCommerceStatusResponse } from './types'

// Per-user limits: connect/disconnect start outward-facing handshakes, sync
// hits the merchant's WooCommerce host.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }

// A pending row younger than this blocks a second connect attempt so a
// double-click cannot start two handshake round-trips (only one state would
// survive, stranding the other at the callback).
const PENDING_FRESH_MS = 60_000

const NOT_CONFIGURED_MESSAGE =
  'WooCommerce-integrationen är inte konfigurerad på den här installationen.'

/** Columns safe to hand to the browser: never the encrypted credentials. */
const STATUS_COLUMNS =
  'id, status, store_url, store_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at'

type AuthedContext = {
  supabase: ExtensionContext['supabase']
  userId: string
  isAnonymous: boolean
  companyId: string
}

/** Shared auth preamble: cookie user + company context, or an error response. */
async function requireUserAndCompany(
  ctx: ExtensionContext | undefined,
): Promise<AuthedContext | NextResponse> {
  const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!ctx?.companyId) {
    return NextResponse.json({ error: 'Company context required' }, { status: 400 })
  }
  return {
    supabase,
    userId: user.id,
    isAnonymous: Boolean(user.is_anonymous),
    companyId: ctx.companyId,
  }
}

/**
 * Guards shared by both connect paths: sandbox users never reach external
 * stores (same doctrine as Stripe connect), and the feed is a paid
 * capability (woocommerce_sync).
 */
async function guardConnectPreconditions(auth: AuthedContext): Promise<NextResponse | null> {
  if (auth.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(auth.supabase, auth.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(auth.supabase, auth.companyId, CAPABILITY.woocommerce_sync)
}

/**
 * Existing-connection preflight for both connect paths, scoped to the SAME
 * store: 409 when this store is already actively connected or mid-handshake,
 * and supersede stale pendings for it so their oauth_state can never
 * complete a late callback. Other stores are untouched: a company may
 * connect several stores (multi-store, migration 20260811073422).
 */
async function blockOrSupersedeExisting(
  auth: AuthedContext,
  storeUrl: string,
): Promise<NextResponse | null> {
  const { data: existing } = await auth.supabase
    .from('woocommerce_connections')
    .select('id, status, created_at')
    .eq('company_id', auth.companyId)
    .eq('store_url', storeUrl)
    .in('status', ['active', 'pending'])
    .order('created_at', { ascending: false })

  if (existing?.some((c) => c.status === 'active')) {
    return NextResponse.json(
      { error: 'Butiken är redan ansluten. Koppla från den först om du vill ansluta om den.' },
      { status: 409 },
    )
  }
  const pending = existing?.filter((c) => c.status === 'pending') ?? []
  const freshPending = pending.find(
    (c) => Date.now() - new Date(c.created_at).getTime() < PENDING_FRESH_MS,
  )
  if (freshPending) {
    return NextResponse.json(
      { error: 'En anslutning pågår redan. Vänta och försök igen.' },
      { status: 409 },
    )
  }
  if (pending.length > 0) {
    await auth.supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: 'Superseded by new connection attempt',
        oauth_state: null,
      })
      .eq('company_id', auth.companyId)
      .eq('store_url', storeUrl)
      .eq('status', 'pending')
  }
  return null
}

export const woocommerceApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      // Multi-store: every active connection, plus the most recent inactive
      // row when nothing is active (so the panel can show a pending/error/
      // revoked state instead of an empty list). `connection` mirrors the
      // first entry for callers of the old single-store shape.
      const { data: rows } = await auth.supabase
        .from('woocommerce_connections')
        .select(STATUS_COLUMNS)
        .eq('company_id', auth.companyId)
        .order('created_at', { ascending: false })
        .limit(25)

      const active = (rows ?? []).filter((r) => r.status === 'active')
      const connections = active.length > 0 ? active : rows?.[0] ? [rows[0]] : []
      const payload: WooCommerceStatusResponse = {
        configured: isWooCommerceConfigured(),
        connection: connections[0] ?? null,
        connections,
      }
      return NextResponse.json(payload)
    },
  },
  {
    method: 'POST',
    path: '/connect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const blocked = await guardConnectPreconditions(auth)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:connect',
        identifier: auth.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isWooCommerceConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const body = (await request.json().catch(() => ({}))) as { store_url?: unknown }
      const storeUrl =
        typeof body.store_url === 'string' ? normalizeStoreUrl(body.store_url) : null
      if (!storeUrl) {
        return NextResponse.json(
          { error: 'Ange butikens adress som en giltig https-URL.' },
          { status: 400 },
        )
      }

      const conflict = await blockOrSupersedeExisting(auth, storeUrl)
      if (conflict) return conflict

      // Persist the CSRF state BEFORE handing the user to the store: the
      // callback locates the row by oauth_state alone, so the row must exist
      // before the store can ever POST back with that state.
      const oauthState = crypto.randomUUID()
      const { data: created, error: insertError } = await auth.supabase
        .from('woocommerce_connections')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          store_url: storeUrl,
          status: 'pending',
          oauth_state: oauthState,
        })
        .select('id')
        .single()

      if (insertError || !created) {
        log.error('[woocommerce] Failed to stage pending connection', {
          message: insertError?.message,
          code: insertError?.code,
          companyId: auth.companyId,
        })
        return NextResponse.json(
          { error: 'Kunde inte starta anslutningen. Försök igen.' },
          { status: 500 },
        )
      }

      log.info('[woocommerce] Starting wc-auth handshake', {
        connection_id: created.id,
        company_id: auth.companyId,
      })
      return NextResponse.json({ url: buildAuthorizeUrl(storeUrl, oauthState) })
    },
  },
  {
    method: 'POST',
    path: '/manual-connect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const blocked = await guardConnectPreconditions(auth)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:connect',
        identifier: auth.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isWooCommerceConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        store_url?: unknown
        consumer_key?: unknown
        consumer_secret?: unknown
      }
      const storeUrl =
        typeof body.store_url === 'string' ? normalizeStoreUrl(body.store_url) : null
      const consumerKey =
        typeof body.consumer_key === 'string' ? body.consumer_key.trim() : ''
      const consumerSecret =
        typeof body.consumer_secret === 'string' ? body.consumer_secret.trim() : ''
      if (!storeUrl) {
        return NextResponse.json(
          { error: 'Ange butikens adress som en giltig https-URL.' },
          { status: 400 },
        )
      }
      if (!consumerKey || !consumerSecret) {
        return NextResponse.json(
          { error: 'Ange både konsumentnyckel och konsumenthemlighet.' },
          { status: 400 },
        )
      }

      const conflict = await blockOrSupersedeExisting(auth, storeUrl)
      if (conflict) return conflict

      // Verify before storing: a typo'd key must fail here, not at 03:45.
      let storeInfo
      try {
        storeInfo = await testConnectionAndFetchStoreInfo({
          storeUrl,
          consumerKey,
          consumerSecret,
        })
      } catch (probeError) {
        log.warn('[woocommerce] Manual credential probe failed', {
          companyId: auth.companyId,
          message: probeError instanceof Error ? probeError.message : String(probeError),
        })
        return NextResponse.json(
          {
            error:
              'Kunde inte ansluta till butiken med de angivna nycklarna. Kontrollera adressen och att nyckeln har läsbehörighet.',
          },
          { status: 400 },
        )
      }

      const { data: created, error: insertError } = await auth.supabase
        .from('woocommerce_connections')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          store_url: storeUrl,
          store_name: storeInfo.name,
          currency: storeInfo.currency,
          prices_include_tax: storeInfo.prices_include_tax,
          wc_version: storeInfo.wc_version,
          consumer_key_encrypted: encryptCredential(consumerKey),
          consumer_secret_encrypted: encryptCredential(consumerSecret),
          status: 'active',
          connected_at: new Date().toISOString(),
          transaction_sync_enabled: true,
        })
        .select('id, store_url')
        .single()

      if (insertError || !created) {
        const isConflict = insertError?.code === '23505'
        log.error('[woocommerce] Failed to create manual connection', {
          message: insertError?.message,
          code: insertError?.code,
          companyId: auth.companyId,
        })
        return NextResponse.json(
          {
            error: isConflict
              ? 'Butiken är redan ansluten till ett företag.'
              : 'Kunde inte spara anslutningen. Försök igen.',
          },
          { status: isConflict ? 409 : 500 },
        )
      }

      if (ctx?.emit) {
        try {
          await ctx.emit({
            type: 'woocommerce.connected',
            payload: {
              connectionId: created.id,
              storeUrl: created.store_url,
              userId: auth.userId,
              companyId: auth.companyId,
            },
          })
        } catch {
          // Audit event failure must not block the connect itself.
        }
      }

      return NextResponse.json({ success: true, connection_id: created.id })
    },
  },
  {
    method: 'POST',
    path: '/sync',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.woocommerce_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:sync',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      // Membership-scoped lookup via the user client; the sync itself runs on
      // the service client (cursor updates and upserts are service paths).
      // The manual button ignores transaction_sync_enabled (that flag gates
      // the nightly cron): pressing it IS the opt-in. connection_id targets
      // one store; omitted, every active store syncs within one time budget.
      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      let query = auth.supabase
        .from('woocommerce_connections')
        .select('*')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (body.connection_id) query = query.eq('id', body.connection_id)
      const { data: connections } = await query.order('last_order_synced_at', {
        ascending: true,
        nullsFirst: true,
      })

      if (!connections || connections.length === 0) {
        return NextResponse.json(
          { error: 'Ingen ansluten WooCommerce-butik.' },
          { status: 404 },
        )
      }

      try {
        const serviceClient = createServiceClientNoCookies()
        // Bounded like the cron: without a deadline a huge first sync against
        // a slow host would be killed at the dispatcher's maxDuration with no
        // cursor persisted; with one it stops cleanly, reports a partial sync
        // and resumes where it stopped on the next press.
        const deadlineMs = Date.now() + 240_000
        // One entry per processed store, plus an explicit skipped count:
        // returning only the last summary hid per-store failures and reported
        // success for zero work when the deadline expired early.
        const results: Array<{
          connection_id: string
          store_url: string
          summary: Awaited<ReturnType<typeof syncWooCommerceOrders>>
        }> = []
        let skipped = 0
        for (const connection of connections as WooCommerceConnection[]) {
          if (Date.now() >= deadlineMs) {
            skipped += 1
            continue
          }
          const summary = await syncWooCommerceOrders(
            serviceClient,
            connection,
            undefined,
            deadlineMs,
          )
          results.push({
            connection_id: connection.id,
            store_url: connection.store_url,
            summary,
          })
        }
        return NextResponse.json({
          success: true,
          results,
          skipped,
          // Single-store shape kept for the panel's toast summary: the panel
          // always syncs one connection_id, so this IS that store's summary.
          transactions: results[results.length - 1]?.summary ?? null,
        })
      } catch (error) {
        log.error('[woocommerce] Manual sync failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json(
          { error: 'Synkroniseringen misslyckades. Försök igen.' },
          { status: 502 },
        )
      }
    },
  },
  {
    method: 'POST',
    path: '/transaction-sync',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.woocommerce_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:transaction-sync-toggle',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as {
        enabled?: unknown
        connection_id?: string
      }
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled (boolean) krävs.' }, { status: 400 })
      }

      let updateQuery = auth.supabase
        .from('woocommerce_connections')
        .update({ transaction_sync_enabled: body.enabled })
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (body.connection_id) updateQuery = updateQuery.eq('id', body.connection_id)
      const { data: updated, error: updateError } = await updateQuery.select('id')

      if (updateError) {
        return NextResponse.json(
          { error: 'Kunde inte spara inställningen. Försök igen.' },
          { status: 500 },
        )
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json(
          { error: 'Ingen ansluten WooCommerce-butik.' },
          { status: 404 },
        )
      }
      return NextResponse.json({ success: true, enabled: body.enabled })
    },
  },
  {
    method: 'DELETE',
    path: '/disconnect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const rl = await checkRateLimit({
        prefix: 'woocommerce:disconnect',
        identifier: auth.userId,
        ...RATE_LIMIT_DISCONNECT,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      const base = auth.supabase
        .from('woocommerce_connections')
        .select('id, status, store_url')
        .eq('company_id', auth.companyId)
      const query = body.connection_id
        ? base.eq('id', body.connection_id).limit(1)
        : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
      const { data: rows, error: findError } = await query
      const connection = rows?.[0]

      if (findError || !connection) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
      }

      // There is no remote revoke API: the consumer key lives in the store's
      // wp-admin and only the merchant can delete it there. We drop our copy
      // of the credentials outright (nothing reads them after revoke, and a
      // reconnect inserts a fresh row); the audit row keeps store_url and the
      // connect/disconnect timestamps. The panel tells the user to remove the
      // key in WooCommerce as well.
      const { error: updateError } = await auth.supabase
        .from('woocommerce_connections')
        .update({
          status: 'revoked',
          oauth_state: null,
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('company_id', auth.companyId)

      if (updateError) {
        log.error('[woocommerce] Failed to mark connection revoked', {
          message: updateError.message,
          connection_id: connection.id,
        })
        return NextResponse.json(
          { error: 'Kunde inte koppla från. Försök igen.' },
          { status: 500 },
        )
      }

      if (ctx?.emit) {
        try {
          await ctx.emit({
            type: 'woocommerce.disconnected',
            payload: {
              connectionId: connection.id,
              storeUrl: connection.store_url ?? null,
              reason: 'user',
              userId: auth.userId,
              companyId: auth.companyId,
            },
          })
        } catch {
          // Audit event failure must not block the disconnect itself.
        }
      }

      return NextResponse.json({ success: true })
    },
  },
]
