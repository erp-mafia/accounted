import type { Extension } from '@/lib/extensions/types'
import { woocommerceApiRoutes } from './api-routes'

/**
 * WooCommerce extension
 *
 * Connects a company's WooCommerce store via the wc-auth key handshake (or
 * manual key entry) and imports the store's orders and refunds as rows in the
 * Orders workspace (webshop_orders). Feed-only (same doctrine as the Stripe
 * feed, decision 2026-08-06): nothing is auto-booked. The user books a row
 * from the Orders page, prefilled against the per-store payment-method
 * mapping and otherwise BAS 1686 (Fordringar för kontokort och kuponger).
 *
 * Gateway fees and payouts are still out of scope, but not because they are
 * unreachable: core wc/v3 does not expose them, yet a WooPayments store also
 * serves /wc/v3/payments/deposits and /payments/reports/transactions (fees,
 * net, deposit_id) under the same consumer key, given a key whose user has
 * manage_woocommerce. Booking those is a separate settlement-ledger feature.
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
