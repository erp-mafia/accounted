import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { runWebshopOrderCron } from '@/lib/webshop-orders/order-cron'
import { isShopifyConfigured } from '@/extensions/general/shopify/lib/credentials'
import { syncShopifyOrders } from '@/extensions/general/shopify/lib/order-sync'
import type { ShopifyConnection } from '@/extensions/general/shopify/types'

export const maxDuration = 300

/**
 * GET /api/extensions/shopify/orders/cron
 * Nightly order sync for connections that opted in (transaction_sync_enabled):
 * upserts each connected store's paid orders and refunds into webshop_orders
 * (the Orders page). The run itself is runWebshopOrderCron.
 */
export const GET = withServiceCronContext('cron.shopify_order_sync', async (_request, ctx) => {
  return runWebshopOrderCron<ShopifyConnection>(ctx, {
    extensionId: 'shopify',
    label: 'Shopify',
    table: 'shopify_connections',
    capability: CAPABILITY.shopify_sync,
    isConfigured: isShopifyConfigured,
    sync: syncShopifyOrders,
  })
}, { requireExtension: 'shopify' })
