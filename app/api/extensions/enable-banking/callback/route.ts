import { randomBytes } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, after } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'
import { createSession, type AccountInfo } from '@/extensions/general/enable-banking/lib/api-client'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'
import { eventBus } from '@/lib/events/bus'
import {
  upsertFromPsd2,
  resolvePsd2LedgerAccount,
  defaultLedgerForCurrency,
  normalizeIban,
} from '@/lib/cash-accounts/service'
import {
  fanOutSessionRenewal,
  fetchCrossCompanyAccountContext,
} from '@/extensions/general/enable-banking/lib/session-sharing'
import { supersedeSiblingConnections } from '@/extensions/general/enable-banking/lib/supersede'
import { getBankConnectionErrorMessage } from '@/lib/errors/get-error-message'
import { renderFinalizeShell, renderFinalizeRedirect } from './finalize-page'
import { isConnectorState, verifyConnectorState } from '@/lib/connect/hosted/state'

// This route emits bank_connection.consent_granted / .cash_account_mirror_failed
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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

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
    // access_denied is the user cancelling at the bank — an expected outcome,
    // not a runtime error. Only bank-side failures stay at error level.
    const isUserCancel =
      error === 'access_denied' || /cancelled by user/i.test(errorDescription ?? '')
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
          .select('id, user_id, company_id, bank_name, psu_type, status')
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

          // Include bank name, error code, and psu_type in the redirect so the
          // UI can render targeted guidance (e.g. PSU-type retry on
          // access_denied, or the Handelsbanken corporate fullmakt steps on
          // server_error for a business connect).
          const params = new URLSearchParams({
            bank_error: userMessage,
            ...(pendingConn.bank_name ? { bank_name: pendingConn.bank_name } : {}),
            bank_error_code: error,
            ...(pendingConn.psu_type ? { psu_type: pendingConn.psu_type } : {}),
          })
          return NextResponse.redirect(`${baseUrl}/settings/banking?${params.toString()}`)
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
    .select('id, user_id, company_id, bank_name, status, session_id, accounts_data')
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

  // Kick the finalize work off eagerly, decoupled from the response stream:
  // if the user closes the tab mid-stream, the stream is cancelled but this
  // promise keeps running, so the session persistence, cash-account mirror
  // and consent_granted audit emit are not lost (ASVS V16). Never rejects:
  // failures resolve to the cleanup redirect target.
  const finalizePromise = (async (): Promise<string> => {
    try {
      return await finalizeConnection(supabase, pendingConnection, code, connectorState)
    } catch (finalizeError) {
      const reason =
        finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
      console.error('[enable-banking] Callback error', {
        message: reason,
        stack: finalizeError instanceof Error ? finalizeError.stack : undefined,
        name: finalizeError instanceof Error ? finalizeError.name : undefined,
        state,
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
      return cleanupFailedFinalize(supabase, pendingConnection)
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
        controller.enqueue(encoder.encode(renderFinalizeRedirect(`${baseUrl}${targetPath}`, cspNonce)))
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
): Promise<string> {
  const userId = pendingConnection.user_id

  console.log('[enable-banking] Exchanging code for session', {
    connectionId: pendingConnection.id,
    userId,
    codeLength: code.length,
  })

  const sessionData = await createSession(code, connectorState ?? undefined)
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
  // Dedup scopes the row's accounts were first ingested under. The scope of a
  // legacy account without an explicit dedup_scope is what lib/sync.ts derived
  // for it historically: the normalized IBAN, else its (then-current) uid.
  // Matching by IBAN first covers the ASPSPs that mint new uids on every
  // re-authorization; the uid match covers no-IBAN accounts whose uid is
  // stable. A no-IBAN account whose uid changed cannot be matched here: it
  // gets a fresh scope, same as before this field existed.
  const priorAccounts = pendingConnection.accounts_data ?? []
  // explicit: the prior account carried a stored dedup_scope (as opposed to
  // one derived here from its IBAN/uid). The supersede pass below only lets a
  // carried sibling scope onto an account whose own scope is NOT explicit.
  const priorScopeByIban = new Map<string, { scope: string; explicit: boolean }>()
  const priorScopeByUid = new Map<string, { scope: string; explicit: boolean }>()
  // The user's earlier sync choice per account ("Synkas ej" = enabled:false)
  // must survive a renewal: a deselected private card that comes back
  // pre-checked lands its transactions in the company's books the moment the
  // user saves the picker with defaults. Matched by uid first (exact resource
  // identity; one session can list the same IBAN twice, e.g. one resource per
  // balance type), then by IBAN for ASPSPs that mint new uids on re-auth.
  const priorEnabledByIban = new Map<string, boolean>()
  const priorEnabledByUid = new Map<string, boolean>()
  for (const prior of priorAccounts) {
    const priorIban = normalizeIban(prior.iban)
    const priorScope = prior.dedup_scope || priorIban || prior.uid
    const priorEntry = { scope: priorScope, explicit: Boolean(prior.dedup_scope) }
    if (priorIban && !priorScopeByIban.has(priorIban)) priorScopeByIban.set(priorIban, priorEntry)
    if (!priorScopeByUid.has(prior.uid)) priorScopeByUid.set(prior.uid, priorEntry)
    const priorEnabled = prior.enabled !== false
    if (priorIban && !priorEnabledByIban.has(priorIban)) priorEnabledByIban.set(priorIban, priorEnabled)
    if (!priorEnabledByUid.has(prior.uid)) priorEnabledByUid.set(prior.uid, priorEnabled)
  }

  const accountsMetadata: StoredAccount[] = accounts.map((account: AccountInfo) => {
    const normalizedIban = normalizeIban(account.account_id?.iban)
    return {
      uid: account.uid,
      iban: account.account_id?.iban,
      name: account.name || account.product,
      currency: account.currency,
      // Carry the user's earlier choice for an account we have seen before;
      // only genuinely new accounts default to enabled. The picker shown
      // right after this callback pre-checks from this flag, and no
      // transactions are fetched before the user saves it.
      enabled:
        priorEnabledByUid.get(account.uid) ??
        (normalizedIban ? priorEnabledByIban.get(normalizedIban) : undefined) ??
        true,
      // Pin the external_id account scope at first ingest so it survives
      // re-authorizations. Byte-identical to the derivation lib/sync.ts
      // applied before this field existed (normalized IBAN, else uid).
      dedup_scope:
        (normalizedIban ? priorScopeByIban.get(normalizedIban)?.scope : undefined) ??
        priorScopeByUid.get(account.uid)?.scope ??
        normalizedIban ??
        account.uid,
    }
  })

  // The maps above leave one corner open (issue #1709): a NO-IBAN account
  // whose uid changed on an in-place reconnect matches neither by IBAN nor by
  // uid, so its scope regenerates, every historical external_id changes, and
  // the whole history re-imports as fresh unbooked rows. Pair such accounts by
  // elimination, but only when the pairing is unambiguous: per currency,
  // EXACTLY ONE prior account left unclaimed (no new account matched it via
  // IBAN or uid) and EXACTLY ONE new account with a fresh scope, and neither
  // side carries an IBAN. Anything else keeps the fresh-scope behavior. The
  // asymmetry is deliberate: a wrong pairing can at worst skip a new
  // transaction whose account+date+amount+occurrence all collide with an old
  // row, while a missed pairing re-imports the full history unbooked.
  const pairedPriorUidByNewUid = new Map<string, string>()
  if (priorAccounts.length > 0) {
    const newIbans = new Set<string>()
    const newUids = new Set<string>()
    for (const account of accountsMetadata) {
      const normalizedIban = normalizeIban(account.iban)
      if (normalizedIban) newIbans.add(normalizedIban)
      newUids.add(account.uid)
    }
    const unclaimedPriorsByCurrency = new Map<string, StoredAccount[]>()
    for (const prior of priorAccounts) {
      const priorIban = normalizeIban(prior.iban)
      if ((priorIban && newIbans.has(priorIban)) || newUids.has(prior.uid)) continue
      const currency = (prior.currency || '').toUpperCase()
      const bucket = unclaimedPriorsByCurrency.get(currency)
      if (bucket) bucket.push(prior)
      else unclaimedPriorsByCurrency.set(currency, [prior])
    }
    const freshScopeByCurrency = new Map<string, StoredAccount[]>()
    for (const account of accountsMetadata) {
      const normalizedIban = normalizeIban(account.iban)
      const matchedPrior =
        (normalizedIban ? priorScopeByIban.has(normalizedIban) : false) ||
        priorScopeByUid.has(account.uid)
      if (matchedPrior) continue
      const currency = (account.currency || '').toUpperCase()
      const bucket = freshScopeByCurrency.get(currency)
      if (bucket) bucket.push(account)
      else freshScopeByCurrency.set(currency, [account])
    }
    for (const [currency, unclaimed] of unclaimedPriorsByCurrency) {
      const fresh = freshScopeByCurrency.get(currency) ?? []
      if (unclaimed.length !== 1 || fresh.length !== 1) continue
      const prior = unclaimed[0]
      const survivor = fresh[0]
      if (normalizeIban(prior.iban) || normalizeIban(survivor.iban)) continue
      survivor.dedup_scope = prior.dedup_scope || prior.uid
      // The pairing is an identity claim, so the user's earlier sync choice
      // travels with it: a deselected account must not come back pre-checked.
      survivor.enabled = prior.enabled !== false
      pairedPriorUidByNewUid.set(survivor.uid, prior.uid)
      console.log('[enable-banking] Paired no-IBAN account across a uid change', {
        connectionId: pendingConnection.id,
        currency,
        priorUid: prior.uid,
        newUid: survivor.uid,
      })
    }
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
    const seenOnThisRow =
      priorEnabledByUid.has(account.uid) ||
      (normalizedIban ? priorEnabledByIban.has(normalizedIban) : false) ||
      pairedPriorUidByNewUid.has(account.uid)
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
          claimedCount += 1
        }
      }
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

  // Stay in 'pending_selection' until the user confirms which accounts to sync.
  // The cron and manual sync routes both skip this status, so no transactions
  // can be pulled before the user has had a chance to deselect accounts.
  // Do not set last_synced_at here either: no transactions have been fetched
  // yet, and setting it would cause the cron's first-sync 90-day backfill
  // path to be skipped. The first successful sync sets it.
  const { data: updatedConnection, error: updateError } = await supabase
    .from('bank_connections')
    .update({
      session_id,
      status: 'pending_selection',
      accounts_data: accountsMetadata,
      consent_expires: consentExpiresAt,
      oauth_state: null, // Clear to prevent replay
    })
    .eq('id', pendingConnection.id)
    .select('id, bank_name, company_id, user_id')
    .single()

  if (updateError) {
    console.error('[enable-banking] Failed to update connection after session creation', {
      connectionId: pendingConnection.id,
      updateError: { message: updateError.message, code: updateError.code, details: updateError.details },
      sessionId: '[REDACTED]',
    })
    throw new Error(`Failed to update connection: ${updateError.message}`)
  }

  // A renewed consent belongs to every company that shared the old session,
  // not just the one whose button was pressed. Without this the siblings keep
  // pointing at the session the bank has just replaced and die on their next
  // sync, which is the original one-session-per-PSU problem wearing a
  // different hat. Non-fatal: this connection is already renewed and correct.
  if (pendingConnection.session_id && pendingConnection.session_id !== session_id) {
    try {
      await fanOutSessionRenewal(supabase, {
        oldSessionId: pendingConnection.session_id,
        newSessionId: session_id,
        consentExpires: consentExpiresAt ?? null,
        excludeConnectionId: pendingConnection.id,
        // Several ASPSPs mint new account uids on re-authorization, so the
        // siblings need their stored uids re-pointed by IBAN too. Carrying the
        // session id alone would leave them calling dead uids.
        sessionAccounts: accountsMetadata,
      })
    } catch (renewalError) {
      console.error('[enable-banking] Failed to carry renewed session to siblings', {
        connectionId: pendingConnection.id,
        message: renewalError instanceof Error ? renewalError.message : String(renewalError),
      })
    }
  }

  // A successful (re)connect supersedes any older row for the same bank in
  // this company. Without this, a renewal performed via the bank list left
  // the old row parked in 'expired' ("Åtgärd krävs" forever, red chip) with
  // the transaction history stranded on it, so the picker treated the renewal
  // as a first connect and re-imported bookkept periods. Runs BEFORE the
  // cash_accounts mirror below: the supersede demotes the old row's ledger
  // claims to manual, and the mirror then promotes them onto this row by
  // IBAN, exactly like a disconnect-then-reconnect. Non-fatal: this
  // connection is already renewed and correct.
  let carriedScopeDirty = false
  try {
    const supersedeResult = await supersedeSiblingConnections(supabase, {
      companyId: updatedConnection.company_id,
      userId: updatedConnection.user_id,
      newConnectionId: updatedConnection.id,
      bankName: updatedConnection.bank_name ?? null,
      newSessionId: session_id,
      newAccounts: accountsMetadata,
    })
    // Carry the superseded rows' dedup scopes onto this row's accounts so a
    // renewal keeps minting the same transaction external_ids (see
    // StoredAccount.dedup_scope). An account whose OWN prior row already
    // carried an explicit dedup_scope keeps it: that scope is the one its
    // external_ids were actually minted under, and a sibling's scope for the
    // same IBAN must not clobber it. Only accounts whose scope was derived
    // here (IBAN/uid fallback) take the carried one. Persisted by the
    // accounts_data write below.
    if (supersedeResult.dedupScopeByIban.size > 0) {
      for (const account of accountsMetadata) {
        const normalizedIban = normalizeIban(account.iban)
        const carried = normalizedIban
          ? supersedeResult.dedupScopeByIban.get(normalizedIban)
          : undefined
        const survivorExplicit =
          (normalizedIban ? priorScopeByIban.get(normalizedIban)?.explicit : undefined) ??
          priorScopeByUid.get(account.uid)?.explicit ??
          false
        if (carried && !survivorExplicit && account.dedup_scope !== carried) {
          account.dedup_scope = carried
          carriedScopeDirty = true
        }
      }
    }
  } catch (supersedeError) {
    log.error('supersede pass failed', supersedeError as Error, {
      connectionId: updatedConnection.id,
    })
  }

  // Mirror each PSD2 account into cash_accounts so routing decisions read
  // from the canonical entity table. Accounts already mirrored under the same
  // (connection, uid) keep their ledger_account — re-deriving it here would
  // clobber the user's remaps. Everything else goes through
  // resolvePsd2LedgerAccount, which matches on IBAN before allocating: a
  // re-authorization that mints new account uids, and a fresh connect that
  // mints a whole new connection row, both have to land back on the mapping
  // the user already chose instead of overflowing into the next free slots.
  const { data: mirroredRows } = await supabase
    .from('cash_accounts')
    .select('id, external_uid, ledger_account')
    .eq('company_id', updatedConnection.company_id)
    .eq('bank_connection_id', updatedConnection.id)
  const mirroredByUid = new Map(
    ((mirroredRows ?? []) as Array<{ id: string; external_uid: string; ledger_account: string }>).map(
      (r) => [r.external_uid, r],
    ),
  )
  // Only ledgers still claimed by a uid the bank returned in THIS session
  // block the resolver. A row whose uid the ASPSP retired on re-auth (SEB
  // mints new uids on every renewal) is exactly the row the IBAN match must
  // promote; seeding its ledger into the exclude set made the resolver reject
  // its own IBAN hit and allocate a fresh 19xx slot per renewal, so the chart
  // grew a dead sub-account each time. Stale ledgers are still safe from the
  // allocator: findFreeLedgerAccount skips every ledger a cash_accounts row
  // holds, whatever its uid.
  const sessionUids = new Set(accountsMetadata.map((a) => a.uid))
  const assignedLedgers = new Set<string>(
    [...mirroredByUid.values()]
      .filter((row) => sessionUids.has(row.external_uid))
      .map((row) => row.ledger_account),
  )
  let accountsDataDirty = carriedScopeDirty

  for (const account of accountsMetadata) {
    // Nothing the guard disabled is mirrored here: a claimed account's row
    // would be another company's data in this routing table (and an enabled
    // one would double-claim the IBAN), and mirroring enabled:false for any
    // new-to-row account can promote an existing manual holder — the seeded
    // primary 1930 included — flipping it to disabled under a foreign
    // identity. No 19xx slot is burned either. The selection save allocates
    // and mirrors whichever of them the user deliberately turns on.
    if (guardDisabledUids.has(account.uid)) continue
    let targetLedger = mirroredByUid.get(account.uid)?.ledger_account
    let reuseCashAccountId: string | null = null
    if (!targetLedger) {
      // A paired no-IBAN account (uid change on an in-place reconnect) reuses
      // this connection's own row for the retired uid: same ledger, same row
      // id. upsertFromPsd2 promotes the named row in place, re-keying it to
      // the new uid, so transactions.cash_account_id links survive and the
      // content-dedup account guard in lib/transactions/ingest.ts keeps
      // matching. Without this the resolver would see the old row as a live
      // claim and allocate an overflow 19xx slot plus a NEW cash_accounts row,
      // which is the second half of issue #1709.
      const pairedPriorUid = pairedPriorUidByNewUid.get(account.uid)
      const pairedRow = pairedPriorUid ? mirroredByUid.get(pairedPriorUid) : undefined
      if (pairedRow && !assignedLedgers.has(pairedRow.ledger_account)) {
        targetLedger = pairedRow.ledger_account
        reuseCashAccountId = pairedRow.id
      }
    }
    if (!targetLedger) {
      const resolved = await resolvePsd2LedgerAccount(
        supabase,
        updatedConnection.company_id,
        updatedConnection.user_id,
        {
          iban: account.iban,
          currency: account.currency,
          accountName: account.name,
          exclude: assignedLedgers,
        },
      )
      targetLedger = resolved?.ledgerAccount ?? defaultLedgerForCurrency(account.currency)
      reuseCashAccountId = resolved?.reuseCashAccountId ?? null
      if (resolved?.source === 'iban') {
        console.log('[enable-banking] Reused existing ledger mapping for known IBAN', {
          connectionId: updatedConnection.id,
          uid: account.uid,
          ledgerAccount: targetLedger,
        })
      }
    }
    assignedLedgers.add(targetLedger)
    if (account.ledger_account !== targetLedger) {
      account.ledger_account = targetLedger
      accountsDataDirty = true
    }
    try {
      await upsertFromPsd2(supabase, updatedConnection.company_id, {
        bank_connection_id: updatedConnection.id,
        external_uid: account.uid,
        currency: account.currency,
        ledger_account: targetLedger,
        iban: account.iban ?? null,
        name: account.name ?? null,
        enabled: account.enabled ?? true,
        reuse_cash_account_id: reuseCashAccountId,
      })
    } catch (cashErr) {
      const reason = cashErr instanceof Error ? cashErr.message : String(cashErr)
      console.error('[enable-banking] Failed to mirror cash_account on callback', {
        connectionId: updatedConnection.id,
        uid: account.uid,
        error: reason,
      })
      // Persist the failure to event_log so a security review can see that
      // a PSD2 account returned by the bank was not mirrored into our
      // routing table; otherwise this is only visible in console output
      // (ASVS V16 / ISO 27001 A.8.15 / SOC 2 CC7.2).
      try {
        await eventBus.emit({
          type: 'bank_connection.cash_account_mirror_failed',
          payload: {
            connectionId: updatedConnection.id,
            bankName: updatedConnection.bank_name ?? null,
            accountUid: account.uid,
            ledgerAccount: targetLedger,
            currency: account.currency,
            reason,
            userId: updatedConnection.user_id,
            companyId: updatedConnection.company_id,
          },
        })
      } catch (emitError) {
        // A.8.15: structured error (not bare console) so log-based alerting
        // catches a dropped security event instead of it vanishing silently.
        log.error(AUDIT_EMIT_FAILED, emitError as Error, {
          eventType: 'bank_connection.cash_account_mirror_failed',
          connectionId: updatedConnection.id,
          accountUid: account.uid,
        })
      }
    }
  }

  // Persist the allocated ledgers into accounts_data so the AccountPicker
  // pre-fills the actual assignments instead of colliding currency
  // defaults. Non-fatal: cash_accounts is the routing source of truth.
  if (accountsDataDirty) {
    const { error: accountsDataError } = await supabase
      .from('bank_connections')
      .update({ accounts_data: accountsMetadata })
      .eq('id', updatedConnection.id)
    if (accountsDataError) {
      console.warn('[enable-banking] Failed to persist allocated ledgers to accounts_data', {
        connectionId: updatedConnection.id,
        error: accountsDataError.message,
      })
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
): Promise<string> {
  try {
    if (pendingConnection.status === 'pending') {
      await supabase
        .from('bank_connections')
        .delete()
        .eq('id', pendingConnection.id)
        .eq('status', 'pending')
    } else {
      await supabase
        .from('bank_connections')
        .update({ status: 'error', error_message: FINALIZE_FAILED_MESSAGE, oauth_state: null })
        .eq('id', pendingConnection.id)
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
