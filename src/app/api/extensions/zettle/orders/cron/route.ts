import { withCronContext } from '@/lib/api/with-cron-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { extensionRegistry } from '@/lib/extensions/registry'
import { extensionDisabledSkip, runWebshopOrderCron } from '@/lib/webshop-orders/order-cron'
import { isZettleConfigured } from '@/extensions/general/zettle/lib/credentials'
import { syncZettlePurchases } from '@/extensions/general/zettle/lib/order-sync'
import type { ZettleConnection } from '@/extensions/general/zettle/types'

export const maxDuration = 300

/**
 * GET /api/extensions/zettle/orders/cron
 * Nightly purchase sync for connections that opted in (transaction_sync_enabled):
 * upserts each connected org's paid purchases and refunds into webshop_orders.
 * The run itself is runWebshopOrderCron.
 */
export const GET = withCronContext('cron.zettle_order_sync', async (_request, ctx) => {
  if (!(await extensionRegistry.get('zettle'))) return extensionDisabledSkip(ctx, 'zettle')
  return runWebshopOrderCron<ZettleConnection>(ctx, {
    extensionId: 'zettle',
    label: 'Zettle',
    table: 'zettle_connections',
    capability: CAPABILITY.zettle_sync,
    isConfigured: isZettleConfigured,
    sync: syncZettlePurchases,
  })
})
