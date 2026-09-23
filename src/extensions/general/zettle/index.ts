import type { Extension } from '@/lib/extensions/types'
import { zettleApiRoutes } from './api-routes'

/**
 * Zettle extension
 *
 * Connects a company's PayPal Zettle merchant account via partner-hosted
 * OAuth (authorization code grant + rotating refresh token) and upserts
 * paid purchases and refunds into webshop_orders (the Orders page), with
 * per-rate VAT and a line-item snapshot as booking underlag. Feed-only
 * (same doctrine as WooCommerce/Shopify): nothing is auto-booked. Finance
 * API payouts/fees are out of scope for v1.
 *
 * Required environment variables:
 * - ZETTLE_CLIENT_ID
 * - ZETTLE_CLIENT_SECRET
 * - ZETTLE_CREDENTIALS_ENCRYPTION_KEY
 */
export const zettleExtension: Extension = {
  id: 'zettle',
  name: 'Zettle',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'Zettle',
    path: '/import?mode=zettle',
  },

  apiRoutes: zettleApiRoutes,
}

export default zettleExtension
