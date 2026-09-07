import type { SupabaseClient } from '@supabase/supabase-js'
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
 *
 * Activation itself needs TWO signals on the pending row: the verified keys
 * (callback leg, no browser session) and browser_confirmed_at (return leg,
 * bound to the initiator's session). Either leg may land first; both run
 * activateIfComplete() after writing their own signal, and the row flips to
 * active exactly once, under the DB CHECK that forbids an active row missing
 * either signal (migration 20260907100000). Every credential consumer selects
 * status = 'active', so staged keys on a pending row can never sync.
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

/**
 * A pending handshake older than this is dead: the callback and the return
 * leg both refuse it, and the nightly cron parks it with its staged keys
 * wiped. Generous enough for a merchant to sign in to wp-admin on the way.
 */
export const HANDSHAKE_TTL_MS = 15 * 60_000

export const HANDSHAKE_EXPIRED_MESSAGE =
  'Anslutningen gick ut innan den slutfördes. Starta om anslutningen.'

export function isHandshakeExpired(createdAt: string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() > HANDSHAKE_TTL_MS
}

export interface ActivatedConnection {
  id: string
  company_id: string
  user_id: string
  store_url: string
}

export type ActivationResult =
  | { outcome: 'activated'; connection: ActivatedConnection }
  /** The other signal has not landed yet (or the row is no longer pending). */
  | { outcome: 'incomplete' }
  /** 23505: the store is already actively connected (this or another company). */
  | { outcome: 'conflict'; error: { code?: string; message: string } }
  | { outcome: 'failed'; error: { code?: string; message: string } }

/**
 * Flip a pending row to active if, and only if, both signals are present.
 *
 * Both handshake legs call this after writing their own signal. Postgres
 * serializes the two UPDATEs on the row, and the WHERE is re-evaluated
 * against the latest committed version, so whichever leg runs last sees both
 * signals and activates; the other matches zero rows and reports incomplete.
 * The status = 'pending' scope makes it idempotent and blocks replay: an
 * active row can never be activated again.
 */
export async function activateIfComplete(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<ActivationResult> {
  const { data, error } = await supabase
    .from('woocommerce_connections')
    .update({
      status: 'active',
      connected_at: new Date().toISOString(),
      error_message: null,
      // The state has done its job once both legs have found the row.
      oauth_state: null,
      // Feed-only product: connecting the store means fetching its orders, so
      // the nightly feed starts on by default; the panel toggle is the opt-out.
      transaction_sync_enabled: true,
    })
    .eq('id', connectionId)
    .eq('status', 'pending')
    .not('consumer_key_encrypted', 'is', null)
    .not('consumer_secret_encrypted', 'is', null)
    .not('browser_confirmed_at', 'is', null)
    .select('id, company_id, user_id, store_url')
    .maybeSingle()

  if (error) {
    const err = { code: error.code, message: error.message }
    return error.code === '23505'
      ? { outcome: 'conflict', error: err }
      : { outcome: 'failed', error: err }
  }
  if (!data) return { outcome: 'incomplete' }
  return { outcome: 'activated', connection: data as ActivatedConnection }
}

/**
 * Park every pending handshake older than the TTL: status error, staged keys
 * wiped, state consumed. Nothing on a pending row can sync, so this is
 * hygiene for encrypted-at-rest secrets rather than a security boundary;
 * running it once a night (from the orders cron) is enough.
 */
export async function expireStaleHandshakes(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<{ expired: number; error: { code?: string; message: string } | null }> {
  const { data, error } = await supabase
    .from('woocommerce_connections')
    .update({
      status: 'error',
      error_message: HANDSHAKE_EXPIRED_MESSAGE,
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
    })
    .eq('status', 'pending')
    .lt('created_at', new Date(now - HANDSHAKE_TTL_MS).toISOString())
    .select('id')
  if (error) return { expired: 0, error: { code: error.code, message: error.message } }
  return { expired: data?.length ?? 0, error: null }
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
