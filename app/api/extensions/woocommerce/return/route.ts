import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'

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
 * ordering is not guaranteed); the panel polls /status until the row is
 * active.
 *
 * This leg is the only point in the handshake where a browser session is
 * present, so it is where the completion is bound to the user who started the
 * flow: the callback POST has no cookies (the store calls it) and so leaves
 * the oauth_state on the row for this route to verify against and consume.
 * Without that binding a victim lured into approving a connect someone else
 * started would have their store's orders flowing into that someone's books.
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
 * browser completing it is the initiator's, then either hand the row over
 * (consume the state) or take back what the callback stored.
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
    .select('id, user_id, status')
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
    // activated the row with the store's keys (it usually lands before this
    // redirect), so refusing means taking that back: keys wiped, state
    // consumed, row parked in 'error' with the reason. A still-pending row is
    // closed the same way so the late callback finds nothing to activate.
    const { error: revokeError } = await supabase
      .from('woocommerce_connections')
      .update({
        status: 'error',
        error_message: FLOW_INITIATOR_MISMATCH_MESSAGE,
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
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

  // Initiator confirmed. An active row has been fully handed over: consume the
  // state so the token cannot be presented again. A pending row keeps it: the
  // callback POST has not landed yet and still needs it to find the row.
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
  }

  return NextResponse.redirect(connectedUrl)
}
