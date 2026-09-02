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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state)
  if (!isUuid || !consumerKey || !consumerSecret) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 })
  }

  const supabase = await createServiceClient()

  const { data: pending, error: findError } = await supabase
    .from('woocommerce_connections')
    .select('id, company_id, user_id, store_url')
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
      .update({ status: 'error', error_message: message, oauth_state: null })
      .eq('id', pending.id)
      .eq('status', 'pending')

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

  const { data: activated, error: updateError } = await supabase
    .from('woocommerce_connections')
    .update({
      consumer_key_encrypted: encryptCredential(consumerKey),
      consumer_secret_encrypted: encryptCredential(consumerSecret),
      key_permissions: keyPermissions,
      store_name: storeInfo.name,
      currency: storeInfo.currency,
      prices_include_tax: storeInfo.prices_include_tax,
      wc_version: storeInfo.wc_version,
      status: 'active',
      connected_at: new Date().toISOString(),
      error_message: null,
      // oauth_state is deliberately KEPT here. This POST is server-to-server
      // (the store calls it, no browser session), so the initiator check has
      // to happen on the browser leg (../return), which locates the row by
      // this same state and consumes it there. Replay is still blocked: both
      // the lookup above and this update are scoped to status 'pending', so
      // an active row can never be activated again.
      // Feed-only product: connecting the store means fetching its orders, so
      // the nightly feed starts on by default; the panel toggle is the opt-out.
      transaction_sync_enabled: true,
    })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id, company_id, user_id, store_url')
    .single()

  if (updateError || !activated) {
    // 23505 = a partial unique index: the store is already actively connected
    // (to this or another company), or the company connected in a parallel tab.
    const isConflict = updateError?.code === '23505'
    log.error('failed to activate connection', {
      connectionId: pending.id,
      code: updateError?.code,
      message: updateError?.message,
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

  return NextResponse.json({ success: true })
}
