import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createSession, type AccountInfo } from '@/extensions/general/enable-banking/lib/api-client'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'
import { eventBus } from '@/lib/events/bus'
import {
  upsertFromPsd2,
  allocatePsd2LedgerAccount,
  defaultLedgerForCurrency,
} from '@/lib/cash-accounts/service'

// This route emits bank_connection.consent_granted / .cash_account_mirror_failed
// (ASVS V16 / GDPR Art.30 audit events). ensureInitialized() must run at module
// load so registerEventLogHandler() has subscribed before the first emit();
// otherwise the audit row is silently dropped on a cold instance where this
// redirect route is the first event-emitting code path to execute.
ensureInitialized()


/**
 * GET /api/extensions/enable-banking/callback
 *
 * OAuth callback for Enable Banking PSD2 authorization.
 * Must be a real Next.js route (not extension handler) because
 * banks redirect to this URL directly.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state') // Cryptographic oauth_state token
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  if (error) {
    const errorMessage = errorDescription || error
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
          .select('id, user_id, bank_name, psu_type')
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

          // If the bank reports a session-expiry during authorization itself,
          // mark the row 'expired' (not generic 'error') so the settings panel
          // surfaces the reconnect button rather than a dead-end error state.
          const isSessionExpiry = /session.?expired|expired.?session|closed.?session|session.?closed|invalid.?session|session.?not.?found/i.test(
            `${error} ${errorDescription ?? ''}`
          )

          await supabase
            .from('bank_connections')
            .update({ status: isSessionExpiry ? 'expired' : 'error', error_message: errorMessage, oauth_state: null })
            .eq('id', pendingConn.id)

          // Include bank name, error code, and psu_type in the redirect so the
          // UI can render targeted guidance (e.g. PSU-type retry on
          // access_denied, or the Handelsbanken corporate fullmakt steps on
          // server_error for a business connect).
          const params = new URLSearchParams({
            bank_error: errorMessage,
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
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent(errorMessage)}`
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings/banking?bank_error=missing_parameters`)
  }

  // Validate authorization code format
  const codePattern = /^[a-zA-Z0-9._~+\/-]{8,2048}$/
  if (!codePattern.test(code)) {
    return NextResponse.redirect(`${baseUrl}/settings/banking?bank_error=invalid_code_format`)
  }

  const supabase = await createServiceClient()

  try {
    // Look up the connection awaiting this callback by oauth_state (CSRF-safe).
    // oauth_state is a single-use random token cleared after use, so it uniquely
    // identifies the row regardless of status. Accept 'expired'/'error' too: an
    // in-place reconnect keeps the row in 'expired' during the round-trip (so
    // the nightly stale-'pending' cleanup can't delete an established row).
    const { data: pendingConnection, error: findError } = await supabase
      .from('bank_connections')
      .select('id, user_id, company_id')
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
        `${baseUrl}/settings/banking?bank_error=${encodeURIComponent('invalid_state')}`
      )
    }

    const userId = pendingConnection.user_id

    console.log('[enable-banking] Exchanging code for session', {
      connectionId: pendingConnection.id,
      userId,
      codeLength: code.length,
    })

    const sessionData = await createSession(code)
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
    const accountsMetadata: StoredAccount[] = accounts.map((account: AccountInfo) => ({
      uid: account.uid,
      iban: account.account_id?.iban,
      name: account.name || account.product,
      currency: account.currency,
      // Default to enabled. The user is presented with a picker
      // immediately after this callback to uncheck unwanted accounts
      // before any transactions are fetched.
      enabled: true,
    }))

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

    // Mirror each PSD2 account into cash_accounts so routing decisions read
    // from the canonical entity table. Accounts already mirrored (reconnect)
    // keep their ledger_account — re-deriving it here would clobber the
    // user's remaps. New accounts each get a free BAS class-19 slot: a bank
    // returning N same-currency accounts must not collide on the UNIQUE
    // (company_id, ledger_account) constraint by all defaulting to 1930.
    const { data: mirroredRows } = await supabase
      .from('cash_accounts')
      .select('external_uid, ledger_account')
      .eq('company_id', updatedConnection.company_id)
      .eq('bank_connection_id', updatedConnection.id)
    const existingLedgerByUid = new Map(
      ((mirroredRows ?? []) as Array<{ external_uid: string; ledger_account: string }>).map(
        (r) => [r.external_uid, r.ledger_account],
      ),
    )
    const assignedLedgers = new Set<string>(existingLedgerByUid.values())
    let accountsDataDirty = false

    for (const account of accountsMetadata) {
      let targetLedger = existingLedgerByUid.get(account.uid)
      if (!targetLedger) {
        targetLedger =
          (await allocatePsd2LedgerAccount(supabase, updatedConnection.company_id, updatedConnection.user_id, {
            currency: account.currency,
            accountName: account.name,
            exclude: assignedLedgers,
          })) ?? defaultLedgerForCurrency(account.currency)
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
          console.error('[enable-banking] Failed to emit cash_account_mirror_failed event', {
            connectionId: updatedConnection.id,
            error: emitError instanceof Error ? emitError.message : String(emitError),
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
      // Non-fatal: redirect the user even if the audit event fails. Sentry
      // surfaces the error; the underlying DB write (the source of truth for
      // the connection state) has already succeeded.
      console.error('[enable-banking] Failed to emit consent_granted event', {
        connectionId: updatedConnection.id,
        error: emitError instanceof Error ? emitError.message : String(emitError),
      })
    }

    const connectionId = updatedConnection.id
    const redirectTarget = `/settings/banking?select_accounts=${connectionId}`

    return NextResponse.redirect(`${baseUrl}${redirectTarget}`)
  } catch (error) {
    console.error('[enable-banking] Callback error', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined,
      state,
      hasCode: !!code,
    })

    try {
      await supabase
        .from('bank_connections')
        .update({ status: 'error', error_message: error instanceof Error ? error.message : 'Connection failed', oauth_state: null })
        .eq('oauth_state', state)
        .in('status', ['pending', 'expired', 'error'])
    } catch (cleanupError) {
      console.error('[enable-banking] Callback cleanup failed', {
        cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }

    return NextResponse.redirect(
      `${baseUrl}/settings/banking?bank_error=${encodeURIComponent('Connection failed')}`
    )
  }
}
