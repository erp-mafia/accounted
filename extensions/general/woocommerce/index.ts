import type { Extension } from '@/lib/extensions/types'
import { woocommerceApiRoutes } from './api-routes'

/**
 * WooCommerce extension
 *
 * Connects a company's WooCommerce store via the wc-auth key handshake (or
 * manual key entry) and imports the store's paid orders and refunds into the
 * transactions inbox as a bank-style feed on the 1680 cash account. Feed-only
 * (same doctrine as the Stripe feed, decision 2026-08-06): nothing is
 * auto-booked, and payment-gateway fees/payouts are out of scope: core wc/v3
 * does not expose them.
 *
 * Required environment variables:
 * - WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY (at-rest key for consumer key/secret)
 */
export const woocommerceExtension: Extension = {
  id: 'woocommerce',
  name: 'WooCommerce',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'WooCommerce',
    path: '/import?mode=woocommerce',
  },

  apiRoutes: woocommerceApiRoutes,
}

export default woocommerceExtension
