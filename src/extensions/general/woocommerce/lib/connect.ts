import { timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WooCredentials } from './api-client'
import { decryptCredential } from './credentials'
import { KEY_SUFFIX_LENGTH, type WooCommerceConnection } from '../types'

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
 * probing the STORED store_url with the received keys before staging them: a
 * forged POST would need working read credentials for the exact store the
 * user asked to connect.
 *
 * wc-auth never says who approved. All the return leg receives (the success
 * flag and our own state) is in the authorize URL the initiator holds, so the
 * initiator's browser coming back proves nothing about the store: a store
 * admin who approved a link someone else generated would connect their store
 * to that someone's company. The store therefore goes live only after the
 * initiator proves control of it: they type the last KEY_SUFFIX_LENGTH
 * characters of the new consumer key, which WooCommerce shows only in the
 * store's own admin. POST /verify-store compares them with the staged key
 * under the initiator's session, records browser_confirmed_at and runs the
 * flip (activateIfComplete). The DB CHECK (migration 20260907143000) forbids
 * an active row without stored keys and that confirmation, and only the
 * server may write the confirmation or move a row into active
 * (20260907150000). Every credential consumer selects status = 'active', so
 * staged keys on a pending row never sync, and abandoned handshakes are
 * parked with their keys wiped.
 */

const APP_NAME = 'Accounted'

/**
 * @param appOrigin The trusted application origin the merchant started the
 *   connect on (canonical app URL or a registered white-label brand domain,
 *   already validated by resolveRequestAppOrigin). The BROWSER leg returns
 *   there: sessions are per domain, so a brand-domain user sent back to the
 *   canonical host would hit the initiator check with no session and land
 *   on a foreign-branded login. The server-to-server callback stays on the
 *   canonical host: no session is involved and the store must reach a
 *   stable URL.
 */
export function buildAuthorizeUrl(storeUrl: string, state: string, appOrigin: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!baseUrl) throw new Error('NEXT_PUBLIC_APP_URL is not configured')
  const params = new URLSearchParams({
    app_name: APP_NAME,
    // Read-only: the feed never writes to the store.
    scope: 'read',
    user_id: state,
    return_url: `${appOrigin}/api/extensions/woocommerce/return`,
    callback_url: `${baseUrl}/api/extensions/woocommerce/callback`,
  })
  return `${storeUrl}/wc-auth/v1/authorize?${params.toString()}`
}

/**
 * A pending handshake older than this is dead: the return leg and the proof
 * route refuse it, activateIfComplete() will not flip it, and the nightly cron
 * parks it with its staged keys wiped. The proof of store control has to land
 * inside it too. The callback leg does NOT refuse it: WooCommerce
 * turns any non-200 into a store-side error page and deletes the freshly
 * minted key, which would strand a slow but legitimate approval; staging on
 * a stale row is harmless because a pending row never syncs and the flip
 * itself carries the TTL.
 */
export const HANDSHAKE_TTL_MS = 15 * 60_000

export const HANDSHAKE_EXPIRED_MESSAGE =
  'Anslutningen gick ut innan den slutfördes. Starta om anslutningen och ta bort den oanvända API-nyckeln i butikens WooCommerce-inställningar.'

export const HANDSHAKE_EXPIRED_MESSAGE_EN =
  "The connection timed out before it was completed. Start it again and remove the unused API key in the store's WooCommerce settings."

export function isHandshakeExpired(createdAt: string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() > HANDSHAKE_TTL_MS
}

/**
 * The typed key suffix as it is compared, or null unless exactly
 * KEY_SUFFIX_LENGTH characters remain. The store's admin prints the suffix
 * behind a mask ("***" in the key list, an ellipsis on the key's own page)
 * that a copy may carry along, so masks and whitespace go; case is ignored
 * because the key is lower-case hex.
 */
export function normalizeKeySuffix(input: string): string | null {
  const cleaned = input.replace(/[\s*.\u2026]/g, '').toLowerCase()
  return cleaned.length === KEY_SUFFIX_LENGTH ? cleaned : null
}

/**
 * Whether a normalized suffix ends the consumer key, compared in constant
 * time: it is the proof that the person typing it can open the store's
 * admin, where WooCommerce shows it and nowhere else.
 */
export function keySuffixMatches(consumerKey: string, suffix: string): boolean {
  const expected = Buffer.from(consumerKey.slice(-KEY_SUFFIX_LENGTH).toLowerCase())
  const given = Buffer.from(suffix)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * Park a handshake that will not complete: status error with the reason
 * shown on the panel, the state consumed, and the staged keys and the store
 * settings the probe read wiped. Scoped to a still-pending row, so a row
 * that moved on meanwhile is never touched.
 */
export function parkHandshake(supabase: SupabaseClient, connectionId: string, message: string) {
  return supabase
    .from('woocommerce_connections')
    .update({
      status: 'error',
      error_message: message,
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
      store_name: null,
      currency: null,
      prices_include_tax: null,
      wc_version: null,
      key_permissions: null,
    })
    .eq('id', connectionId)
    .eq('status', 'pending')
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
 * Flip a pending row to active if, and only if, both signals are present:
 * the keys the callback verified and staged, and the confirmation the proof
 * route records once the initiator has typed the key's suffix.
 *
 * Only the proof route calls this, right after recording the confirmation.
 * The status = 'pending' scope makes it idempotent and blocks replay: an
 * active row can never be activated again.
 *
 * The TTL is part of the predicate, not only of the routes that check it
 * first: a proof that lands after the handshake expired matches zero rows,
 * and the sweep parks the row.
 */
export async function activateIfComplete(
  supabase: SupabaseClient,
  connectionId: string,
  now = Date.now(),
): Promise<ActivationResult> {
  // Seed the order cursor with the connection moment. Orders placed before
  // the merchant connected are already in the books from the bank side, so a
  // first sync that reached further back would only manufacture duplicates
  // (#2631). Reaching further back is an explicit choice: POST
  // /api/extensions/ext/woocommerce/backfill with a start date.
  const connectedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('woocommerce_connections')
    .update({
      status: 'active',
      connected_at: connectedAt,
      last_order_synced_at: connectedAt,
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
    .gte('created_at', new Date(now - HANDSHAKE_TTL_MS).toISOString())
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
      store_name: null,
      currency: null,
      prices_include_tax: null,
      wc_version: null,
      key_permissions: null,
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
