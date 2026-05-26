import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createSession, type AccountInfo } from '@/extensions/general/enable-banking/lib/api-client'
import type { StoredAccount } from '@/extensions/general/enable-banking/types'
import { eventBus } from '@/lib/events/bus'
import { upsertFromPsd2 } from '@/lib/cash-accounts/service'

// Suggested BAS account per currency. Mirrors the AccountPickerDialog defaults
// (SEK→1930, EUR→1932, USD→1933, GBP→1934). The user can re-map in the picker
// after this callback redirects them.
const CURRENCY_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

function defaultLedgerForCurrency(currency: string): string {
  return CURRENCY_DEFAULTS[currency.toUpperCase()] ?? '1930'
}

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
    console.error('[enable-banking] Bank authorization denied', {
      error,
      error_description: errorDescription,
      has_state: !!state,
    })

    // Clean up the pending bank_connections row so it doesn't accumulate
    if (state) {
      try {
        const supabase = await createServiceClient()

        // Fetch connection details for logging before updating
        const { data: pendingConn } = await supabase
          .from('bank_connections')
          .select('id, user_id, bank_name')
          .eq('oauth_state', state)
          .eq('status', 'pending')
          .single()

        if (pendingConn) {
          console.error('[enable-banking] Authorization denied details', {
            connection_id: pendingConn.id,
            user_id: pendingConn.user_id,
            bank_name: pendingConn.bank_name,
            error_code: error,
            error_description: errorDescription,
          })

          await supabase
            .from('bank_connections')
            .update({ status: 'error', error_message: errorMessage, oauth_state: null })
            .eq('id', pendingConn.id)

          // Include bank name and error code in redirect so the UI can offer PSU type retry
          const params = new URLSearchParams({
            bank_error: errorMessage,
            ...(pendingConn.bank_name ? { bank_name: pendingConn.bank_name } : {}),
            ...(error === 'access_denied' ? { bank_error_code: error } : {}),
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
    // Look up pending connection by oauth_state (CSRF-safe)
    const { data: pendingConnection, error: findError } = await supabase
      .from('bank_connections')
      .select('id, user_id, company_id')
      .eq('oauth_state', state)
      .eq('status', 'pending')
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
    // currency). Balances are bank account financial data — we don't fetch
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

    // Mirror each PSD2 account into cash_accounts so routing decisions read from
    // the canonical entity table. The user picks a ledger_account in the
    // AccountPickerDialog after this redirect; until then we route SEK→1930,
    // EUR→1932, USD→1933, GBP→1934 by convention.
    for (const account of accountsMetadata) {
      const targetLedger = defaultLedgerForCurrency(account.currency)
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
        // routing table — otherwise this is only visible in console output
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
        .eq('status', 'pending')
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
