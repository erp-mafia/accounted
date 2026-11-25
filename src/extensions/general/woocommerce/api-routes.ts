import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import {
  FLOW_INITIATOR_MISMATCH_MESSAGE,
  FLOW_INITIATOR_MISMATCH_MESSAGE_EN,
} from '@/lib/auth/oauth-flow-binding'
import { UUID_RE } from '@/lib/invariants/uuid'
import {
  feedBackfillRoute,
  feedDisconnectRoute,
  feedSyncRoute,
  feedTransactionSyncRoute,
  currentConnections,
  lastDisconnected,
  type FeedConnectorSpec,
} from '@/lib/feed-sync/connector-routes'
import { DEFAULT_PAYMENT_ACCOUNT } from '@/lib/webshop-orders/booking-lines'
import { isWooCommerceConfigured, encryptCredential, decryptCredential } from './lib/credentials'
import { normalizeStoreUrl, testConnectionAndFetchStoreInfo } from './lib/api-client'
import {
  classifyProbeFailure,
  probeFailureLogFields,
  probeFailureMessage,
} from './lib/probe-failure'
import {
  activateIfComplete,
  buildAuthorizeUrl,
  HANDSHAKE_EXPIRED_MESSAGE,
  HANDSHAKE_EXPIRED_MESSAGE_EN,
  HANDSHAKE_TTL_MS,
  isHandshakeExpired,
  keySuffixMatches,
  normalizeKeySuffix,
  parkHandshake,
} from './lib/connect'
import { syncWooCommerceOrders, wooStoreScope, type WooCommerceSyncSummary } from './lib/order-sync'
import {
  WOO_EXTENSION_ID,
  parseSkippedOrders,
  skippedOrdersKey,
  skippedOrdersStatus,
} from './lib/skipped-orders'
import { KEY_SUFFIX_LENGTH, MAX_BACKFILL_YEARS } from './types'
import type {
  WooCommerceConnection,
  WooCommerceConnectionStatus,
  WooCommerceConnectionStatusView,
  WooCommerceStatusResponse,
} from './types'

// Per-user limit: connect starts an outward-facing handshake.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }

// Per-user limit on proofs of store control, over a whole handshake's
// lifetime: the key suffix is short, and a bound on tries is what keeps
// typing it a proof rather than a guess.
const RATE_LIMIT_VERIFY_STORE = { maxRequests: 10, windowMs: HANDSHAKE_TTL_MS }

const ALREADY_CONNECTED = {
  error: 'Butiken är redan ansluten till ett företag.',
  error_en: 'The store is already connected to a company.',
}

const NOT_COMPLETED = {
  error: 'Kunde inte slutföra anslutningen. Försök igen.',
  error_en: 'Could not complete the connection. Please try again.',
}

// A pending row younger than this blocks a second connect attempt so a
// double-click cannot start two handshake round-trips (only one state would
// survive, stranding the other at the callback).
const PENDING_FRESH_MS = 60_000

const NOT_CONFIGURED_MESSAGE =
  'WooCommerce-integrationen är inte konfigurerad på den här installationen.'

/** Columns safe to hand to the browser: never the encrypted credentials. */
const STATUS_COLUMNS =
  'id, status, store_url, store_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at'

/**
 * Sync, backfill, the nightly toggle and disconnect: the shared feed routes
 * (lib/feed-sync/connector-routes); /status stays here because a company may
 * connect several stores and each carries its skipped-orders list. There is
 * no remote revoke API: the consumer key lives in the store's wp-admin, so
 * disconnect drops our copy and the panel tells the user to remove the key
 * in WooCommerce as well.
 */
export const woocommerceFeed: FeedConnectorSpec<WooCommerceConnection, WooCommerceSyncSummary> = {
  extensionId: 'woocommerce',
  table: 'woocommerce_connections',
  capability: CAPABILITY.woocommerce_sync,
  cursorColumn: 'last_order_synced_at',
  maxBackfillYears: MAX_BACKFILL_YEARS,
  // Orders book against the payment account, 1686 unless the store maps another.
  settlementAccounts: [DEFAULT_PAYMENT_ACCOUNT],
  notConnectedMessage: 'Ingen ansluten WooCommerce-butik.',
  statusColumns: STATUS_COLUMNS,
  storeColumn: 'store_url',
  isConfigured: isWooCommerceConfigured,
  sync: (supabase, connection, deadlineMs) =>
    syncWooCommerceOrders(supabase, connection, undefined, deadlineMs),
  disconnect: {
    columns: 'store_url',
    clearColumns: ['oauth_state', 'consumer_key_encrypted', 'consumer_secret_encrypted'],
    eventIdentity: (connection) => ({ storeUrl: (connection.store_url as string | null) ?? null }),
  },
}

/**
 * Attach each store's durable skipped-orders list (lib/skipped-orders) to its
 * connection, read on the caller's client (extension_data_select lets every
 * company member read). A failed read is logged and shows no list rather
 * than failing the whole status call; the list itself is untouched.
 */
async function withSkippedOrders(
  supabase: ExtensionContext['supabase'],
  companyId: string,
  connections: WooCommerceConnectionStatus[],
  log: Pick<Console, 'warn'>,
): Promise<WooCommerceConnectionStatusView[]> {
  const withScope = connections.map((c) => ({
    connection: c,
    key: c.store_url ? skippedOrdersKey(wooStoreScope(c.store_url)) : null,
  }))
  const keys = withScope.flatMap((c) => (c.key ? [c.key] : []))
  if (keys.length === 0) return connections
  const { data, error } = await supabase
    .from('extension_data')
    .select('key, value')
    .eq('company_id', companyId)
    .eq('extension_id', WOO_EXTENSION_ID)
    .in('key', keys)
  if (error) {
    log.warn('[woocommerce] Could not read the skipped-orders list', { message: error.message })
    return connections
  }
  const byKey = new Map<string, unknown>(
    ((data ?? []) as Array<{ key: string; value: unknown }>).map((row) => [row.key, row.value]),
  )
  return withScope.map(({ connection, key }) => {
    const orders = key ? parseSkippedOrders(byKey.get(key)) : []
    return orders.length > 0
      ? { ...connection, skipped_currency_orders: skippedOrdersStatus(orders) }
      : connection
  })
}

/**
 * Guards shared by both connect paths: sandbox users never reach external
 * stores (same doctrine as Stripe connect), and the feed is a paid
 * capability (woocommerce_sync).
 */
async function guardConnectPreconditions(ctx: ExtensionContext): Promise<NextResponse | null> {
  if (ctx.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(ctx.supabase, ctx.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.woocommerce_sync)
}

/**
 * Existing-connection preflight for both connect paths, scoped to the SAME
 * store: 409 when this store is already actively connected or mid-handshake,
 * and supersede stale pendings for it so their oauth_state can never
 * complete a late callback. Other stores are untouched: a company may
 * connect several stores (multi-store, migration 20260811073422).
 */
async function blockOrSupersedeExisting(
  ctx: ExtensionContext,
  storeUrl: string,
): Promise<NextResponse | null> {
  const { data: existing } = await ctx.supabase
    .from('woocommerce_connections')
    .select('id, status, created_at')
    .eq('company_id', ctx.companyId)
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
    await ctx.supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: 'Superseded by new connection attempt',
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
        store_name: null,
        currency: null,
        prices_include_tax: null,
        wc_version: null,
        key_permissions: null,
      })
      .eq('company_id', ctx.companyId)
      .eq('store_url', storeUrl)
      .eq('status', 'pending')
  }
  return null
}

export const woocommerceApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx: ExtensionContext) => {
      // Multi-store: per store its active connection, or else its newest
      // pending or failed attempt (so it can be retried or removed), and the
      // most recent row when nothing is left and it had connected (so the
      // panel can show a revoked state instead of an empty list).
      // `connection` mirrors the first entry for callers of the old
      // single-store shape.
      const { data: rows } = await ctx.supabase
        .from('woocommerce_connections')
        .select(STATUS_COLUMNS)
        .eq('company_id', ctx.companyId)
        .order('created_at', { ascending: false })
        .limit(25)

      const current = currentConnections(rows ?? [], (r) => r.store_url)
      const fallback = lastDisconnected(rows ?? [])
      const listed = current.length > 0 ? current : fallback ? [fallback] : []
      const connections = await withSkippedOrders(
        ctx.supabase,
        ctx.companyId,
        listed as WooCommerceConnectionStatus[],
        ctx.log ?? console,
      )
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
    handler: async (request: Request, ctx: ExtensionContext) => {
      const log = ctx.log
      const blocked = await guardConnectPreconditions(ctx)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:connect',
        identifier: ctx.userId,
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

      const conflict = await blockOrSupersedeExisting(ctx, storeUrl)
      if (conflict) return conflict

      // Persist the CSRF state BEFORE handing the user to the store: the
      // callback locates the row by oauth_state alone, so the row must exist
      // before the store can ever POST back with that state.
      const oauthState = crypto.randomUUID()
      const { data: created, error: insertError } = await ctx.supabase
        .from('woocommerce_connections')
        .insert({
          company_id: ctx.companyId,
          user_id: ctx.userId,
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
          companyId: ctx.companyId,
        })
        return NextResponse.json(
          { error: 'Kunde inte starta anslutningen. Försök igen.' },
          { status: 500 },
        )
      }

      // The browser comes back to the host it started on (brand domain or
      // canonical), validated against the brands table: an unregistered
      // Host header collapses to the canonical origin, as does a failed
      // lookup (a wrong return host costs one bounce; a failed connect start
      // would cost the whole flow).
      const appOrigin = await resolveRequestAppOrigin(request, {
        onLookupFailure: 'canonical',
      })

      log.info('[woocommerce] Starting wc-auth handshake', {
        connection_id: created.id,
        company_id: ctx.companyId,
      })
      return NextResponse.json({ url: buildAuthorizeUrl(storeUrl, oauthState, appOrigin) })
    },
  },
  {
    method: 'POST',
    path: '/manual-connect',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const log = ctx.log
      const blocked = await guardConnectPreconditions(ctx)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:connect',
        identifier: ctx.userId,
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

      const conflict = await blockOrSupersedeExisting(ctx, storeUrl)
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
          companyId: ctx.companyId,
          ...probeFailureLogFields(probeError),
        })
        const kind = classifyProbeFailure(probeError)
        const copy = probeFailureMessage(kind)
        return NextResponse.json(
          { error: copy.sv, error_en: copy.en, code: `PROBE_${kind.toUpperCase()}` },
          { status: 400 },
        )
      }

      // The keys were typed in under this user's session: that IS the browser
      // confirmation the activation CHECK requires. browser_confirmed_at is
      // server-only (trigger, 20260907150000), so the insert runs on the
      // service client; membership was already proven by the dispatcher
      // and company_id/user_id come from that context, never from the body.
      // The order cursor is seeded with the connection moment, same as the
      // handshake activation (activateIfComplete): older orders are already
      // booked from the bank side, and fetching them is an explicit backfill.
      const connectedAt = new Date().toISOString()
      const { data: created, error: insertError } = await createServiceClientNoCookies()
        .from('woocommerce_connections')
        .insert({
          company_id: ctx.companyId,
          user_id: ctx.userId,
          store_url: storeUrl,
          store_name: storeInfo.name,
          currency: storeInfo.currency,
          prices_include_tax: storeInfo.prices_include_tax,
          wc_version: storeInfo.wc_version,
          consumer_key_encrypted: encryptCredential(consumerKey),
          consumer_secret_encrypted: encryptCredential(consumerSecret),
          status: 'active',
          connected_at: connectedAt,
          browser_confirmed_at: connectedAt,
          last_order_synced_at: connectedAt,
          transaction_sync_enabled: true,
        })
        .select('id, store_url')
        .single()

      if (insertError || !created) {
        const isConflict = insertError?.code === '23505'
        log.error('[woocommerce] Failed to create manual connection', {
          message: insertError?.message,
          code: insertError?.code,
          companyId: ctx.companyId,
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

      if (ctx.emit) {
        try {
          await ctx.emit({
            type: 'woocommerce.connected',
            payload: {
              connectionId: created.id,
              storeUrl: created.store_url,
              userId: ctx.userId,
              companyId: ctx.companyId,
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
    // The last step of the wc-auth connect. wc-auth never says who approved
    // in the store, so the initiator proves control of it: the last
    // characters of the key WooCommerce just minted, which only the store's
    // own admin shows (lib/connect). Only then does the row go live.
    method: 'POST',
    path: '/verify-store',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const log = ctx.log
      const blocked = await guardConnectPreconditions(ctx)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'woocommerce:verify-store',
        identifier: ctx.userId,
        ...RATE_LIMIT_VERIFY_STORE,
      })
      if (!rl.ok) return rl.response!

      if (!isWooCommerceConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        connection_id?: unknown
        key_suffix?: unknown
      }
      const connectionId =
        typeof body.connection_id === 'string' && UUID_RE.test(body.connection_id)
          ? body.connection_id
          : null
      const suffix = typeof body.key_suffix === 'string' ? normalizeKeySuffix(body.key_suffix) : null
      if (!connectionId || !suffix) {
        return NextResponse.json(
          {
            error: `Ange de sista ${KEY_SUFFIX_LENGTH} tecknen i konsumentnyckeln.`,
            error_en: `Enter the last ${KEY_SUFFIX_LENGTH} characters of the consumer key.`,
          },
          { status: 400 },
        )
      }

      // The staged key is withheld from end-user sessions (20260929173432):
      // read it on the service client, scoped to the caller's company.
      const service = createServiceClientNoCookies()
      const { data: row, error: findError } = await service
        .from('woocommerce_connections')
        .select('id, user_id, created_at, consumer_key_encrypted')
        .eq('id', connectionId)
        .eq('company_id', ctx.companyId)
        .eq('status', 'pending')
        .maybeSingle()
      if (findError) {
        log.error('[woocommerce] Could not read the connection to verify', {
          code: findError.code,
          message: findError.message,
          companyId: ctx.companyId,
        })
        return NextResponse.json(
          { error: 'Kunde inte läsa anslutningen. Försök igen.', error_en: 'Could not read the connection. Please try again.' },
          { status: 500 },
        )
      }
      if (!row) {
        return NextResponse.json(
          {
            error: 'Ingen anslutning väntar på bekräftelse.',
            error_en: 'No connection is waiting for confirmation.',
          },
          { status: 404 },
        )
      }
      // Activation happens under the session that started the handshake,
      // never a colleague's.
      if (row.user_id !== ctx.userId) {
        return NextResponse.json(
          { error: FLOW_INITIATOR_MISMATCH_MESSAGE, error_en: FLOW_INITIATOR_MISMATCH_MESSAGE_EN },
          { status: 403 },
        )
      }
      if (isHandshakeExpired(row.created_at)) {
        await parkHandshake(service, row.id, HANDSHAKE_EXPIRED_MESSAGE)
        return NextResponse.json(
          { error: HANDSHAKE_EXPIRED_MESSAGE, error_en: HANDSHAKE_EXPIRED_MESSAGE_EN, code: 'expired' },
          { status: 409 },
        )
      }
      if (!row.consumer_key_encrypted) {
        return NextResponse.json(
          {
            error: 'Butiken har inte skickat någon nyckel än. Godkänn anslutningen i butiken och försök igen.',
            error_en: 'The store has not sent a key yet. Approve the connection in the store and try again.',
            code: 'not_approved',
          },
          { status: 409 },
        )
      }
      if (!keySuffixMatches(decryptCredential(row.consumer_key_encrypted), suffix)) {
        log.warn('[woocommerce] Store control proof did not match', {
          connection_id: row.id,
          companyId: ctx.companyId,
        })
        return NextResponse.json(
          {
            error: 'Tecknen stämmer inte med nyckeln. Jämför med nyckeln i butikens WooCommerce-inställningar och försök igen.',
            error_en: "The characters do not match the key. Compare them with the key in the store's WooCommerce settings and try again.",
            code: 'suffix_mismatch',
          },
          { status: 400 },
        )
      }

      // Proven. This is the session-bound confirmation the activation CHECK
      // requires; browser_confirmed_at is server-only (20260907150000), so
      // the write runs on the service client.
      const { error: confirmError } = await service
        .from('woocommerce_connections')
        .update({ browser_confirmed_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'pending')
      if (confirmError) {
        log.error('[woocommerce] Failed to record the store control proof', {
          connection_id: row.id,
          code: confirmError.code,
          message: confirmError.message,
        })
        return NextResponse.json(NOT_COMPLETED, { status: 500 })
      }

      const activation = await activateIfComplete(service, row.id)
      if (activation.outcome === 'conflict') {
        // 23505: the store is already actively connected, to this or another company.
        await parkHandshake(service, row.id, ALREADY_CONNECTED.error)
        return NextResponse.json({ ...ALREADY_CONNECTED, code: 'conflict' }, { status: 409 })
      }
      if (activation.outcome !== 'activated') {
        // Failed, or the row left pending (or its TTL) since it was read.
        log.error('[woocommerce] Failed to activate a proven connection', {
          connection_id: row.id,
          outcome: activation.outcome,
          ...(activation.outcome === 'failed' ? activation.error : {}),
        })
        return NextResponse.json(NOT_COMPLETED, { status: 500 })
      }

      try {
        await ctx.emit({
          type: 'woocommerce.connected',
          payload: {
            connectionId: activation.connection.id,
            storeUrl: activation.connection.store_url,
            userId: activation.connection.user_id,
            companyId: activation.connection.company_id,
          },
        })
      } catch {
        // Audit event failure must not block the connect itself: the row is active.
      }

      return NextResponse.json({ success: true, connection_id: row.id })
    },
  },
  feedSyncRoute(woocommerceFeed),
  feedBackfillRoute(woocommerceFeed),
  feedTransactionSyncRoute(woocommerceFeed),
  feedDisconnectRoute(woocommerceFeed),
]
