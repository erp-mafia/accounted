import type { Extension } from '@/lib/extensions/types'
import { shopifyApiRoutes } from './api-routes'

/**
 * Shopify extension
 *
 * Connects a company's Shopify store via a merchant-created Dev Dashboard
 * custom app (client credentials grant; the revealable shpat_ token flow was
 * discontinued 2026-01-01) and upserts the store's paid orders and refunds
 * into webshop_orders (the Orders page), with per-rate VAT and a line-item
 * snapshot as booking underlag. Feed-only (same doctrine as the WooCommerce
 * sync): nothing is auto-booked, and Shopify Payments payout/fee
 * reconciliation is out of scope for now (phase 2).
 *
 * Required environment variables:
 * - SHOPIFY_CREDENTIALS_ENCRYPTION_KEY (at-rest key for client id/secret)
 */
export const shopifyExtension: Extension = {
  id: 'shopify',
  name: 'Shopify',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'Shopify',
    path: '/import?mode=shopify',
  },

  apiRoutes: shopifyApiRoutes,
}

export default shopifyExtension
