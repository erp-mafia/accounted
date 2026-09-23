import { randomBytes } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, after } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'
import { createSession, extractBban, type AccountInfo } from '@/extensions/general/enable-banking/lib/api-client'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'
import { isMirrorCardAccount } from '@/extensions/general/enable-banking/lib/mirror-card-account'
import { eventBus } from '@/lib/events/bus'
import {
  resolvePsd2LedgerAccount,
  normalizeIban,
} from '@/lib/cash-accounts/service'
import {
  fanOutSessionRenewal,
  fetchCrossCompanyAccountContext,
} from '@/extensions/general/enable-banking/lib/session-sharing'
import { finishBankSupersession } from '@/extensions/general/enable-banking/lib/supersede'
import { revokeUnusedSession } from '@/extensions/general/enable-banking/lib/session-revocation'
import { readBankCallbackConfiguration, finalizeBankCallback, type BankMirrorPlan } from '@/lib/cash-accounts/configuration'
import { classifyBankConnectionDenial, getBankConnectionErrorMessage } from '@/lib/errors/get-error-message'
import { renderFinalizeShell, renderFinalizeRedirect } from './finalize-page'
import { isConnectorState, verifyConnectorState } from '@/lib/connect/hosted/state'
import { getCanonicalAppOrigin, resolveTrustedAppOrigin } from '@/lib/domains/trusted-app-origin'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'

// This route emits bank_connection.consent_granted / .finalize_failed
// (ASVS V16 / GDPR Art.30 audit events). ensureInitialized() must run at module
// load so registerEventLogHandler() has subscribed before the first emit();
// otherwise the audit row is silently dropped on a cold instance where this
// redirect route is the first event-emitting code path to execute.
ensureInitialized()

// Structured logger for audit-trail failures (ISO 27001 A.8.15): a failed
// audit-event emission must be visible to log-based alerting, not just a raw
// console line. The stable message below is what monitoring keys on.
const log = createLogger('enable-banking/callback')
const AUDIT_EMIT_FAILED = 'audit event emit failed'

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>

interface PendingConnection {
  id: string
  user_id: string
  company_id: string
  bank_name: string | null
  status: string
  /**
   * The session being replaced, captured before the update overwrites it, so a
   * renewal can be carried to sibling companies sharing it (see
   * lib/session-sharing.ts). Null on a first-time connect.
   */
  session_id: string | null
  /**
   * The accounts the row held BEFORE this callback overwrites them, so the
   * dedup scope each account was first ingested under survives an in-place
   * reconnect (several ASPSPs mint new uids on re-authorization).
   * Null on a first-time connect.
   */
  accounts_data: StoredAccount[] | null
}

// Shown in the settings banner when the session exchange/finalize fails.
// User-facing, so Swedish (the raw upstream error is in the server log).
const FINALIZE_FAILED_MESSAGE =
  'Anslutningen kunde inte slutföras. Försök igen om en stund.'

/**
 * GET /api/extensions/enable-banking/callback
 *
 * OAuth callback for Enable Banking PSD2 authorization.
 * Must be a real Next.js route (not extension handler) because
 * banks redirect to this URL directly.
 *
 * Fast outcomes (bank denial, bad params, unknown state) respond with a
 * classic 307. The success path instead streams an interim "Slutför
 * bankanslutningen" page while the slow work runs (session exchange with
 * Enable Banking, cash-account mirroring), then streams a client-side
 * redirect: without this the user stares at a blank tab for several seconds,
 * which reads as a failed connection and provokes duplicate retries.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state') // Cryptographic oauth_state token
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')
  // Present in connector mode only: the hosted callback echoes the signed
  // connector state back to this instance so createSession can bind the proxy's
  // /sessions exchange to the pending ledger row. Null on the direct path.
  const connectorState = searchParams.get('connector_state')

  // Redirects issued before a pending row is known go to the canonical host
  // (the only one the provider ever sends the browser to). Once the row is
  // found, its recorded initiating origin takes over: see returnOrigin below.
  const baseUrl = getCanonicalAppOrigin()

  // Connector branch: a self-hosted instance started this authorization through
  // the /api/connect/bank proxy, which replaced the upstream state with a
  // signed connector state carrying the instance's own return URL. We never
  // create a session here (the instance does, through the proxy): we just
  // bounce the browser back to the instance with the code + its original
  // state, so no per-instance redirect URI has to be registered with EB.
  if (isConnectorState(state)) {
    const verified = verifyConnectorState(state as string)
    if (!verified.ok || verified.payload.svc !== 'bank') {
      return NextResponse.redirect(`${baseUrl}/?connector_error=${encodeURIComponent(verified.ok ? 'wrong_service' : verified.reason)}`)
    }
    const ret = new URL(verified.payload.ret)
    if (error) ret.searchParams.set('error', error)
    if (errorDescription) ret.searchParams.set('error_description', errorDescription)
    if (code) ret.searchParams.set('code', code)
    if (verified.payload.st) ret.searchParams.set('state', verified.payload.st)
    // Echo the signed connector state so the instance can present it back to
    // the proxy's POST /sessions (which finds the pending ledger row by it).
    ret.searchParams.set('connector_state', state as string)
    return NextResponse.redirect(ret.toString())
  }

  if (error) {
    // Swedish user-facing message carrying the underlying provider error; the
    // raw code/description stays in the log lines and the audit event below.
    // Previously the raw provider text was passed through verbatim, which
    // gave a stuck user nothing to act on (issue #1716).
    const userMessage = getBankConnectionErrorMessage(error, errorDescription)
    // A cancel at the bank is an expected outcome, not a runtime error. The
    // same classifier decides the user message, so "Invalid credentials"
    // (a missing fullmakt) and "cannot retrieve account information" stay
    // at error level instead of hiding among the cancels.
    const denialReason = classifyBankConnectionDenial(error, errorDescription)
    const isUserCancel = denialReason === 'cancelled'
    const logDenied = isUserCancel ? console.warn : console.error
    logDenied('[enable-banking] Bank authorization denied', {
      error,
      error_description: errorDescription,
      has_state: !!state,
    })

    // Clean up the pending bank_connections row so it doesn't accumulate
    if (state) {
      try {
        const supabase = await createServiceClient()

        // Fetch connection details for logging before updating. Match by
        // oauth_state across pending/expired/error so an in-place reconnect
        // (which stays 'expired' during the round-trip) is also handled.
        const { data: pendingConn } = await supabase
          .from('bank_connections')
          .select('id, user_id, company_id, bank_name, psu_type, status, oauth_origin')
          .eq('oauth_state', state)
          .in('status', ['pending', 'expired', 'error'])
          .single()

        if (pendingConn) {
          logDenied('[enable-banking] Authorization denied details', {
            connection_id: pendingConn.id,
            user_id: pendingConn.user_id,
            bank_name: pendingConn.bank_name,
            error_code: error,
            error_description: errorDescription,
          })

          if (pendingConn.status === 'pending') {
            // Fresh connect that never became a connection: delete the row
            // instead of parking it in 'error'. A parked row renders forever
            // as an "Åtgärd krävs" card, so a failed attempt followed by a
            // successful retry showed up as two connections to the same bank.
            // The ?bank_error banner below is the actual failure feedback.
            await supabase
              .from('bank_connections')
              .delete()
              .eq('id', pendingConn.id)
              .eq('company_id', pendingConn.company_id)
              .eq('oauth_state', state)
              .eq('status', 'pending')
          } else {
            // Reconnect of an established connection: keep the row (it holds
            // accounts/transactions history) and surface the failure on it.
            // If the bank reports a session-expiry during authorization
            // itself, mark it 'expired' (not generic 'error') so the settings
            // panel surfaces the reconnect button rather than a dead-end
            // error state.
            const isSessionExpiry = /session.?expired|expired.?session|closed.?session|session.?closed|invalid.?session|session.?not.?found/i.test(
              `${error} ${errorDescription ?? ''}`
            )

            await supabase
              .from('bank_connections')
              .update({ status: isSessionExpiry ? 'expired' : 'error', error_message: userMessage, oauth_state: null })
              .eq('id', pendingConn.id)
              .eq('company_id', pendingConn.company_id)
              .eq('oauth_state', state)
              .in('status', ['pending', 'expired', 'error'])
          }

          // Durable audit trail for the failed attempt (issue #1716): the
          // fresh-connect row was just deleted and console logs expire, so
          // event_log is the only place support can later see which attempt
          // failed with which provider error.
          try {
            await eventBus.emit({
              type: 'bank_connection.consent_denied',
              payload: {
                connectionId: pendingConn.id,
                bankName: pendingConn.bank_name ?? null,
                psuType: pendingConn.psu_type ?? null,
                errorCode: error,
                errorDescription: errorDescription ?? null,
                priorStatus: pendingConn.status,
                userId: pendingConn.user_id,
                companyId: pendingConn.company_id,
              },
            })
          } catch (emitError) {
            log.error(AUDIT_EMIT_FAILED, emitError as Error, {
              eventType: 'bank_connection.consent_denied',
              connectionId: pendingConn.id,
            })
          }

          // Include bank name, error code, psu_type and the denial reason in
          // the redirect so the UI can render targeted guidance (the
          // Handelsbanken corporate fullmakt steps on server_error or an
          // invalid-credentials denial for a business connect, the PSU-type
          // retry only on a real cancel).
          const params = new URLSearchParams({
            bank_error: userMessage,
            ...(pendingConn.bank_name ? { bank_name: pendingConn.bank_name } : {}),
            bank_error_code: error,
            ...(denialReason ? { bank_error_reason: denialReason } : {}),
            ...(pendingConn.psu_type ? { psu_type: pendingConn.psu_type } : {}),
          })
          // Back to the host the user started on: the denial banner is only
          // visible where their session is (a white-label user has none on
          // the canonical host and would be bounced to its login instead).
          return NextResponse.redirect(
            `${await resolveTrustedAppOrigin(pendingConn.oauth_origin, { onLookupFailure: 'canonical' })}/settings/banking?${params.toString()}`
          )
        }
      } catch (cleanupError) {
        console.error('[enable-banking] Failed to clean up pending bank connection:', cleanupError)
      }
    }

    return NextResponse.redirect(
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent(userMessage)}`
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent(getBankConnectionErrorMessage('missing_parameters'))}`
    )
  }

  // Validate authorization code format
  const codePattern = /^[a-zA-Z0-9._~+\/-]{8,2048}$/
  if (!codePattern.test(code)) {
    return NextResponse.redirect(
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent(getBankConnectionErrorMessage('invalid_code_format'))}`
    )
  }

  const supabase = await createServiceClient()

  // Look up the connection awaiting this callback by oauth_state (CSRF-safe).
  // oauth_state is a single-use random token cleared after use, so it uniquely
  // identifies the row regardless of status. Accept 'expired'/'error' too: an
  // in-place reconnect keeps the row in 'expired' during the round-trip (so
  // the nightly stale-'pending' cleanup can't delete an established row).
  // This lookup is fast, so it runs BEFORE the streamed response: an unknown
  // state stays a plain redirect.
  const { data: pendingConnection, error: findError } = await supabase
    .from('bank_connections')
    .select('id, user_id, company_id, bank_name, status, session_id, accounts_data, oauth_origin')
    .eq('oauth_state', state)
    .in('status', ['pending', 'expired', 'error'])
    .single()

  if (findError || !pendingConnection) {
    console.error('[enable-banking] No pending connection for oauth_state', {
      findError: findError ? { message: findError.message, code: findError.code, details: findError.details } : null,
      state,
      hasCode: !!code,
    })
    return NextResponse.redirect(
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent(getBankConnectionErrorMessage('invalid_state'))}`
    )
  }

  // The state token proves this callback belongs to a flow we started; it
  // says nothing about WHO is completing it. Bind the completion to the
  // initiator's own cookie session before any finalize work: otherwise a
  // victim lured into approving a consent someone else started would have
  // their bank accounts attached to that someone's company. The connector
  // branch above is exempt on purpose (server-to-server, HMAC-verified).
  // The initiator's session lives on the host they started from (cookies are
  // per host) while Enable Banking always redirects to the canonical callback.
  // A white-label user therefore arrives signed out. From here on every
  // redirect, including the login bounce that re-runs this callback with the
  // same code + state, goes to the recorded initiating origin: their brand
  // host already holds the session, so its login page forwards straight back
  // here and the callback completes with cookies. Validated against the
  // brands table; an unregistered or missing origin collapses to the
  // canonical host, and so does a failed lookup (no token rides in this
  // redirect, and a 500 mid-callback would strand the user).
  const returnOrigin = await resolveTrustedAppOrigin(pendingConnection.oauth_origin, {
    onLookupFailure: 'canonical',
  })

  const initiator = await requireFlowInitiator(request, pendingConnection.user_id, {
    flow: 'enable-banking.callback',
    returnOrigin,
  })
  if (!initiator.ok) {
    if (initiator.reason === 'no_session') {
      // Session expired mid-flow: sign in and the callback re-runs with the
      // same code + state. Nothing on the row changes.
      return initiator.response
    }
    // A different user completed it. Refuse without exchanging the code and
    // without touching the row: it keeps waiting for its initiator and the
    // stale-pending cleanup reaps it if nobody comes back.
    const params = new URLSearchParams({
      bank_error: FLOW_INITIATOR_MISMATCH_MESSAGE,
      ...(pendingConnection.bank_name ? { bank_name: pendingConnection.bank_name } : {}),
    })
    return NextResponse.redirect(`${returnOrigin}/settings/banking?${params.toString()}`)
  }

  // Kick the finalize work off eagerly, decoupled from the response stream:
  // if the user closes the tab mid-stream, the stream is cancelled but this
  // promise keeps running, so the session persistence, cash-account mirror
  // and consent_granted audit emit are not lost (ASVS V16). Never rejects:
  // failures resolve to the cleanup redirect target.
  const finalizePromise = (async (): Promise<string> => {
    try {
      return await finalizeConnection(supabase, pendingConnection, code, connectorState, state)
    } catch (finalizeError) {
      const reason =
        finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
      console.error('[enable-banking] Callback error', {
        message: reason,
        stack: finalizeError instanceof Error ? finalizeError.stack : undefined,
        name: finalizeError instanceof Error ? finalizeError.name : undefined,
        connectionId: pendingConnection.id,
      })
      // Durable audit trail (issue #1716): the fresh-connect row is deleted by
      // the cleanup below and console logs expire, so event_log is the only
      // place support can later see that this attempt failed and why.
      try {
        await eventBus.emit({
          type: 'bank_connection.finalize_failed',
          payload: {
            connectionId: pendingConnection.id,
            bankName: pendingConnection.bank_name ?? null,
            reason,
            priorStatus: pendingConnection.status,
            userId: pendingConnection.user_id,
            companyId: pendingConnection.company_id,
          },
        })
      } catch (emitError) {
        log.error(AUDIT_EMIT_FAILED, emitError as Error, {
          eventType: 'bank_connection.finalize_failed',
          connectionId: pendingConnection.id,
        })
      }
      return cleanupFailedFinalize(supabase, pendingConnection, state)
    }
  })()

  // Keep the serverless function alive until the finalize work settles even
  // if the client disconnects and the platform considers the response done.
  try {
    after(() => finalizePromise.then(() => undefined))
  } catch {
    // Outside a request scope (unit tests, plain node server): the stream's
    // own await below still drives the promise to completion.
  }

  // Per-request CSP nonce for the two inline scripts on the finalize page
  // (ASVS V3.3): mirrors the mcp-oauth consent page. The global next.config
  // CSP also applies; the intersection means inline scripts on THIS response
  // must carry the nonce.
  const cspNonce = randomBytes(16).toString('base64')
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  // Stream: flush the branded "Slutför bankanslutningen" shell immediately,
  // await the finalize work, then stream a client-side redirect to the
  // outcome URL. The user sees progress from the first byte instead of a
  // blank tab.
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(renderFinalizeShell(pendingConnection.bank_name, cspNonce)))
      const targetPath = await finalizePromise
      try {
        controller.enqueue(encoder.encode(renderFinalizeRedirect(`${returnOrigin}${targetPath}`, cspNonce)))
        controller.close()
      } catch {
        // Stream already cancelled (client closed the tab). The finalize
        // work above completed regardless; there is just no one to redirect.
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      // The body carries a one-time OAuth outcome: never cache, never buffer
      // (X-Accel-Buffering opts out of proxy buffering so the shell chunk
      // actually reaches the browser before the work finishes).
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * The slow part of the callback: exchange the authorization code for a PSD2
 * session, persist the account metadata, mirror accounts into cash_accounts,
 * and emit the audit event. Returns the app-relative redirect target.
 * Extracted so the route can run it behind the streamed progress page.
 */
async function finalizeConnection(
  supabase: ServiceClient,
  pendingConnection: PendingConnection,
  code: string,
  connectorState: string | null,
  oauthState: string,
): Promise<string> {
  const snapshot = await readBankCallbackConfiguration(supabase, pendingConnection.company_id,
    pendingConnection.user_id, pendingConnection.id, oauthState)
  pendingConnection = { ...pendingConnection, ...snapshot.connection,
    accounts_data: snapshot.connection.accounts_data as StoredAccount[] }

  const userId = pendingConnection.user_id

  console.log('[enable-banking] Exchanging code for session', {
    connectionId: pendingConnection.id,
    userId,
    codeLength: code.length,
  })

  const sessionData = await createSession(code, connectorState ?? undefined)
  try {
    return await persistBankSession(supabase, pendingConnection, sessionData, oauthState, snapshot.token)
  } catch (error) {
    // A lost RPC response may still mean the transaction committed. The
    // all-holder claim refuses cleanup of a session now in use anywhere.
    try {
      await revokeUnusedSession(supabase, sessionData.session_id)
    } catch {
      log.warn('unused callback consent cleanup was not confirmed', { connectionId: pendingConnection.id })
    }
    throw error
  }
}

async function persistBankSession(
  supabase: ServiceClient, pendingConnection: PendingConnection,
  sessionData: Awaited<ReturnType<typeof createSession>>, oauthState: string, expectedToken: string,
): Promise<string> {
  const userId = pendingConnection.user_id
  const { session_id, accounts, access } = sessionData
  const consentExpiresAt = access.valid_until

  console.log('[enable-banking] Session created successfully', {
    connectionId: pendingConnection.id,
    sessionId: '[REDACTED]',
    accountCount: accounts.length,
    consentExpiresAt,
  })

  // GDPR Art.5(1)(c) / Art.25(1): data minimization. We only store the
  // metadata the user needs to pick which accounts to sync (uid, name, IBAN,
  // currency). Balances are bank account financial data: we don't fetch
  // them here. The first sync (after the user enables specific accounts)
  // populates balance + balance_updated_at via lib/sync.ts. Accounts the
  // user deselects never have their balance pulled.
  const priorAccounts = pendingConnection.accounts_data ?? []
  const priorByNewUid = new Map<string, StoredAccount>()
  const compatible = (prior: { currency: string; iban?: string | null }, current: { currency: string; iban?: string | null }) =>
    prior.currency.toUpperCase() === current.currency.toUpperCase() &&
    (!normalizeIban(prior.iban) || !normalizeIban(current.iban) || normalizeIban(prior.iban) === normalizeIban(current.iban))
  const accountsMetadata: StoredAccount[] = accounts.map((account: AccountInfo) => {
    const iban = normalizeIban(account.account_id?.iban)
    const currency = account.currency.toUpperCase()
    let prior = priorAccounts.find(p => p.uid === account.uid && compatible(p, { currency, iban }))
    if (!prior && iban) {
      const matches = priorAccounts.filter(p => p.currency.toUpperCase() === currency && normalizeIban(p.iban) === iban)
      if (matches.length > 1) throw new Error('Bank callback identity ambiguous')
      prior = matches[0]
    }
    if (prior) priorByNewUid.set(account.uid, prior)
    return {
      uid: account.uid, iban: account.account_id?.iban ?? prior?.iban, bban: extractBban(account),
      name: account.name || account.product, currency, enabled: prior?.enabled !== false,
      dedup_scope: prior?.dedup_scope || normalizeIban(prior?.iban) || prior?.uid || iban || account.uid,
    }
  })
  // Pair retired no-IBAN resources only when exactly one unmatched account
  // remains on each side in that currency. Never guess between two cards.
  const pairedPriorUidByNewUid = new Map<string, string>()
  const matchedPriorUids = new Set([...priorByNewUid.values()].map(p => p.uid))
  for (const account of accountsMetadata) {
    if (priorByNewUid.has(account.uid) || normalizeIban(account.iban)) continue
    const old = priorAccounts.filter(p => !matchedPriorUids.has(p.uid) && p.currency.toUpperCase() === account.currency)
    const fresh = accountsMetadata.filter(a => !priorByNewUid.has(a.uid) && a.currency === account.currency)
    if (old.length !== 1 || fresh.length !== 1 || normalizeIban(old[0].iban)) continue
    const prior = old[0]
    account.dedup_scope = prior.dedup_scope || prior.uid
    account.enabled = prior.enabled !== false
    pairedPriorUidByNewUid.set(account.uid, prior.uid)
    priorByNewUid.set(account.uid, prior)
    matchedPriorUids.add(prior.uid)
  }

  // Cross-company guard: at one-session banks (SEB) the PSU's single consent
  // can cover accounts another of the user's companies already books. The
  // deliberate reuse path (findReusableSessions) never offers a claimed IBAN,
  // but this callback used to trust the session wholesale: a connect performed
  // under company B stored company A's accounts pre-enabled and mirrored them
  // into B's cash_accounts, one "Spara val" away from booking A's transactions
  // in B's ledger. Accounts claimed elsewhere are stored disabled + flagged
  // (the picker names the claiming company) and skipped by the mirror below.
  // Accounts this row itself carried before keep their own state: the active
  // company's standing choice outranks a sibling's claim, so a renewal can
  // never switch a working feed off.
  const crossCompany = await fetchCrossCompanyAccountContext(
    supabase,
    userId,
    pendingConnection.company_id,
    pendingConnection.id,
  )
  // Every account the guard itself disabled, whatever the branch. These are
  // excluded from the cash_accounts mirror below: mirroring enabled:false for
  // a new-to-row account can PROMOTE an existing manual holder (the seeded
  // primary 1930 included) and flip it to disabled with a foreign identity,
  // and a claimed account's row would double-claim the IBAN besides. The
  // selection save allocates + mirrors any of them the user turns on.
  const guardDisabledUids = new Set<string>()
  let claimedCount = 0
  for (const account of accountsMetadata) {
    const normalizedIban = normalizeIban(account.iban)
    // Row-local memory only. The active company's standing state on OTHER
    // rows (a bank-list renewal arrives on a fresh row while the old row is
    // waiting to be superseded) is already folded into crossCompany:
    // activeCompanyIbans outrank claims and deselections there, so such
    // accounts fall through to the enabled default below.
    const seenOnThisRow = priorByNewUid.has(account.uid)
    if (seenOnThisRow) {
      // The carried enabled/disabled state stands. The claim label is
      // metadata on top of it: accountsMetadata is rebuilt without the prior
      // flags, so without this an in-place renewal would drop the label and
      // the picker would list the sibling's accounts as plain unchecked own
      // accounts again. Re-stamp it only on an account that stays disabled
      // here (an enabled one is the active company's standing state, which
      // outranks any claim), and only from a fresh lookup, never from the
      // stale prior flag.
      if (account.enabled === false && crossCompany !== null) {
        const claim = normalizedIban ? crossCompany.claims.get(normalizedIban) : undefined
        if (claim) {
          account.claimed_by_company_id = claim.companyId
          if (claim.companyName) account.claimed_by_company_name = claim.companyName
          // Keep it out of the cash_accounts mirror too: the first connect
          // never mirrored it (see guardDisabledUids below), and mirroring
          // it now would plant the sibling's IBAN in this company's routing
          // table and burn a 19xx slot for an account that stays off.
          guardDisabledUids.add(account.uid)
          claimedCount += 1
        }
      }
      // Preserve the explanation while it stays disabled. Existing own
      // mirrors are re-keyed later; an unmirrored card stays unmirrored.
      if (account.enabled === false && isMirrorCardAccount(account)) {
        account.mirror_card_account = true
        guardDisabledUids.add(account.uid)
      }
      continue
    }

    if (isMirrorCardAccount(account)) {
      // Known card sub-account that only mirrors the main account (Svea's
      // BOKIO_Debit_Business, issue #2565): every purchase already arrives on
      // the main account, and this one adds an opposite-sign, description-
      // less twin per purchase that can be neither booked nor deleted. Off by
      // default, flagged so the picker says why; the user can still turn it
      // on. Checked before the IBAN-keyed guards below, which a no-IBAN
      // account would fall through anyway.
      account.enabled = false
      account.mirror_card_account = true
      guardDisabledUids.add(account.uid)
      continue
    }

    if (crossCompany === null) {
      // Fail closed: without the claim set a free account cannot be told from
      // one another company books, and pre-checking a claimed account is the
      // one outcome this guard must never produce. The user just re-ticks.
      account.enabled = false
      guardDisabledUids.add(account.uid)
      continue
    }
    const claim = normalizedIban ? crossCompany.claims.get(normalizedIban) : undefined
    if (claim) {
      account.enabled = false
      account.claimed_by_company_id = claim.companyId
      if (claim.companyName) account.claimed_by_company_name = claim.companyName
      guardDisabledUids.add(account.uid)
      claimedCount += 1
      continue
    }
    if (normalizedIban && crossCompany.deselectedIbans.has(normalizedIban)) {
      // The user already said "Synkas ej" to this account on another
      // connection row: a fresh row must not resurrect it pre-checked. The
      // flag makes the picker say so; an unexplained unchecked box reads as
      // a glitch and a silent one hides a sync gap.
      account.enabled = false
      account.deselected_elsewhere = true
      guardDisabledUids.add(account.uid)
    }
  }
  if (crossCompany === null) {
    log.error('cross-company claim lookup failed: storing new accounts deselected', {
      connectionId: pendingConnection.id,
    })
  } else if (claimedCount > 0) {
    log.warn('session covers accounts claimed by sibling companies', {
      connectionId: pendingConnection.id,
      companyId: pendingConnection.company_id,
      claimedCount,
      accountCount: accountsMetadata.length,
    })
  }

  // Preparation performs reads only. Every chart row, consent change and
  // intended mirror is applied by the finalizer under one company lock.
  const { data: mirroredRows, error: mirrorReadError } = await supabase
    .from('cash_accounts')
    .select('id, external_uid, ledger_account, iban, currency')
    .eq('company_id', pendingConnection.company_id)
    .eq('bank_connection_id', pendingConnection.id)
  if (mirrorReadError) throw Object.assign(new Error(mirrorReadError.message), { code: mirrorReadError.code })
  type Mirror = { id: string; external_uid: string | null; ledger_account: string; iban: string | null; currency: string }
  const mirroredByUid = new Map((mirroredRows as Mirror[] ?? []).map(row => [row.external_uid, row]))
  const ownRows = new Map<string, Mirror>()
  for (const account of accountsMetadata) {
    const prior = priorByNewUid.get(account.uid)
    const row = mirroredByUid.get(prior?.uid ?? account.uid)
    if (row && compatible(row, account)) ownRows.set(account.uid, row)
  }
  const assignedLedgers = new Set([...ownRows.values()].map(row => row.ledger_account))
  const mirrors: BankMirrorPlan[] = []
  for (const account of accountsMetadata) {
    const own = ownRows.get(account.uid)
    // Guard-disabled new accounts must never promote the manual primary.
    // Existing own mirrors still follow a safe UID change while disabled.
    if (guardDisabledUids.has(account.uid) && !own) continue
    const resolved = own ? { ledgerAccount: own.ledger_account, reuseCashAccountId: own.id }
      : await resolvePsd2LedgerAccount(supabase, pendingConnection.company_id, userId, {
        iban: account.iban, currency: account.currency, accountName: account.name,
        exclude: assignedLedgers, prepareOnly: true,
      })
    if (!resolved) throw new Error('Bank callback ledger allocation failed')
    account.ledger_account = resolved.ledgerAccount
    assignedLedgers.add(resolved.ledgerAccount)
    mirrors.push({ uid: account.uid, ledger_account: resolved.ledgerAccount, reuse_cash_account_id: resolved.reuseCashAccountId })
  }
  const receipt = await finalizeBankCallback(supabase, {
    companyId: pendingConnection.company_id, userId, connectionId: pendingConnection.id, oauthState, expectedToken,
    sessionId: session_id, consentExpires: consentExpiresAt ?? null, accounts: accountsMetadata, mirrors,
    noIbanPairs: Object.fromEntries(pairedPriorUidByNewUid),
  })
  const updatedConnection = receipt.connection

  // A renewed consent belongs to every company that shared the old session,
  // including consents on superseded rows after a fresh bank-list connect.
  // Without this the siblings keep
  // pointing at the session the bank has just replaced and die on their next
  // sync, which is the original one-session-per-PSU problem wearing a
  // different hat. Non-fatal: this connection is already renewed and correct.
  const replacedSessions = new Set([receipt.old_session_id, ...receipt.superseded.map(row => row.session_id)]
    .filter((id): id is string => Boolean(id) && id !== session_id))
  for (const oldSessionId of replacedSessions) {
    try {
      await fanOutSessionRenewal(supabase, {
        oldSessionId,
        newSessionId: session_id,
        consentExpires: consentExpiresAt ?? null,
        excludeConnectionId: pendingConnection.id,
        // Several ASPSPs mint new account uids on re-authorization, so the
        // siblings need their stored uids re-pointed by IBAN too. Carrying the
        // session id alone would leave them calling dead uids.
        sessionAccounts: receipt.accounts,
      })
    } catch (renewalError) {
      console.error('[enable-banking] Failed to carry renewed session to siblings', {
        connectionId: pendingConnection.id,
        message: renewalError instanceof Error ? renewalError.message : String(renewalError),
      })
    }
  }

  await finishBankSupersession(supabase, {
    companyId: updatedConnection.company_id, userId, newConnectionId: updatedConnection.id,
    bankName: updatedConnection.bank_name, newSessionId: session_id,
  }, receipt.superseded)
  if (receipt.old_session_id && receipt.old_session_id !== session_id &&
    !receipt.superseded.some(row => row.session_id === receipt.old_session_id)) {
    try {
      await revokeUnusedSession(supabase, receipt.old_session_id)
    } catch {
      log.warn('previous callback consent cleanup was not confirmed', { connectionId: updatedConnection.id })
    }
  }

  // Audit trail: PSD2 consent has been exchanged and account metadata stored.
  // ASVS V16 requires this transition to be logged as a security event; emit
  // here so the event_log handler persists it (30-day TTL).
  try {
    await eventBus.emit({
      type: 'bank_connection.consent_granted',
      payload: {
        connectionId: updatedConnection.id,
        bankName: updatedConnection.bank_name ?? null,
        accountCount: accounts.length,
        consentExpiresAt: consentExpiresAt ?? null,
        userId: updatedConnection.user_id,
        companyId: updatedConnection.company_id,
      },
    })
  } catch (emitError) {
    // Non-fatal: redirect the user even if the audit event fails. The
    // structured error record is the alerting channel (A.8.15): production
    // log monitoring keys on the stable message. The underlying DB write
    // (the source of truth for the connection state) has already succeeded.
    log.error(AUDIT_EMIT_FAILED, emitError as Error, {
      eventType: 'bank_connection.consent_granted',
      connectionId: updatedConnection.id,
    })
  }

  return `/settings/banking?select_accounts=${updatedConnection.id}`
}

/**
 * Failure cleanup after finalizeConnection threw. A fresh connect (prior
 * status 'pending') never became a connection: delete the row so it can't
 * linger as a zombie "Åtgärd krävs" card next to a successful retry. A
 * reconnect row (established connection) is kept and marked 'error' so the
 * user retains the renew affordance. Returns the error redirect target.
 */
async function cleanupFailedFinalize(
  supabase: ServiceClient,
  pendingConnection: PendingConnection,
  oauthState: string,
): Promise<string> {
  try {
    if (pendingConnection.status === 'pending') {
      await supabase
        .from('bank_connections')
        .delete()
        .eq('id', pendingConnection.id)
        .eq('company_id', pendingConnection.company_id)
        .eq('oauth_state', oauthState)
        .eq('status', 'pending')
    } else {
      await supabase
        .from('bank_connections')
        .update({ status: 'error', error_message: FINALIZE_FAILED_MESSAGE, oauth_state: null })
        .eq('id', pendingConnection.id)
        .eq('company_id', pendingConnection.company_id)
        .eq('oauth_state', oauthState)
        .in('status', ['pending', 'expired', 'error'])
    }
  } catch (cleanupError) {
    console.error('[enable-banking] Callback cleanup failed', {
      cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    })
  }

  const params = new URLSearchParams({
    bank_error: FINALIZE_FAILED_MESSAGE,
    ...(pendingConnection.bank_name ? { bank_name: pendingConnection.bank_name } : {}),
  })
  return `/settings/banking?${params.toString()}`
}
