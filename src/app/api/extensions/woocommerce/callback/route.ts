import { UUID_RE } from '@/lib/invariants/uuid'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import {
  encryptCredential,
  isWooCommerceConfigured,
} from '@/extensions/general/woocommerce/lib/credentials'
import { testConnectionAndFetchStoreInfo } from '@/extensions/general/woocommerce/lib/api-client'
import {
  classifyProbeFailure,
  probeFailureLogFields,
  probeFailureMessage,
} from '@/extensions/general/woocommerce/lib/probe-failure'
import { parkHandshake } from '@/extensions/general/woocommerce/lib/connect'

const log = createLogger('woocommerce/callback')

// The credential probe talks to an arbitrary (often slow) WooCommerce host.
export const maxDuration = 60

/**
 * POST /api/extensions/woocommerce/callback
 *
 * Server-to-server delivery of the wc-auth handshake result: WooCommerce
 * POSTs { key_id, user_id, consumer_key, consumer_secret, key_permissions }
 * here after the merchant approves. Must be a real Next.js route (not an
 * extension dispatcher handler) because the store calls it directly,
 * unauthenticated: the single-use oauth_state riding in user_id locates the
 * pending row, and the received keys are verified against that row's stored
 * store_url before anything is persisted.
 *
 * This leg has no browser session and says nothing about who approved, so it
 * only STAGES the verified keys on the pending row. The row becomes active
 * once the initiator has proved control of the store by typing the key's
 * last characters (POST /verify-store, lib/connect). A pending row never
 * syncs, so keys staged for a handshake nobody proves are inert until the
 * nightly sweep wipes them.
 *
 * No TTL refusal here on purpose: WooCommerce treats any non-200 as a
 * failed handshake (deletes the key it just minted and shows the merchant an
 * error page on the store, no redirect back), so refusing a slow approval
 * here would strand a legitimate merchant. The TTL lives in the activation
 * predicate and on the session-bound routes, and the nightly sweep parks
 * what is left; a stale pending row cannot flip and never syncs.
 */
export async function POST(request: Request) {
  if (!(await extensionRegistry.get('woocommerce'))) {
    return NextResponse.json(
      { error: 'WooCommerce extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }
  // The registry does not check manifest requiredEnvVars, so this route can be
  // live without the encryption key; without this guard encryptCredential()
  // would throw AFTER the probe, escaping the markError path entirely.
  if (!isWooCommerceConfigured()) {
    return NextResponse.json(
      { error: 'WooCommerce integration is not configured', code: 'NOT_CONFIGURED' },
      { status: 503 },
    )
  }

  let body: {
    user_id?: unknown
    consumer_key?: unknown
    consumer_secret?: unknown
    key_permissions?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const state = typeof body.user_id === 'string' ? body.user_id : null
  const consumerKey = typeof body.consumer_key === 'string' ? body.consumer_key : null
  const consumerSecret = typeof body.consumer_secret === 'string' ? body.consumer_secret : null
  const keyPermissions =
    typeof body.key_permissions === 'string' ? body.key_permissions : null
  // The state is a UUID we generated; reject anything else before it reaches
  // the DB (the column is typed uuid and would error opaquely).
  const isUuid =
    state !== null &&
    UUID_RE.test(state)
  if (!isUuid || !consumerKey || !consumerSecret) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }

  const supabase = await createServiceClient()

  const { data: pending, error: findError } = await supabase
    .from('woocommerce_connections')
    .select('id, company_id, user_id, store_url, consumer_key_encrypted')
    .eq('oauth_state', state)
    .eq('status', 'pending')
    .single()

  if (findError || !pending) {
    log.warn('no pending connection for handshake state', {
      hasRow: Boolean(pending),
      code: findError?.code,
    })
    return NextResponse.json({ error: 'Unknown or expired state' }, { status: 404 })
  }

  const markError = (message: string) => parkHandshake(supabase, pending.id, message)

  // WooCommerce posts once per approval. A second POST for the same state is
  // a replay of something we already hold: never re-probe or overwrite staged
  // keys on its say-so. It answers 200 like the first, so the status code
  // does not double as an "has the merchant approved yet" oracle for whoever
  // holds the state.
  if (pending.consumer_key_encrypted) {
    log.warn('duplicate handshake callback for a state that already holds keys', {
      connectionId: pending.id,
    })
    return staged200()
  }

  // Authenticity check: the keys must actually work against the store URL the
  // user asked to connect. A forged callback with someone else's (or made-up)
  // keys fails here and never gets stored.
  let storeInfo
  try {
    storeInfo = await testConnectionAndFetchStoreInfo({
      storeUrl: pending.store_url,
      consumerKey,
      consumerSecret,
    })
  } catch (probeError) {
    log.error('credential probe failed during handshake', {
      connectionId: pending.id,
      ...probeFailureLogFields(probeError),
    })
    // The panel shows this on the failed row. A cause the merchant can act on
    // (firewall, redirecting address, dead host) is named; a refused key is
    // not theirs to fix here, WooCommerce minted it a second ago.
    const kind = classifyProbeFailure(probeError)
    await markError(
      kind === 'credentials' || kind === 'unknown'
        ? 'Nycklarna kunde inte verifieras mot butiken.'
        : probeFailureMessage(kind).sv,
    )
    return NextResponse.json({ error: 'Credential verification failed' }, { status: 502 })
  }

  // Stage the verified keys. Status stays pending: the row only flips to
  // active once the initiator has proved control of the store
  // (POST /verify-store). oauth_state stays until activation so the return
  // leg can still find the row.
  const { data: staged, error: stageError } = await supabase
    .from('woocommerce_connections')
    .update({
      consumer_key_encrypted: encryptCredential(consumerKey),
      consumer_secret_encrypted: encryptCredential(consumerSecret),
      key_permissions: keyPermissions,
      store_name: storeInfo.name,
      currency: storeInfo.currency,
      prices_include_tax: storeInfo.prices_include_tax,
      wc_version: storeInfo.wc_version,
      error_message: null,
    })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (stageError || !staged) {
    // The row left 'pending' between lookup and here (superseded, denied on
    // the return leg, or expired by the sweep): nothing to stage against.
    log.error('failed to stage verified credentials', {
      connectionId: pending.id,
      code: stageError?.code,
      message: stageError?.message,
    })
    return NextResponse.json(
      { error: stageError ? 'Staging failed' : 'Unknown or expired state' },
      { status: stageError ? 500 : 404 },
    )
  }

  return staged200()
}

/**
 * The answer WooCommerce needs to redirect the merchant back (any non-200
 * deletes the key it just minted). Nothing is active yet: the store goes
 * live only after the proof of store control.
 */
function staged200(): Response {
  return NextResponse.json({ success: true, activated: false })
}
