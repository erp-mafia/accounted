/**
 * The browser leg of a partner's OAuth code flow (Stripe Connect, Zettle):
 * the one place that turns a pending connection row into an active one.
 *
 * Each partner route was a physical Next.js route with its own copy of this
 * flow, and the copies drifted: Zettle's activation required the row to still
 * be the pending one it found, Stripe's matched the id alone, so a /connect
 * that superseded the row between lookup and activation could be revived by
 * the abandoned callback. Here every write is compare-and-set on the pending
 * row and its oauth_state, so a superseded or already-finished row is never
 * written to.
 *
 * The order of checks is fixed:
 *   1. the extension is enabled (a physical route outlives its extension);
 *   2. a denial or missing parameter ends the flow;
 *   3. the pending row is found by its single-use oauth_state;
 *   4. the completion is bound to the initiator's own session, BEFORE the
 *      code is burned (a different user is refused, an expired session is
 *      sent to sign in and the callback re-runs);
 *   5. the code is burned (oauth_used_codes, OAuth 2.1 4.1.2);
 *   6. the partner's exchange runs, then the conditional activation.
 *
 * WooCommerce is not here: wc-auth delivers its keys server to server and
 * activates when both legs have arrived (woocommerce/lib/connect.ts).
 */
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent } from '@/lib/events/types'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import { hashAuthCode } from '@/lib/auth/oauth-codes'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'

const baseLog = createLogger('partner-oauth-callback')

const ACTIVATION_FAILED_MESSAGE = 'Anslutningen kunde inte slutföras.'

export interface PendingPartnerConnection {
  id: string
  user_id: string
  company_id: string
  [column: string]: unknown
}

export interface PartnerOAuthCallback {
  /** Extension id in the registry, e.g. 'stripe'. */
  extensionId: string
  /** Display name for the 503 answer, e.g. 'Stripe'. */
  displayName: string
  /** Log prefix and query-parameter prefix: `<p>_error`, `<p>_connected`. */
  provider: string
  /** The connections table, with status and oauth_state columns. */
  table: string
  /** Columns the pending lookup selects; must include id, user_id and company_id. */
  pendingColumns: string
  /** Where the browser goes; `row` is the pending row when one was found. */
  returnUrl: (row: Record<string, unknown> | null) => Promise<string>
  /**
   * Redeem the code with the partner and return the columns to write on
   * activation (status, oauth_state and error_message are set here). Throws
   * on any partner failure; the row is then marked failed.
   */
  exchange: (code: string, pending: PendingPartnerConnection) => Promise<Record<string, unknown>>
  /** Columns the activation returns, for the event. */
  activatedColumns: string
  /** error_message when the account is already actively connected (23505). */
  conflictMessage: string
  /** Extra columns cleared when activation fails, e.g. a stored token. */
  clearOnFailure?: Record<string, null>
  /** The connected event, built from the activated row. */
  connectedEvent: (activated: Record<string, unknown>) => CoreEvent
}

export async function completePartnerOAuthCallback(
  request: Request,
  flow: PartnerOAuthCallback,
): Promise<Response> {
  const log = baseLog.child({ provider: flow.provider })
  if (!(await extensionRegistry.get(flow.extensionId))) {
    return NextResponse.json(
      { error: `${flow.displayName} extension is not enabled`, code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  let returnUrl = await flow.returnUrl(null)
  const redirectWith = (param: 'error' | 'connected', value: string) =>
    NextResponse.redirect(`${returnUrl}&${flow.provider}_${param}=${encodeURIComponent(value)}`)

  if (error) {
    const errorMessage = errorDescription || error
    // access_denied is the user cancelling at the partner: an expected outcome.
    const logDenied = error === 'access_denied' ? log.warn.bind(log) : log.error.bind(log)
    logDenied('OAuth authorization denied', {
      error,
      error_description: errorDescription,
      has_state: !!state,
    })

    if (state) {
      try {
        const supabase = await createServiceClient()
        const { data: denied } = await supabase
          .from(flow.table)
          .update({ status: 'error', error_message: errorMessage, oauth_state: null })
          .eq('oauth_state', state)
          .eq('status', 'pending')
          .select(flow.pendingColumns)
          .maybeSingle()
        returnUrl = await flow.returnUrl((denied as Record<string, unknown> | null) ?? null)
      } catch (cleanupError) {
        log.error('Failed to clean up pending connection:', cleanupError)
      }
    }

    return redirectWith('error', errorMessage)
  }

  if (!code || !state) {
    return redirectWith('error', 'missing_parameters')
  }

  const supabase = await createServiceClient()

  try {
    // Located by oauth_state alone: a single-use random token written before
    // the redirect and cleared on every outcome below.
    const { data: found, error: findError } = await supabase
      .from(flow.table)
      .select(flow.pendingColumns)
      .eq('oauth_state', state)
      .eq('status', 'pending')
      .single()
    const pending = found as PendingPartnerConnection | null

    if (pending) {
      returnUrl = await flow.returnUrl(pending)
    }

    if (findError || !pending) {
      log.error('No pending connection for oauth_state', {
        findError: findError ? { message: findError.message, code: findError.code } : null,
        hasCode: !!code,
      })
      return redirectWith('error', 'invalid_state')
    }

    // The state proves the callback belongs to a flow we started, not WHO is
    // completing it: without this a victim lured into approving someone
    // else's flow would attach their partner account to that someone's
    // company. The partner's redirect is a top-level navigation, so the
    // initiator's cookies are present on the legitimate path.
    const initiator = await requireFlowInitiator(request, pending.user_id, {
      flow: `${flow.provider}.callback`,
    })
    if (!initiator.ok) {
      if (initiator.reason === 'no_session') {
        // Session expired mid-flow: sign in and the callback re-runs with the
        // same, still unused, code and state. The row is untouched.
        return initiator.response
      }
      // A different user completed it: refused without exchanging the code
      // and without marking the row, which stays pending for its initiator.
      return redirectWith('error', FLOW_INITIATOR_MISMATCH_MESSAGE)
    }

    // A code may be exchanged once: the primary key rejects a second insert.
    const { error: replayError } = await supabase
      .from('oauth_used_codes')
      .insert({ code_hash: hashAuthCode(code) })
    if (replayError) {
      log.error('Authorization code already used', {
        connectionId: pending.id,
        code: replayError.code,
      })
      return redirectWith('error', 'invalid_state')
    }

    const activationFields = await flow.exchange(code, pending)

    // Compare-and-set: the row must still be the pending one carrying this
    // state. A /connect that superseded it between lookup and here clears
    // its oauth_state, and matching the id alone would revive the abandoned
    // flow with the wrong partner account.
    const { data: activated, error: updateError } = await supabase
      .from(flow.table)
      .update({
        ...activationFields,
        status: 'active',
        error_message: null,
        oauth_state: null,
      })
      .eq('id', pending.id)
      .eq('status', 'pending')
      .eq('oauth_state', state)
      .select(flow.activatedColumns)
      .maybeSingle()

    if (updateError) {
      // 23505 = one of the partial unique indexes: this partner account is
      // already actively connected (to this or another company), or the
      // company connected in a parallel tab. Both are user-facing conflicts.
      const isConflict = updateError.code === '23505'
      log.error('Failed to activate connection', {
        connectionId: pending.id,
        error: { message: updateError.message, code: updateError.code },
      })
      await supabase
        .from(flow.table)
        .update({
          status: 'error',
          error_message: isConflict ? flow.conflictMessage : ACTIVATION_FAILED_MESSAGE,
          oauth_state: null,
          ...(flow.clearOnFailure ?? {}),
        })
        .eq('id', pending.id)
        .eq('status', 'pending')
      return redirectWith('error', isConflict ? 'account_already_connected' : 'activation_failed')
    }

    if (!activated) {
      log.error('Pending connection invalidated before activation', {
        connectionId: pending.id,
      })
      return redirectWith('error', 'invalid_state')
    }

    try {
      await eventBus.emit(flow.connectedEvent(activated as unknown as Record<string, unknown>))
    } catch (emitError) {
      // Non-fatal: the row (the source of truth) is already committed.
      log.error('Failed to emit the connected event', {
        connectionId: pending.id,
        error: emitError instanceof Error ? emitError.message : String(emitError),
      })
    }

    return redirectWith('connected', 'true')
  } catch (caught) {
    log.error('Callback error', {
      message: caught instanceof Error ? caught.message : String(caught),
      name: caught instanceof Error ? caught.name : undefined,
      hasCode: !!code,
    })

    try {
      await supabase
        .from(flow.table)
        .update({
          status: 'error',
          error_message: ACTIVATION_FAILED_MESSAGE,
          oauth_state: null,
        })
        .eq('oauth_state', state)
        .eq('status', 'pending')
    } catch (cleanupError) {
      log.error('Callback cleanup failed:', cleanupError)
    }

    return redirectWith('error', 'connection_failed')
  }
}
