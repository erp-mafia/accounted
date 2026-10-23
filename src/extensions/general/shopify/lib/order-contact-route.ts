import { NextResponse } from 'next/server'
import type { ContextApiRoute, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createShopifySession, fetchOrderContact } from './api-client'
import { credentialsOf, isShopifyConfigured } from './credentials'
import type { ShopifyConnection } from '../types'

// Per-user limit: every call reaches the merchant's store.
const RATE_LIMIT_ORDER_CONTACT = { maxRequests: 30, windowMs: 60_000 }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /orders/:id/customer: the billing name, company and email of one synced
 * Shopify order, fetched from the store when the user opens Skapa faktura on
 * it. The answer prefills the customer the invoice is created for; nothing is
 * written here, so the order row keeps carrying no names (crm#1032) and the
 * contact lands only on the customer the user confirms. Write access is
 * required because the data only serves creating an invoice. Never logs the
 * contact itself.
 */
export const shopifyOrderContactRoute: ContextApiRoute = {
  method: 'GET',
  path: '/orders/:id/customer',
  requireWrite: true,
  handler: async (request: Request, ctx: ExtensionContext) => {
    // Sandbox sessions and companies never reach an external store.
    if (ctx.isAnonymous) return sandboxBlockedResponse()
    const sandboxBlocked = await guardSandbox(ctx.supabase, ctx.companyId)
    if (sandboxBlocked) return sandboxBlocked
    const capabilityBlocked = await requireCapability(
      ctx.supabase,
      ctx.companyId,
      CAPABILITY.shopify_sync,
    )
    if (capabilityBlocked) return capabilityBlocked

    const rl = await checkRateLimit({
      prefix: 'shopify:order-contact',
      identifier: ctx.userId,
      ...RATE_LIMIT_ORDER_CONTACT,
    })
    if (!rl.ok) return rl.response!

    const orderId = new URL(request.url).searchParams.get('_id') ?? ''
    if (!UUID_RE.test(orderId)) {
      return NextResponse.json({ error: 'Ogiltigt order-id.' }, { status: 400 })
    }

    const { data: order } = await ctx.supabase
      .from('webshop_orders')
      .select('id, platform, row_type, store_scope, platform_order_id')
      .eq('id', orderId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    const row = order as {
      platform: string
      row_type: string
      store_scope: string
      platform_order_id: string
    } | null
    if (!row || row.platform !== 'shopify' || row.row_type !== 'order') {
      return NextResponse.json({ error: 'Ordern hittades inte.' }, { status: 404 })
    }

    if (!isShopifyConfigured()) {
      return NextResponse.json(
        { error: 'Shopify-integrationen är inte konfigurerad på den här installationen.' },
        { status: 503 },
      )
    }

    // Service role, scoped to the caller's company: the encrypted credentials
    // are withheld from end-user roles. The order's store scope is the
    // store's myshopify.com domain (shopifyShopScope).
    const { data: connection } = await createServiceClientNoCookies()
      .from('shopify_connections')
      .select('*')
      .eq('company_id', ctx.companyId)
      .eq('status', 'active')
      .eq('shop_domain', row.store_scope)
      .maybeSingle()
    if (!connection) {
      return NextResponse.json({ error: 'Ingen ansluten Shopify-butik.' }, { status: 404 })
    }

    let contact
    try {
      const session = await createShopifySession(credentialsOf(connection as ShopifyConnection))
      contact = await fetchOrderContact(session, row.platform_order_id)
    } catch (error) {
      ctx.log.warn('[shopify] Order contact lookup failed', {
        companyId: ctx.companyId,
        message: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: 'Kunde inte hämta kunduppgifterna från Shopify. Försök igen.' },
        { status: 502 },
      )
    }
    if (!contact) {
      return NextResponse.json({ error: 'Ordern finns inte längre i Shopify.' }, { status: 404 })
    }
    return NextResponse.json(contact)
  },
}
