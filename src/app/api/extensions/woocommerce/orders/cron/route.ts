import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { runWebshopOrderCron } from '@/lib/webshop-orders/order-cron'
import { isWooCommerceConfigured } from '@/extensions/general/woocommerce/lib/credentials'
import { syncWooCommerceOrders } from '@/extensions/general/woocommerce/lib/order-sync'
import { expireStaleHandshakes } from '@/extensions/general/woocommerce/lib/connect'
import type { WooCommerceConnection } from '@/extensions/general/woocommerce/types'

export const maxDuration = 300

/**
 * GET /api/extensions/woocommerce/orders/cron
 * Nightly order sync for connections that opted in (transaction_sync_enabled):
 * upserts each connected store's orders and refunds into webshop_orders
 * (the Orders page). The run itself is runWebshopOrderCron.
 */
export const GET = withServiceCronContext('cron.woocommerce_order_sync', async (_request, ctx) => {
  return runWebshopOrderCron<WooCommerceConnection>(ctx, {
    extensionId: 'woocommerce',
    label: 'WooCommerce',
    table: 'woocommerce_connections',
    capability: CAPABILITY.woocommerce_sync,
    isConfigured: isWooCommerceConfigured,
    sync: syncWooCommerceOrders,
    // Hygiene first: park handshakes nobody completed and wipe their staged
    // keys. A pending row never syncs (every consumer selects 'active'), so a
    // failure here is logged, not fatal.
    beforeSync: async (supabase, log) => {
      const sweep = await expireStaleHandshakes(supabase)
      if (sweep.error) {
        log.error('failed to expire stale woocommerce handshakes', {
          code: sweep.error.code,
          message: sweep.error.message,
        })
      } else if (sweep.expired > 0) {
        log.info('expired stale woocommerce handshakes', { expired: sweep.expired })
      }
    },
  })
}, { requireExtension: 'woocommerce' })
