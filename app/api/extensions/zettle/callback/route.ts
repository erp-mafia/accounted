import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { eventBus } from '@/lib/events/bus'
import { hashAuthCode } from '@/lib/auth/oauth-codes'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'
import { encryptCredential } from '@/extensions/general/zettle/lib/credentials'
import { validateReturnOrigin } from '@/extensions/general/zettle/lib/return-origin'
import {
  exchangeCodeForTokens,
  fetchUserSelf,
} from '@/extensions/general/zettle/lib/oauth'

// This route emits zettle.connected (audit trail). ensureInitialized() must
// run at module load so the event_log handler has subscribed before the first
// emit on a cold instance.
ensureInitialized()

/**
 * GET /api/extensions/zettle/callback
 *
 * OAuth callback for Zettle partner authorization. Must be a real Next.js
 * route (not an extension dispatcher handler) because Zettle redirects the
 * user's browser to this URL directly.
 */
export async function GET(request: Request) {
  // Physical route: refuse (503) when the extension is not enabled instead
  // of quietly activating connections for a feature the deployment turned off.
  loadExtensions()
  if (!extensionRegistry.get('zettle')) {
    return NextResponse.json(
      { error: 'Zettle extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const appBase = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')
  // Return the browser to the origin the connect flow started on. Zettle
  // redirects to the one registered callback URL, so a white-label user
  // would otherwise land on the canonical app domain. The stored value is
  // re-validated here (members can update the row through RLS): the app
  // origin or a brand domain, never an arbitrary URL.
  const returnUrlFor = async (origin: string | null | undefined) =>
    `${await validateReturnOrigin(origin, appBase)}/import?mode=zettle`
  let returnUrl = `${appBase}/import?mode=zettle`

  if (error) {
    const errorMessage = errorDescription || error
    const logDenied = error === 'access_denied' ? console.warn : console.error
    logDenied('[zettle] OAuth authorization denied', {
      error,
      error_description: errorDescription,
      has_state: !!state,
    })

    if (state) {
      try {
        const supabase = await createServiceClient()
        const { data: denied } = await supabase
          .from('zettle_connections')
          .update({ status: 'error', error_message: errorMessage, oauth_state: null })
          .eq('oauth_state', state)
          .eq('status', 'pending')
          .select('return_origin')
          .maybeSingle()
        returnUrl = await returnUrlFor(denied?.return_origin)
      } catch (cleanupError) {
        console.error('[zettle] Failed to clean up pending connection:', cleanupError)
      }
    }

    return NextResponse.redirect(
      `${returnUrl}&zettle_error=${encodeURIComponent(errorMessage)}`,
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(`${returnUrl}&zettle_error=missing_parameters`)
  }

  const supabase = await createServiceClient()

  try {
    const { data: pendingConnection, error: findError } = await supabase
      .from('zettle_connections')
      .select('id, user_id, company_id, return_origin')
      .eq('oauth_state', state)
      .eq('status', 'pending')
      .single()

    if (pendingConnection) {
      returnUrl = await returnUrlFor(pendingConnection.return_origin)
    }

    if (findError || !pendingConnection) {
      console.error('[zettle] No pending connection for oauth_state', {
        findError: findError
          ? { message: findError.message, code: findError.code }
          : null,
        hasCode: !!code,
      })
      return NextResponse.redirect(
        `${returnUrl}&zettle_error=${encodeURIComponent('invalid_state')}`,
      )
    }

    const initiator = await requireFlowInitiator(request, pendingConnection.user_id, {
      flow: 'zettle.callback',
    })
    if (!initiator.ok) {
      if (initiator.reason === 'no_session') {
        return initiator.response
      }
      return NextResponse.redirect(
        `${returnUrl}&zettle_error=${encodeURIComponent(FLOW_INITIATOR_MISMATCH_MESSAGE)}`,
      )
    }

    const { error: replayError } = await supabase
      .from('oauth_used_codes')
      .insert({ code_hash: hashAuthCode(code) })
    if (replayError) {
      console.error('[zettle] Authorization code already used', {
        connectionId: pendingConnection.id,
        code: replayError.code,
      })
      return NextResponse.redirect(
        `${returnUrl}&zettle_error=${encodeURIComponent('invalid_state')}`,
      )
    }

    const tokens = await exchangeCodeForTokens(code)
    const userSelf = await fetchUserSelf(tokens.access_token)

    // Require the row still be the original pending state. POST /connect can
    // invalidate this row between lookup and activate; filtering only by id
    // would revive the abandoned flow and attach the wrong Zettle org.
    const { data: updatedConnection, error: updateError } = await supabase
      .from('zettle_connections')
      .update({
        organization_uuid: userSelf.organizationUuid,
        organization_name: null,
        refresh_token_encrypted: encryptCredential(tokens.refresh_token),
        status: 'active',
        connected_at: new Date().toISOString(),
        error_message: null,
        oauth_state: null,
        transaction_sync_enabled: true,
      })
      .eq('id', pendingConnection.id)
      .eq('status', 'pending')
      .eq('oauth_state', state)
      .select('id, company_id, user_id, organization_uuid')
      .maybeSingle()

    if (updateError) {
      const isConflict = updateError.code === '23505'
      console.error('[zettle] Failed to activate connection', {
        connectionId: pendingConnection.id,
        error: { message: updateError.message, code: updateError.code },
      })
      await supabase
        .from('zettle_connections')
        .update({
          status: 'error',
          error_message: isConflict
            ? 'Zettle-organisationen är redan ansluten till ett företag.'
            : 'Anslutningen kunde inte slutföras.',
          oauth_state: null,
          refresh_token_encrypted: null,
        })
        .eq('id', pendingConnection.id)
        .eq('status', 'pending')
      return NextResponse.redirect(
        `${returnUrl}&zettle_error=${encodeURIComponent(
          isConflict ? 'account_already_connected' : 'activation_failed',
        )}`,
      )
    }

    if (!updatedConnection) {
      console.error('[zettle] Pending connection invalidated before activation', {
        connectionId: pendingConnection.id,
      })
      return NextResponse.redirect(
        `${returnUrl}&zettle_error=${encodeURIComponent('invalid_state')}`,
      )
    }

    try {
      await eventBus.emit({
        type: 'zettle.connected',
        payload: {
          connectionId: updatedConnection.id,
          organizationUuid: updatedConnection.organization_uuid!,
          userId: updatedConnection.user_id,
          companyId: updatedConnection.company_id,
        },
      })
    } catch (emitError) {
      console.error('[zettle] Failed to emit zettle.connected event', {
        connectionId: updatedConnection.id,
        error: emitError instanceof Error ? emitError.message : String(emitError),
      })
    }

    return NextResponse.redirect(`${returnUrl}&zettle_connected=true`)
  } catch (error) {
    console.error('[zettle] Callback error', {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      hasCode: !!code,
    })

    try {
      await supabase
        .from('zettle_connections')
        .update({
          status: 'error',
          error_message: 'Anslutningen kunde inte slutföras.',
          oauth_state: null,
        })
        .eq('oauth_state', state)
        .eq('status', 'pending')
    } catch (cleanupError) {
      console.error('[zettle] Callback cleanup failed:', cleanupError)
    }

    return NextResponse.redirect(
      `${returnUrl}&zettle_error=${encodeURIComponent('connection_failed')}`,
    )
  }
}
