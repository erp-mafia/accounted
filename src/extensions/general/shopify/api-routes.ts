import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { feedConnectorRoutes, type FeedConnectorSpec } from '@/lib/feed-sync/connector-routes'
import { isShopifyConfigured, encryptCredential } from './lib/credentials'
import { normalizeShopDomain, testConnectionAndFetchShopInfo } from './lib/api-client'
import { syncShopifyOrders, type ShopifySyncSummary } from './lib/order-sync'
import { MAX_BACKFILL_YEARS } from './types'
import type { ShopifyConnection } from './types'

// Per-user limit: connect probes the merchant's store.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }

const NOT_CONFIGURED_MESSAGE =
  'Shopify-integrationen är inte konfigurerad på den här installationen.'

/**
 * Status, sync, backfill, the nightly toggle and disconnect: the shared feed
 * routes (lib/feed-sync/connector-routes). There is no remote revoke API for
 * a merchant-owned custom app: only the merchant can delete it in their Dev
 * Dashboard, so disconnect drops our copy of the credentials and the panel
 * tells the user to remove the app in Shopify too.
 */
export const shopifyFeed: FeedConnectorSpec<ShopifyConnection, ShopifySyncSummary> = {
  extensionId: 'shopify',
  table: 'shopify_connections',
  capability: CAPABILITY.shopify_sync,
  cursorColumn: 'last_order_synced_at',
  maxBackfillYears: MAX_BACKFILL_YEARS,
  notConnectedMessage: 'Ingen ansluten Shopify-butik.',
  statusColumns:
    'id, status, shop_domain, shop_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at',
  isConfigured: isShopifyConfigured,
  sync: (supabase, connection, deadlineMs) => syncShopifyOrders(supabase, connection, undefined, deadlineMs),
  disconnect: {
    columns: 'shop_domain',
    clearColumns: ['client_id_encrypted', 'client_secret_encrypted'],
    eventIdentity: (connection) => ({ shopDomain: (connection.shop_domain as string | null) ?? null }),
  },
}

/**
 * Connect guards: sandbox users never reach external stores (same doctrine as
 * the Stripe/WooCommerce connects), and the feed is a paid capability
 * (shopify_sync).
 */
async function guardConnectPreconditions(ctx: ExtensionContext): Promise<NextResponse | null> {
  if (ctx.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(ctx.supabase, ctx.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.shopify_sync)
}

export const shopifyApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'POST',
    path: '/connect',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const log = ctx.log
      const blocked = await guardConnectPreconditions(ctx)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'shopify:connect',
        identifier: ctx.userId,
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

      const { data: existing } = await ctx.supabase
        .from('shopify_connections')
        .select('id, status')
        .eq('company_id', ctx.companyId)
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
          companyId: ctx.companyId,
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

      // Seed the order cursor with the connection moment. Orders placed before
      // the merchant connected are already in the books from the bank side, so
      // a first sync that reached further back would only manufacture
      // duplicates (#2631). Reaching further back is an explicit choice: POST
      // /api/extensions/ext/shopify/backfill with a start date.
      const connectedAt = new Date().toISOString()
      const { data: created, error: insertError } = await ctx.supabase
        .from('shopify_connections')
        .insert({
          company_id: ctx.companyId,
          user_id: ctx.userId,
          shop_domain: shopDomain,
          shop_name: shopInfo.name,
          currency: shopInfo.currency,
          client_id_encrypted: encryptCredential(clientId),
          client_secret_encrypted: encryptCredential(clientSecret),
          status: 'active',
          connected_at: connectedAt,
          last_order_synced_at: connectedAt,
          transaction_sync_enabled: true,
        })
        .select('id, shop_domain')
        .single()

      if (insertError || !created) {
        const isConflict = insertError?.code === '23505'
        log.error('[shopify] Failed to create connection', {
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
            type: 'shopify.connected',
            payload: {
              connectionId: created.id,
              shopDomain: created.shop_domain,
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
  ...feedConnectorRoutes(shopifyFeed),
]
