import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'
import {
  activateIfComplete,
  HANDSHAKE_EXPIRED_MESSAGE,
  isHandshakeExpired,
} from '@/extensions/general/woocommerce/lib/connect'

// This route can be the leg that activates the row and emits
// woocommerce.connected; the event_log handler must be wired before the first
// emit on a cold instance.
ensureInitialized()

const log = createLogger('woocommerce/return')

// The state is a UUID we generated; anything else cannot match a row (and the
// column is typed uuid, which would error opaquely on a non-UUID filter).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/extensions/woocommerce/return
 *
 * Browser leg of the wc-auth handshake: WooCommerce redirects the merchant
 * here with ?success=1|0&user_id=<our oauth_state>. The credentials arrive on
 * the separate server-to-server callback (usually before this redirect, but
 * ordering is not guaranteed).
 *
 * This leg is the only point in the handshake where a browser session is
 * present, so it is where the completion is bound to the user who started the
 * flow: the callback POST has no cookies (the store calls it) and so can only
 * stage the keys. Confirmation here is the second signal; the row flips to
 * active only when both are present (activateIfComplete, either order).
 *
 * What this binding does and does not give: activation always happens under
 * the initiating user's session (auditable, never headless), and a return
 * completed by a different signed-in user is refused and the keys taken
 * back. It does NOT authenticate the person who approved in wp-admin: the
 * wc-auth redirect carries only success and our own state, and the keys
 * travel server-to-server, so a store admin who approves a link someone else
 * generated still connects their store to that someone's company. Closing
 * that needs a proof of store control from the initiator (follow-up).
 */
export async function GET(request: Request) {
  loadExtensions()
  if (!extensionRegistry.get('woocommerce')) {
    return NextResponse.json(
      { error: 'WooCommerce extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)
  const success = searchParams.get('success')
  const state = searchParams.get('user_id')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  // The WooCommerce surface lives on the import page; the base already has a
  // query, so appended params below must use '&'.
  const returnUrl = `${baseUrl}/import?mode=woocommerce`

  if (success === '1') {
    return completeApproved(request, state, returnUrl)
  }

  // Denied (or malformed): close out the pending row so its state can never
  // complete a late callback, then surface the denial to the panel.
  if (state) {
    try {
      const supabase = await createServiceClient()
      await supabase
        .from('woocommerce_connections')
        .update({
          status: 'error',
          error_message: 'Anslutningen nekades i butiken.',
          oauth_state: null,
          consumer_key_encrypted: null,
          consumer_secret_encrypted: null,
          store_name: null,
          currency: null,
          prices_include_tax: null,
          wc_version: null,
          key_permissions: null,
        })
        .eq('oauth_state', state)
        .eq('status', 'pending')
    } catch (cleanupError) {
      log.error('failed to clean up denied connection', {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
  }

  return NextResponse.redirect(`${returnUrl}&woocommerce_error=denied`)
}

/**
 * The approved leg: find the row this state belongs to, require that the
 * browser completing it is the initiator's, then record the confirmation and
 * activate if the callback has already staged the keys.
 */
async function completeApproved(
  request: Request,
  state: string | null,
  returnUrl: string,
): Promise<Response> {
  const connectedUrl = `${returnUrl}&woocommerce_connected=true`

  if (!state || !UUID_RE.test(state)) {
    // Nothing to bind against. The panel polls /status for the truth, and no
    // row is finalized by this route on its own.
    return NextResponse.redirect(connectedUrl)
  }

  const supabase = await createServiceClient()

  const { data: row, error: findError } = await supabase
    .from('woocommerce_connections')
    .select('id, user_id, status, created_at')
    .eq('oauth_state', state)
    .in('status', ['pending', 'active'])
    .single()

  if (findError || !row) {
    // Already consumed (a re-visit of the return URL), superseded, or unknown:
    // there is nothing left to bind. The panel polls /status for the truth.
    return NextResponse.redirect(connectedUrl)
  }

  const initiator = await requireFlowInitiator(request, row.user_id, {
    flow: 'woocommerce.return',
  })

  if (!initiator.ok) {
    if (initiator.reason === 'no_session') {
      // Session expired mid-handshake: sign in and this route re-runs with
      // the same state. The row is untouched (it still carries the state).
      return initiator.response
    }
    // A different user completed it. The callback POST may already have
    // staged the store's keys (it usually lands before this redirect), so
    // refusing means taking that back: keys wiped, state consumed, row parked
    // in 'error' with the reason, so the late callback finds nothing to
    // stage against either. Rows activated by the pre-gate callback are
    // revoked the same way.
    const { error: revokeError } = await supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: FLOW_INITIATOR_MISMATCH_MESSAGE,
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
        store_name: null,
        currency: null,
        prices_include_tax: null,
        wc_version: null,
        key_permissions: null,
      })
      .eq('id', row.id)
      .in('status', ['pending', 'active'])
    if (revokeError) {
      log.error('failed to revoke connection completed by a non-initiator', {
        connectionId: row.id,
        code: revokeError.code,
        message: revokeError.message,
      })
    }
    return NextResponse.redirect(`${returnUrl}&woocommerce_error=wrong_user`)
  }

  // Initiator confirmed. A row the pre-gate callback already activated has
  // been fully handed over: consume the state so the token cannot be
  // presented again.
  if (row.status === 'active') {
    const { error: consumeError } = await supabase
      .from('woocommerce_connections')
      .update({ oauth_state: null })
      .eq('id', row.id)
      .eq('status', 'active')
    if (consumeError) {
      log.warn('failed to consume oauth_state after handover', {
        connectionId: row.id,
        code: consumeError.code,
        message: consumeError.message,
      })
    }
    return NextResponse.redirect(connectedUrl)
  }

  if (isHandshakeExpired(row.created_at)) {
    await supabase
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
      .eq('id', row.id)
      .eq('status', 'pending')
    return NextResponse.redirect(`${returnUrl}&woocommerce_error=expired`)
  }

  // Record the session-bound confirmation. The state stays on the row until
  // activation: if the callback has not landed yet it still needs it.
  const { error: confirmError } = await supabase
    .from('woocommerce_connections')
    .update({ browser_confirmed_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
  if (confirmError) {
    log.error('failed to record browser confirmation', {
      connectionId: row.id,
      code: confirmError.code,
      message: confirmError.message,
    })
    return NextResponse.redirect(`${returnUrl}&woocommerce_error=failed`)
  }

  const activation = await activateIfComplete(supabase, row.id)

  if (activation.outcome === 'incomplete') {
    // Keys not staged yet: the callback is still in flight (or failed, in
    // which case the row is parked in error and the panel shows why). No
    // "connected" toast; the panel's pending note covers the wait.
    return NextResponse.redirect(returnUrl)
  }

  if (activation.outcome !== 'activated') {
    const isConflict = activation.outcome === 'conflict'
    log.error('failed to activate connection on the return leg', {
      connectionId: row.id,
      code: activation.error.code,
      message: activation.error.message,
    })
    await supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: isConflict
          ? 'Butiken är redan ansluten till ett företag.'
          : 'Anslutningen kunde inte slutföras.',
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
        store_name: null,
        currency: null,
        prices_include_tax: null,
        wc_version: null,
        key_permissions: null,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
    return NextResponse.redirect(
      `${returnUrl}&woocommerce_error=${isConflict ? 'conflict' : 'failed'}`,
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

  return NextResponse.redirect(connectedUrl)
}
