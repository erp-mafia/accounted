import type { WooCredentials } from './api-client'
import { decryptCredential } from './credentials'
import type { WooCommerceConnection } from '../types'

/**
 * WooCommerce "Auth Endpoint" handshake helpers.
 *
 * The merchant's browser is sent to {store}/wc-auth/v1/authorize; after they
 * approve, WooCommerce POSTs the generated consumer key/secret server-to-
 * server to our callback_url and redirects the browser to return_url. Our
 * oauth_state UUID rides in the handshake's user_id parameter and comes back
 * in both places, tying callback and return to the pending connection row.
 *
 * There is no signature on the callback POST, so possession of the
 * single-use state is the CSRF defense, and authenticity is proven by
 * probing the STORED store_url with the received keys before activation: a
 * forged POST would need working read credentials for the exact store the
 * user asked to connect.
 */

const APP_NAME = 'Accounted'

export function buildAuthorizeUrl(storeUrl: string, state: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!baseUrl) throw new Error('NEXT_PUBLIC_APP_URL is not configured')
  const params = new URLSearchParams({
    app_name: APP_NAME,
    // Read-only: the feed never writes to the store.
    scope: 'read',
    user_id: state,
    return_url: `${baseUrl}/api/extensions/woocommerce/return`,
    callback_url: `${baseUrl}/api/extensions/woocommerce/callback`,
  })
  return `${storeUrl}/wc-auth/v1/authorize?${params.toString()}`
}

/** Decrypted API credentials for an active connection. */
export function credentialsOf(
  connection: Pick<
    WooCommerceConnection,
    'store_url' | 'consumer_key_encrypted' | 'consumer_secret_encrypted'
  >,
): WooCredentials {
  if (!connection.consumer_key_encrypted || !connection.consumer_secret_encrypted) {
    throw new Error('Connection has no stored credentials')
  }
  return {
    storeUrl: connection.store_url,
    consumerKey: decryptCredential(connection.consumer_key_encrypted),
    consumerSecret: decryptCredential(connection.consumer_secret_encrypted),
  }
}
