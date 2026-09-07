import { UUID_RE } from '@/lib/invariants/uuid'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import {
  encryptCredential,
  isWooCommerceConfigured,
} from '@/extensions/general/woocommerce/lib/credentials'
import { testConnectionAndFetchStoreInfo } from '@/extensions/general/woocommerce/lib/api-client'
import {
  activateIfComplete,
  HANDSHAKE_EXPIRED_MESSAGE,
  isHandshakeExpired,
} from '@/extensions/general/woocommerce/lib/connect'

// This route emits woocommerce.connected (audit trail). ensureInitialized()
// must run at module load so the event_log handler has subscribed before the
// first emit on a cold instance.
ensureInitialized()

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
 * This leg has no browser session, so it can only STAGE the verified keys on
 * the pending row. The row becomes active when the initiator's browser has
 * confirmed on the return leg as well (activateIfComplete, either order).
 * A pending row never syncs, so keys staged for a handshake nobody confirms
 * are inert until the nightly sweep wipes them.
 */
export async function POST(request: Request) {
  loadExtensions()
  if (!extensionRegistry.get('woocommerce')) {
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
    .select('id, company_id, user_id, store_url, created_at, consumer_key_encrypted')
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

  const markError = (message: string) =>
    supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: message,
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
      })
      .eq('id', pending.id)
      .eq('status', 'pending')

  if (isHandshakeExpired(pending.created_at)) {
    log.warn('handshake callback arrived after the TTL', { connectionId: pending.id })
    await markError(HANDSHAKE_EXPIRED_MESSAGE)
    return NextResponse.json({ error: 'Handshake expired' }, { status: 410 })
  }

  // WooCommerce posts once per approval. A second POST for the same state is
  // a replay or a retry of something we already hold: never re-probe or
  // overwrite staged keys on its say-so.
  if (pending.consumer_key_encrypted) {
    log.warn('duplicate handshake callback for a state that already holds keys', {
      connectionId: pending.id,
    })
    return NextResponse.json({ error: 'Credentials already received' }, { status: 409 })
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
      message: probeError instanceof Error ? probeError.message : String(probeError),
    })
    await markError('Nycklarna kunde inte verifieras mot butiken.')
    return NextResponse.json({ error: 'Credential verification failed' }, { status: 502 })
  }

  // Stage the verified keys. Status stays pending: this POST has no browser
  // session, so the initiator binding happens on the return leg, and the row
  // only flips to active once that leg has confirmed too. oauth_state stays
  // until activation so the return leg can still find the row.
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

  const activation = await activateIfComplete(supabase, pending.id)

  if (activation.outcome === 'incomplete') {
    // Browser has not confirmed yet (the usual order: WooCommerce posts here
    // before it redirects the merchant). The return leg finishes the job.
    return NextResponse.json({ success: true, activated: false })
  }

  if (activation.outcome !== 'activated') {
    // 23505 = a partial unique index: the store is already actively connected
    // (to this or another company), or the company connected in a parallel tab.
    const isConflict = activation.outcome === 'conflict'
    log.error('failed to activate connection', {
      connectionId: pending.id,
      code: activation.error.code,
      message: activation.error.message,
    })
    await markError(
      isConflict
        ? 'Butiken är redan ansluten till ett företag.'
        : 'Anslutningen kunde inte slutföras.',
    )
    return NextResponse.json(
      { error: isConflict ? 'Store already connected' : 'Activation failed' },
      { status: isConflict ? 409 : 500 },
    )
  }

  const activated = activation.connection
  try {
    await eventBus.emit({
      type: 'woocommerce.connected',
      payload: {
        connectionId: activated.id,
        storeUrl: activated.store_url,
        userId: activated.user_id,
        companyId: activated.company_id,
      },
    })
  } catch (emitError) {
    // Non-fatal: the DB state (source of truth) is already committed.
    log.error('failed to emit woocommerce.connected', {
      connectionId: activated.id,
      message: emitError instanceof Error ? emitError.message : String(emitError),
    })
  }

  return NextResponse.json({ success: true, activated: true })
}
