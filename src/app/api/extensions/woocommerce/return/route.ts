import { UUID_RE } from '@/lib/invariants/uuid'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'
import {
  HANDSHAKE_EXPIRED_MESSAGE,
  isHandshakeExpired,
} from '@/extensions/general/woocommerce/lib/connect'

const log = createLogger('woocommerce/return')

/**
 * GET /api/extensions/woocommerce/return
 *
 * Browser leg of the wc-auth handshake: WooCommerce redirects the merchant
 * here with ?success=1|0&user_id=<our oauth_state>, after it has posted the
 * keys to the server-to-server callback.
 *
 * This leg activates nothing. The redirect carries only the success flag and
 * our own state, both of which the initiator already holds in the authorize
 * URL, so it cannot tell whether the store's own admin approved. On success
 * it sends the initiator to the panel, where the store goes live once they
 * prove control of it by typing the key's last characters (POST
 * /verify-store, lib/connect). It still closes what it can: a denial, a
 * return completed by a different signed-in user (refused, keys taken back)
 * and a handshake past its TTL.
 */
export async function GET(request: Request) {
  if (!(await extensionRegistry.get('woocommerce'))) {
    return NextResponse.json(
      { error: 'WooCommerce extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)
  const success = searchParams.get('success')
  const state = searchParams.get('user_id')

  // The store redirected the browser to the origin the connect started on
  // (buildAuthorizeUrl), where the session lives. Send the panel redirect to
  // that same host, validated against the brands table; an unknown host or
  // a failed lookup collapses to the canonical app URL.
  const baseUrl = await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' })
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
 * browser completing it is the initiator's, then hand them to the panel for
 * the proof of store control.
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

  // Approved in the store, which proves nothing about who approved. No
  // "connected" toast: the panel asks the initiator for the proof of store
  // control, and the store goes live only when it matches. The row and its
  // state are left as they are.
  return NextResponse.redirect(returnUrl)
}
