import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { hashAuthCode } from '@/lib/auth/oauth-codes'
import {
  exchangeCodeForAccount,
  fetchAccountDisplayName,
} from '@/extensions/general/stripe/lib/connect'

// This route emits stripe.connected (audit trail). ensureInitialized() must
// run at module load so the event_log handler has subscribed before the first
// emit on a cold instance.
ensureInitialized()

/**
 * GET /api/extensions/stripe/callback
 *
 * OAuth callback for Stripe Connect authorization. Must be a real Next.js
 * route (not an extension dispatcher handler) because Stripe redirects the
 * user's browser to this URL directly.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const settingsUrl = `${baseUrl}/settings/payments`

  if (error) {
    const errorMessage = errorDescription || error
    // access_denied is the user cancelling at Stripe: an expected outcome.
    const logDenied = error === 'access_denied' ? console.warn : console.error
    logDenied('[stripe] Connect authorization denied', {
      error,
      error_description: errorDescription,
      has_state: !!state,
    })

    if (state) {
      try {
        const supabase = await createServiceClient()
        await supabase
          .from('stripe_connections')
          .update({ status: 'error', error_message: errorMessage, oauth_state: null })
          .eq('oauth_state', state)
          .eq('status', 'pending')
      } catch (cleanupError) {
        console.error('[stripe] Failed to clean up pending connection:', cleanupError)
      }
    }

    return NextResponse.redirect(
      `${settingsUrl}?stripe_error=${encodeURIComponent(errorMessage)}`,
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(`${settingsUrl}?stripe_error=missing_parameters`)
  }

  const supabase = await createServiceClient()

  try {
    // Locate the connection awaiting this callback by oauth_state (CSRF-safe:
    // the token is a single-use random UUID written before the redirect and
    // cleared below).
    const { data: pendingConnection, error: findError } = await supabase
      .from('stripe_connections')
      .select('id, user_id, company_id')
      .eq('oauth_state', state)
      .eq('status', 'pending')
      .single()

    if (findError || !pendingConnection) {
      console.error('[stripe] No pending connection for oauth_state', {
        findError: findError
          ? { message: findError.message, code: findError.code }
          : null,
        hasCode: !!code,
      })
      return NextResponse.redirect(
        `${settingsUrl}?stripe_error=${encodeURIComponent('invalid_state')}`,
      )
    }

    // Replay protection (OAuth 2.1 §4.1.2): a code may be exchanged once.
    // The PRIMARY KEY on oauth_used_codes rejects a second insert.
    const { error: replayError } = await supabase
      .from('oauth_used_codes')
      .insert({ code_hash: hashAuthCode(code) })
    if (replayError) {
      console.error('[stripe] Authorization code already used', {
        connectionId: pendingConnection.id,
        code: replayError.code,
      })
      return NextResponse.redirect(
        `${settingsUrl}?stripe_error=${encodeURIComponent('invalid_state')}`,
      )
    }

    const { stripeAccountId, livemode } = await exchangeCodeForAccount(code)
    const displayName = await fetchAccountDisplayName(stripeAccountId)

    const { data: updatedConnection, error: updateError } = await supabase
      .from('stripe_connections')
      .update({
        stripe_account_id: stripeAccountId,
        livemode,
        display_name: displayName,
        status: 'active',
        connected_at: new Date().toISOString(),
        error_message: null,
        oauth_state: null, // Clear to prevent replay
      })
      .eq('id', pendingConnection.id)
      .select('id, company_id, user_id, stripe_account_id, livemode')
      .single()

    if (updateError || !updatedConnection) {
      // 23505 = one of the partial unique indexes: this Stripe account is
      // already actively connected (to this or another company), or the
      // company connected in a parallel tab. Both are user-facing conflicts.
      const isConflict = updateError?.code === '23505'
      console.error('[stripe] Failed to activate connection', {
        connectionId: pendingConnection.id,
        error: updateError
          ? { message: updateError.message, code: updateError.code }
          : null,
      })
      await supabase
        .from('stripe_connections')
        .update({
          status: 'error',
          error_message: isConflict
            ? 'Stripe-kontot är redan anslutet till ett företag.'
            : 'Anslutningen kunde inte slutföras.',
          oauth_state: null,
        })
        .eq('id', pendingConnection.id)
      return NextResponse.redirect(
        `${settingsUrl}?stripe_error=${encodeURIComponent(
          isConflict ? 'account_already_connected' : 'activation_failed',
        )}`,
      )
    }

    try {
      await eventBus.emit({
        type: 'stripe.connected',
        payload: {
          connectionId: updatedConnection.id,
          stripeAccountId: updatedConnection.stripe_account_id!,
          livemode: updatedConnection.livemode,
          userId: updatedConnection.user_id,
          companyId: updatedConnection.company_id,
        },
      })
    } catch (emitError) {
      // Non-fatal: the DB state (source of truth) is already committed.
      console.error('[stripe] Failed to emit stripe.connected event', {
        connectionId: updatedConnection.id,
        error: emitError instanceof Error ? emitError.message : String(emitError),
      })
    }

    return NextResponse.redirect(`${settingsUrl}?stripe_connected=true`)
  } catch (error) {
    console.error('[stripe] Callback error', {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      hasCode: !!code,
    })

    try {
      await supabase
        .from('stripe_connections')
        .update({
          status: 'error',
          error_message: 'Anslutningen kunde inte slutföras.',
          oauth_state: null,
        })
        .eq('oauth_state', state)
        .eq('status', 'pending')
    } catch (cleanupError) {
      console.error('[stripe] Callback cleanup failed:', cleanupError)
    }

    return NextResponse.redirect(
      `${settingsUrl}?stripe_error=${encodeURIComponent('connection_failed')}`,
    )
  }
}
