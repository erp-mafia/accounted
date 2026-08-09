import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isShopifyConfigured, encryptCredential } from './lib/credentials'
import { normalizeShopDomain, testConnectionAndFetchShopInfo } from './lib/api-client'
import { syncShopifyOrders } from './lib/order-sync'
import type { ShopifyConnection, ShopifyStatusResponse } from './types'

// Per-user limits: connect probes the merchant's store, sync pages its
// order history.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }

const NOT_CONFIGURED_MESSAGE =
  'Shopify-integrationen är inte konfigurerad på den här installationen.'

/** Columns safe to hand to the browser: never the encrypted credentials. */
const STATUS_COLUMNS =
  'id, status, shop_domain, shop_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at'

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
 * Connect guards: sandbox users never reach external stores (same doctrine as
 * the Stripe/WooCommerce connects), and the feed is a paid capability
 * (shopify_sync).
 */
async function guardConnectPreconditions(auth: AuthedContext): Promise<NextResponse | null> {
  if (auth.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(auth.supabase, auth.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(auth.supabase, auth.companyId, CAPABILITY.shopify_sync)
}

export const shopifyApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      // Prefer the active connection; otherwise surface the most recent row
      // so the panel can show error/revoked states.
      const { data: rows } = await auth.supabase
        .from('shopify_connections')
        .select(STATUS_COLUMNS)
        .eq('company_id', auth.companyId)
        .order('created_at', { ascending: false })
        .limit(10)

      const connection = rows?.find((r) => r.status === 'active') ?? rows?.[0] ?? null
      const payload: ShopifyStatusResponse = {
        configured: isShopifyConfigured(),
        connection,
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
        prefix: 'shopify:connect',
        identifier: auth.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isShopifyConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        shop_domain?: unknown
        client_id?: unknown
        client_secret?: unknown
      }
      const shopDomain =
        typeof body.shop_domain === 'string' ? normalizeShopDomain(body.shop_domain) : null
      const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
      const clientSecret =
        typeof body.client_secret === 'string' ? body.client_secret.trim() : ''
      if (!shopDomain) {
        return NextResponse.json(
          { error: 'Ange butikens myshopify.com-adress, t.ex. minbutik.myshopify.com.' },
          { status: 400 },
        )
      }
      if (!clientId || !clientSecret) {
        return NextResponse.json(
          { error: 'Ange både appens klient-ID och klienthemlighet.' },
          { status: 400 },
        )
      }

      const { data: existing } = await auth.supabase
        .from('shopify_connections')
        .select('id, status')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: 'Företaget har redan en ansluten Shopify-butik. Koppla från den först.' },
          { status: 409 },
        )
      }

      // Verify before storing: a typo'd secret or missing read_orders scope
      // must fail here, not at 03:15.
      let shopInfo
      try {
        shopInfo = await testConnectionAndFetchShopInfo({
          shopDomain,
          clientId,
          clientSecret,
        })
      } catch (probeError) {
        log.warn('[shopify] Credential probe failed', {
          companyId: auth.companyId,
          message: probeError instanceof Error ? probeError.message : String(probeError),
        })
        return NextResponse.json(
          {
            error:
              'Kunde inte ansluta till butiken med de angivna uppgifterna. Kontrollera adressen och att appen har behörigheten read_orders.',
          },
          { status: 400 },
        )
      }

      const { data: created, error: insertError } = await auth.supabase
        .from('shopify_connections')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          shop_domain: shopDomain,
          shop_name: shopInfo.name,
          currency: shopInfo.currency,
          client_id_encrypted: encryptCredential(clientId),
          client_secret_encrypted: encryptCredential(clientSecret),
          status: 'active',
          connected_at: new Date().toISOString(),
          transaction_sync_enabled: true,
        })
        .select('id, shop_domain')
        .single()

      if (insertError || !created) {
        const isConflict = insertError?.code === '23505'
        log.error('[shopify] Failed to create connection', {
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
            type: 'shopify.connected',
            payload: {
              connectionId: created.id,
              shopDomain: created.shop_domain,
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
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.shopify_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'shopify:sync',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      // Membership-scoped lookup via the user client; the sync itself runs on
      // the service client (cursor updates and ingest are service paths). The
      // manual button ignores transaction_sync_enabled (that flag gates the
      // nightly cron): pressing it IS the opt-in.
      const { data: connection } = await auth.supabase
        .from('shopify_connections')
        .select('*')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
        .maybeSingle()

      if (!connection) {
        return NextResponse.json(
          { error: 'Ingen ansluten Shopify-butik.' },
          { status: 404 },
        )
      }

      try {
        const serviceClient = createServiceClientNoCookies()
        // Bounded like the cron: without a deadline a huge first sync would be
        // killed at the dispatcher's maxDuration with no cursor persisted;
        // with one it stops cleanly, reports a partial sync and resumes where
        // it stopped on the next press.
        const summary = await syncShopifyOrders(
          serviceClient,
          connection as ShopifyConnection,
          undefined,
          Date.now() + 240_000,
        )
        return NextResponse.json({ success: true, transactions: summary })
      } catch (error) {
        log.error('[shopify] Manual sync failed', {
          message: error instanceof Error ? error.message : String(error),
          connection_id: connection.id,
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
        CAPABILITY.shopify_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'shopify:transaction-sync-toggle',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled (boolean) krävs.' }, { status: 400 })
      }

      const { data: updated, error: updateError } = await auth.supabase
        .from('shopify_connections')
        .update({ transaction_sync_enabled: body.enabled })
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
        .select('id')

      if (updateError) {
        return NextResponse.json(
          { error: 'Kunde inte spara inställningen. Försök igen.' },
          { status: 500 },
        )
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json(
          { error: 'Ingen ansluten Shopify-butik.' },
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
        prefix: 'shopify:disconnect',
        identifier: auth.userId,
        ...RATE_LIMIT_DISCONNECT,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      const base = auth.supabase
        .from('shopify_connections')
        .select('id, status, shop_domain')
        .eq('company_id', auth.companyId)
      const query = body.connection_id
        ? base.eq('id', body.connection_id).limit(1)
        : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
      const { data: rows, error: findError } = await query
      const connection = rows?.[0]

      if (findError || !connection) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
      }

      // There is no remote revoke API for a merchant-owned custom app: the
      // app lives in the merchant's Dev Dashboard and only they can delete it
      // or rotate its secret. We drop our copy of the credentials outright
      // (nothing reads them after revoke, and a reconnect inserts a fresh
      // row); the audit row keeps shop_domain and the connect/disconnect
      // timestamps. The panel tells the user to remove the app in Shopify too.
      const { error: updateError } = await auth.supabase
        .from('shopify_connections')
        .update({
          status: 'revoked',
          client_id_encrypted: null,
          client_secret_encrypted: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('company_id', auth.companyId)

      if (updateError) {
        log.error('[shopify] Failed to mark connection revoked', {
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
            type: 'shopify.disconnected',
            payload: {
              connectionId: connection.id,
              shopDomain: connection.shop_domain ?? null,
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
