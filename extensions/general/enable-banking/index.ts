import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  startAuthorization,
  getASPSPs,
  getPreferredAuthMethod,
  deleteSession,
  isSandboxMode,
  SessionExpiredError,
  type ASPSP,
} from './lib/api-client'
import { syncAccountTransactions } from './lib/sync'
import {
  runReconciliation,
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
} from '@/lib/reconciliation/bank-reconciliation'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import type { StoredAccount } from './types'
import type { Transaction } from '@/types'

// Per-user limits keep one tenant from spamming any single bank handler.
// Sliding 60s windows: generous enough for legitimate retry, tight enough
// to prevent UUID probing or status-machine abuse.
const RATE_LIMIT_ACCOUNTS = { maxRequests: 20, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }

const MAX_ENABLED_UIDS = 50

/**
 * Enable Banking (PSD2) extension
 *
 * Provides automatic bank transaction sync via PSD2 open banking.
 * This is an opt-in extension: uncomment the import in loader.ts to activate.
 *
 * Required environment variables:
 * - ENABLE_BANKING_APP_ID
 * - ENABLE_BANKING_PRIVATE_KEY (base64-encoded PEM)
 * - ENABLE_BANKING_SANDBOX (optional, for sandbox mode)
 */
export const enableBankingExtension: Extension = {
  id: 'enable-banking',
  name: 'Enable Banking (PSD2)',
  version: '1.0.0',

  settingsPanel: {
    label: 'Bankintegration (PSD2)',
    path: '/settings/banking',
  },

  apiRoutes: [
    {
      method: 'GET',
      path: '/banks',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        try {
          // Detect PSU type from company entity_type
          let psuType: 'personal' | 'business' = 'business'
          if (ctx?.companyId && ctx?.supabase) {
            const { data: company } = await ctx.supabase
              .from('companies')
              .select('entity_type')
              .eq('id', ctx.companyId)
              .single()
            if (company?.entity_type === 'enskild_firma') {
              psuType = 'personal'
            }
          }

          const aspsps = await getASPSPs('SE', psuType)
          const banks = aspsps.map((aspsp: ASPSP) => ({
            name: aspsp.name,
            country: aspsp.country,
            logo: aspsp.logo,
            bic: aspsp.bic,
          }))
          return NextResponse.json({ banks, psu_type: psuType, sandbox: isSandboxMode() })
        } catch (error) {
          log.error('Error fetching banks:', error)
          return NextResponse.json({
            banks: [
              { name: 'Nordea', country: 'SE', bic: 'NDEASESS' },
              { name: 'SEB', country: 'SE', bic: 'ESSESESS' },
              { name: 'Swedbank', country: 'SE', bic: 'SWEDSESS' },
              { name: 'Handelsbanken', country: 'SE', bic: 'HANDSESS' },
            ],
            sandbox: isSandboxMode(),
          })
        }
      },
    },
    {
      method: 'POST',
      path: '/connect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const { aspsp_name, aspsp_country, psu_type: explicitPsuType, connection_id: reconnectId } = await request.json()

        // Reconnect mode: re-authorize an EXISTING connection in place (no
        // disconnect required). The aspsp identity falls back to the stored row
        // when the client omits it, so a closed/expired session can be renewed
        // with one click. A fresh connect still needs the bank name + country.
        const isReconnect = !!reconnectId
        if (!isReconnect && (!aspsp_name || !aspsp_country)) {
          return NextResponse.json(
            { error: 'aspsp_name and aspsp_country are required' },
            { status: 400 }
          )
        }

        try {
          // For reconnect, load the existing connection up front (company-scoped)
          // so we can revoke its dead session and reuse its bank identity.
          let existing:
            | { id: string; bank_name: string; provider: string; session_id: string | null; psu_type: string | null }
            | null = null
          if (isReconnect) {
            const { data, error: findErr } = await supabase
              .from('bank_connections')
              .select('id, bank_name, provider, session_id, psu_type')
              .eq('id', reconnectId)
              .eq('company_id', companyId)
              .single()
            if (findErr || !data) {
              return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
            }
            existing = data
          }

          // Resolve the aspsp identity. For a reconnect the bank is already
          // known, so derive it authoritatively from the stored row and IGNORE
          // any client-supplied aspsp_name/aspsp_country: the client
          // (BankSyncNowButton) derives the country by string-splitting the
          // provider slug, and trusting that back is needless attack surface
          // (compliance: ASVS V8.2.1/V4.5). A fresh connect has no stored row,
          // so it uses the client values (already required+validated above).
          // The provider slug ends with the country code, e.g. "nordea-se".
          const resolvedAspspName = isReconnect ? existing?.bank_name : aspsp_name
          const resolvedAspspCountry = isReconnect
            ? existing?.provider?.split('-').pop()?.toUpperCase() || 'SE'
            : aspsp_country
          if (!resolvedAspspName) {
            return NextResponse.json(
              { error: 'aspsp_name and aspsp_country are required' },
              { status: 400 }
            )
          }

          // Detect PSU type: explicit override > stored type (reconnect) >
          // company entity_type > default 'business'. Reusing the stored type on
          // reconnect is the key fix: re-deriving from entity_type would flip a
          // working 'personal' connection (e.g. an AB owner who signs with a
          // personal Mobile BankID) back to 'business' on every consent renewal,
          // failing at the bank's signing step. The client can still pass an
          // explicit psu_type to switch account type in place.
          let psuType: 'personal' | 'business' = 'business'
          if (explicitPsuType === 'personal' || explicitPsuType === 'business') {
            psuType = explicitPsuType
          } else if (isReconnect && (existing?.psu_type === 'personal' || existing?.psu_type === 'business')) {
            psuType = existing.psu_type
          } else {
            const { data: company } = await supabase
              .from('companies')
              .select('entity_type')
              .eq('id', companyId)
              .single()
            if (company?.entity_type === 'enskild_firma') {
              psuType = 'personal'
            }
          }

          // Resolve the bank's preferred auth method. Handelsbanken (and some
          // other Swedish banks) expose Mobile BankID only as a hidden DECOUPLED
          // method; without this, Enable Banking defaults to the REDIRECT method,
          // which for Handelsbanken *corporate* PSUs cannot complete with Mobile
          // BankID: the user approves in the app and then hits an error. Returns
          // undefined for banks with no decoupled method, leaving them untouched.
          const authMethod = await getPreferredAuthMethod(
            resolvedAspspName,
            resolvedAspspCountry,
            psuType
          )

          log.info('[enable-banking] Starting bank connection', {
            user_id: user.id,
            bank: resolvedAspspName,
            country: resolvedAspspCountry,
            psu_type: psuType,
            auth_method: authMethod ?? '(aspsp default)',
            reconnect: isReconnect,
          })

          // Reject if there's already a recent pending connection for this user+bank
          // to prevent double-click race conditions that confuse the bank's consent
          // flow. Skipped for reconnect: that deliberately re-authorizes a known row.
          if (!isReconnect) {
            const { data: recentPending } = await supabase
              .from('bank_connections')
              .select('id, created_at')
              .eq('company_id', companyId)
              .eq('bank_name', resolvedAspspName)
              .eq('status', 'pending')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            if (recentPending) {
              const pendingAge = Date.now() - new Date(recentPending.created_at).getTime()
              const STALE_THRESHOLD_MS = 30 * 1000 // 30 seconds: long enough to cover the redirect handoff, short enough that an abandoned attempt doesn't block the user

              if (pendingAge < STALE_THRESHOLD_MS) {
                log.info('[enable-banking] Rejecting duplicate connect: recent pending exists', {
                  existing_id: recentPending.id,
                  age_ms: pendingAge,
                })
                return NextResponse.json(
                  { error: 'En anslutning pågår redan. Vänta och försök igen.' },
                  { status: 409 }
                )
              }

              // Clean up stale pending connections (older than threshold)
              log.info('[enable-banking] Cleaning up stale pending connections', {
                stale_id: recentPending.id,
                age_ms: pendingAge,
              })
              await supabase
                .from('bank_connections')
                .update({ status: 'error', error_message: 'Superseded by new connection attempt', oauth_state: null })
                .eq('company_id', companyId)
                .eq('bank_name', resolvedAspspName)
                .eq('status', 'pending')
            }
          }

          const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/extensions/enable-banking/callback`

          // Generate cryptographic state token for CSRF protection
          const oauthState = crypto.randomUUID()

          if (isReconnect && existing) {
            // Persist the CSRF state to the existing row BEFORE asking the bank
            // to start an authorization. The OAuth callback locates this row only
            // by oauth_state, so writing it first guarantees that once the bank
            // holds a session bound to this state a matching row already exists.
            // If startAuthorization ran first and this UPDATE then failed, the
            // bank session would be orphaned with no row to complete it.
            //
            // Reuse the SAME row: the callback drives it back to
            // pending_selection → active, so existing transactions and the
            // cash_accounts mirror stay linked. Deliberately keep status
            // 'expired' (NOT 'pending') during the round-trip: this row's
            // created_at is old and the cron deletes stale 'pending' rows after
            // 1h: a reconnect must not be eligible for that. Staying 'expired'
            // also keeps it visible in "Åtgärd krävs" so an abandoned reconnect
            // is recoverable. The callback's oauth_state lookup accepts 'expired'.
            const { error: stateError } = await supabase
              .from('bank_connections')
              .update({
                oauth_state: oauthState,
                status: 'expired',
                session_id: null,
                error_message: null,
                psu_type: psuType,
              })
              .eq('id', existing.id)
              .eq('company_id', companyId)

            if (stateError) {
              log.error('[enable-banking] Database error staging reconnect state', {
                errorMessage: stateError.message,
                errorCode: stateError.code,
                connection_id: existing.id,
                user_id: user.id,
              })
              throw new Error(`Failed to update connection: ${stateError.message}`)
            }

            // Best-effort revoke the dead consent at Enable Banking. A
            // closed/expired session is often already gone, so a failure here is
            // expected and non-fatal: the new authorization supersedes it.
            // Logged at WARN so a systematic revoke failure is visible to
            // monitoring (compliance: ASVS V16 / ISO 27001 A.8.15).
            if (existing.session_id) {
              try {
                await deleteSession(existing.session_id)
              } catch (revokeError) {
                log.warn('[enable-banking] Old session revoke skipped (likely already expired)', {
                  message: revokeError instanceof Error ? revokeError.message : String(revokeError),
                  connection_id: existing.id,
                })
              }
            }

            const { url, authorization_id } = await startAuthorization(
              resolvedAspspName,
              resolvedAspspCountry,
              redirectUrl,
              oauthState,
              psuType,
              authMethod
            )

            // Record the bank's authorization_id for audit/traceability. The
            // callback matches on oauth_state alone (already persisted above), so
            // a failure here cannot orphan the flow: log and continue.
            const { error: authIdError } = await supabase
              .from('bank_connections')
              .update({ authorization_id })
              .eq('id', existing.id)
              .eq('company_id', companyId)

            if (authIdError) {
              log.warn('[enable-banking] Could not persist authorization_id on reconnect (non-fatal)', {
                errorMessage: authIdError.message,
                connection_id: existing.id,
              })
            }

            return NextResponse.json({
              connection_id: existing.id,
              authorization_url: url,
            })
          }

          // Fresh connect: create the bank authorization, then persist the new
          // row carrying its oauth_state so the callback can find it.
          const { url, authorization_id } = await startAuthorization(
            resolvedAspspName,
            resolvedAspspCountry,
            redirectUrl,
            oauthState,
            psuType,
            authMethod
          )

          const { data: connection, error } = await supabase
            .from('bank_connections')
            .insert({
              company_id: companyId,
              user_id: user.id,
              provider: `${resolvedAspspName.toLowerCase().replace(/\s+/g, '-')}-${resolvedAspspCountry.toLowerCase()}`,
              bank_name: resolvedAspspName,
              authorization_id,
              oauth_state: oauthState,
              status: 'pending',
              psu_type: psuType,
            })
            .select()
            .single()

          if (error) {
            log.error('[enable-banking] Database error storing connection', {
              errorMessage: error.message,
              errorCode: error.code,
              errorDetails: error.details,
              user_id: user.id,
              bank: resolvedAspspName,
            })
            throw new Error(`Failed to store connection: ${error.message}`)
          }

          return NextResponse.json({
            connection_id: connection.id,
            authorization_url: url,
          })
        } catch (error) {
          log.error('[enable-banking] Connect handler error', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            user_id: user.id,
            aspsp_name,
            aspsp_country,
          })
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Connection failed' },
            { status: 500 }
          )
        }
      },
    },
    {
      method: 'POST',
      path: '/sync',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:sync',
          identifier: user.id,
          ...RATE_LIMIT_SYNC,
        })
        if (!rl.ok) return rl.response!

        // Default 120 days: most callers (Sync Now button, post-activation gap fill)
        // want a deep refresh, not a 30-day blip. Cron uses 7-day incrementals separately.
        // Bank may still cap at ~90 days per PSD2 without fresh SCA: asking for more
        // is harmless and surfaces whatever the ASPSP is willing to return.
        const { connection_id, days_back: rawDaysBack = 120 } = await request.json()
        const days_back = Math.min(Math.max(1, rawDaysBack), 365)

        const { data: connection, error: connectionError } = await supabase
          .from('bank_connections')
          .select('*')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (connectionError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        if (connection.status !== 'active') {
          return NextResponse.json({ error: 'Connection is not active' }, { status: 400 })
        }

        try {
          // Keep the full list for write-back; sync only the enabled subset.
          // undefined enabled === true for back-compat with rows that predate
          // the per-account toggle.
          const allAccounts = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))
          const accounts = allAccounts.filter(a => a.enabled !== false)

          if (accounts.length === 0) {
            return NextResponse.json(
              { error: 'Inga konton är valda för synkning. Öppna "Hantera konton" för att aktivera minst ett.' },
              { status: 400 }
            )
          }

          const toDate = new Date().toISOString().split('T')[0]
          const fromDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0]
          const syncStartedAt = new Date().toISOString()

          // Use ctx.services.ingestTransactions when available
          const ingestFn = ctx?.services.ingestTransactions

          // Detect SIE overlap: skip auto-categorization if the sync range
          // overlaps with a completed SIE import to prevent double-booking.
          // Reconciliation still links bank transactions to existing GL lines.
          const { data: sieOverlap } = await supabase
            .from('sie_imports')
            .select('id')
            .eq('company_id', companyId)
            .eq('status', 'completed')
            .gte('fiscal_year_end', fromDate)
            .limit(1)
            .maybeSingle()

          // Check if user is a viewer: viewers get rawInsertOnly (no categorization)
          const { data: membership } = await supabase
            .from('company_members')
            .select('role')
            .eq('company_id', companyId)
            .eq('user_id', user.id)
            .maybeSingle()
          const isViewer = membership?.role === 'viewer'

          // Use strategy=longest when the caller asks for >= 30 days of history
          // (initial sync, manual backfill). Short windows get the implicit
          // default since there's no older data to surface.
          const syncOptions = {
            ...(sieOverlap ? { skipAutoCategorization: true } : {}),
            ...(isViewer ? { rawInsertOnly: true } : {}),
            ...(days_back >= 30 ? { strategy: 'longest' as const } : {}),
          }

          if (sieOverlap) {
            log.info('SIE import overlap detected: suppressing auto-categorization', {
              sieImportId: sieOverlap.id,
              fromDate,
              toDate,
            })
          }
          const results = await Promise.all(
            accounts.map(account => syncAccountTransactions(
              supabase,
              companyId,
              user.id,
              connection.id,
              account,
              fromDate,
              toDate,
              ingestFn,
              syncOptions
            ))
          )

          const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
          const totalDuplicates = results.reduce((sum, r) => sum + r.duplicates, 0)

          // When SIE overlap is detected, run a batch reconciliation sweep.
          // The greedy algorithm considers all candidates globally (highest-
          // confidence first) and catches matches the inline per-transaction
          // pass may have missed due to processing order.
          // Skip for viewers: reconciliation updates transactions which viewers cannot do.
          if (sieOverlap && totalImported > 0 && !isViewer) {
            try {
              const reconResult = await runReconciliation(supabase, companyId, user.id, {
                dateFrom: fromDate,
                dateTo: toDate,
                // This sweep applies without a human reviewing a dry-run, so
                // never commit low-confidence (fuzzy / date-range) matches.
                confidenceThreshold: DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD,
              })
              if (reconResult.applied > 0 || reconResult.skippedBelowThreshold > 0) {
                log.info('Post-sync batch reconciliation matched additional transactions', {
                  applied: reconResult.applied,
                  skippedBelowThreshold: reconResult.skippedBelowThreshold,
                  total: reconResult.matches.length,
                })
              }
            } catch {
              // Non-critical: transactions remain uncategorized for manual review
            }
          }

          const syncedAt = new Date().toISOString()
          await supabase
            .from('bank_connections')
            .update({
              accounts_data: allAccounts,
              last_synced_at: syncedAt,
            })
            .eq('id', connection.id)

          if (totalImported > 0) {
            const { data: syncedTransactions } = await supabase
              .from('transactions')
              .select('*')
              .eq('company_id', companyId)
              .eq('bank_connection_id', connection.id)
              .gte('created_at', syncStartedAt)
              .order('created_at', { ascending: false })
              .limit(totalImported)

            if (syncedTransactions && syncedTransactions.length > 0) {
              const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
              await emit({
                type: 'transaction.synced',
                payload: { transactions: syncedTransactions as Transaction[], userId: user.id, companyId },
              })
            }
          }

          return NextResponse.json({
            imported: totalImported,
            duplicates: totalDuplicates,
            last_synced_at: syncedAt,
          })
        } catch (error) {
          log.error('[enable-banking] Sync handler error', {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
            user_id: user.id,
            connection_id,
            connectionStatus: connection.status,
            bankName: connection.bank_name,
          })

          // A dead PSD2 session (closed/expired/invalid consent) can't be fixed
          // by retrying: the user must re-authorize. Flip the connection to
          // 'expired' so the UI surfaces the reconnect affordance, and tell the
          // client re-auth is required (reauth_required) so it can offer a
          // one-click "Förnya anslutning" instead of a dead-end error. No
          // disconnect needed: /connect reconnects this same connection in place.
          if (error instanceof SessionExpiredError) {
            const reauthMessage = 'Bankanslutningen har löpt ut. Förnya anslutningen för att fortsätta synka.'
            await supabase
              .from('bank_connections')
              .update({ status: 'expired', error_message: reauthMessage })
              .eq('id', connection.id)
              .eq('company_id', companyId)
            return NextResponse.json(
              {
                error: reauthMessage,
                code: 'SESSION_EXPIRED',
                reauth_required: true,
                connection_id: connection.id,
              },
              { status: 409 }
            )
          }

          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Sync failed' },
            { status: 500 }
          )
        }
      },
    },
    {
      method: 'PATCH',
      path: '/accounts',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // company_id must come from the verified extension context, never fall
        // back to user.id (which is a different identifier dimension and would
        // silently mis-scope queries in multi-tenant deployments).
        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:accounts',
          identifier: user.id,
          ...RATE_LIMIT_ACCOUNTS,
        })
        if (!rl.ok) return rl.response!

        const body = await request.json().catch(() => null)
        const connection_id = body?.connection_id
        const enabled_uids = body?.enabled_uids
        const rawLookback = body?.initial_lookback_days
        const rawLookbackFromDate = body?.initial_lookback_from_date
        const account_mappings = body?.account_mappings

        if (typeof connection_id !== 'string' || !connection_id) {
          return NextResponse.json({ error: 'connection_id krävs' }, { status: 400 })
        }
        if (!Array.isArray(enabled_uids) || !enabled_uids.every(u => typeof u === 'string')) {
          return NextResponse.json({ error: 'enabled_uids måste vara en lista av strängar' }, { status: 400 })
        }
        if (enabled_uids.length === 0) {
          return NextResponse.json(
            { error: 'Välj minst ett konto, eller koppla bort banken om inga konton ska synkas.' },
            { status: 400 }
          )
        }
        if (enabled_uids.length > MAX_ENABLED_UIDS) {
          return NextResponse.json(
            { error: `Max ${MAX_ENABLED_UIDS} konton per anslutning.` },
            { status: 400 }
          )
        }

        // account_mappings is optional. When present, it's an array of
        // { uid, ledger_account } pairs that route per-account ingest to a
        // specific BAS account (e.g. EUR account → 1932 instead of the default 1930).
        // Restrict to BAS class 19 (kassa/bank). Accepting e.g. 3001 (revenue)
        // or 2640 (input VAT) here would silently misroute every bank-side
        // journal-entry leg into a revenue/VAT account, corrupting both the
        // ledger and momsdeklaration. The chart-of-accounts existence check
        // below is necessary but not sufficient: those accounts likely do
        // exist in the chart, but they're the wrong class.
        const BAS_ACCOUNT_PATTERN = /^19[0-9]{2}$/
        type AccountMapping = { uid: string; ledger_account?: string | null }
        let mappings: AccountMapping[] = []
        if (account_mappings !== undefined) {
          if (!Array.isArray(account_mappings)) {
            return NextResponse.json(
              { error: 'account_mappings måste vara en lista' },
              { status: 400 }
            )
          }
          for (const m of account_mappings) {
            if (!m || typeof m !== 'object' || typeof m.uid !== 'string') {
              return NextResponse.json(
                { error: 'account_mappings: varje post kräver uid (sträng)' },
                { status: 400 }
              )
            }
            if (m.ledger_account != null && (typeof m.ledger_account !== 'string' || !BAS_ACCOUNT_PATTERN.test(m.ledger_account))) {
              return NextResponse.json(
                { error: 'account_mappings: ledger_account måste vara ett BAS-konto i klass 19 (1900-1999)' },
                { status: 400 }
              )
            }
          }
          mappings = account_mappings as AccountMapping[]
        }

        // initial_lookback_days only applies on the pending_selection→active transition.
        // Default 120; clamp to [30, 365]. Ignored for selection edits.
        // PSD2 obliges ASPSPs to ~90 days without fresh SCA, but many Swedish banks
        // return more if asked: request 120 and accept whatever the bank gives back.
        //
        // If the client sent initial_lookback_from_date (preferred for fiscal-year-anchored
        // backfills), derive days from that and reject future dates outright. Otherwise
        // fall back to initial_lookback_days (or the 120-day default).
        if (typeof rawLookbackFromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawLookbackFromDate)) {
          const from = new Date(rawLookbackFromDate + 'T00:00:00Z')
          if (!Number.isFinite(from.getTime())) {
            return NextResponse.json(
              { error: 'initial_lookback_from_date är inte ett giltigt datum.' },
              { status: 400 }
            )
          }
          const diffMs = Date.now() - from.getTime()
          const daysFromDate = Math.ceil(diffMs / (24 * 60 * 60 * 1000))
          if (daysFromDate <= 0) {
            return NextResponse.json(
              { error: 'initial_lookback_from_date måste ligga i det förflutna.' },
              { status: 400 }
            )
          }
        }
        const initialLookbackDays = (() => {
          if (typeof rawLookbackFromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawLookbackFromDate)) {
            const from = new Date(rawLookbackFromDate + 'T00:00:00Z')
            // Future/invalid dates already rejected above; days > 0 is guaranteed.
            const diffMs = Date.now() - from.getTime()
            const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000))
            return Math.min(365, Math.max(1, days))
          }
          const n = typeof rawLookback === 'number' && Number.isFinite(rawLookback) ? rawLookback : 120
          return Math.min(365, Math.max(30, Math.round(n)))
        })()

        const { data: connection, error: connectionError } = await supabase
          .from('bank_connections')
          .select('id, status, accounts_data, bank_name')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (connectionError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        if (connection.status !== 'pending_selection' && connection.status !== 'active') {
          return NextResponse.json(
            { error: 'Anslutningen kan inte konfigureras i nuvarande status.' },
            { status: 400 }
          )
        }

        const existing = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))
        const knownUids = new Set(existing.map(a => a.uid))
        const unknownUids = enabled_uids.filter(uid => !knownUids.has(uid))
        if (unknownUids.length > 0) {
          return NextResponse.json(
            { error: 'Ett eller flera konton kunde inte hittas.', unknown_uids: unknownUids },
            { status: 400 }
          )
        }

        // Mirror the enabled_uids guard for account_mappings: without this,
        // a typo'd UID in the mapping list is silently dropped (the entry
        // never lands in the resulting accounts_data) while the response is
        // still 200, leaving the client to believe the mapping was applied.
        const unknownMappingUids = mappings.map(m => m.uid).filter(uid => !knownUids.has(uid))
        if (unknownMappingUids.length > 0) {
          return NextResponse.json(
            { error: 'account_mappings innehåller okända konto-uid.', unknown_uids: unknownMappingUids },
            { status: 400 }
          )
        }

        // Verify any provided ledger_account values actually exist in the
        // company's chart of accounts. Prevents users from typing arbitrary
        // numbers via the API and breaking journal entry creation later.
        const requestedLedgerAccounts = mappings
          .map(m => m.ledger_account)
          .filter((a): a is string => typeof a === 'string')
        if (requestedLedgerAccounts.length > 0) {
          const { data: chartRows } = await supabase
            .from('chart_of_accounts')
            .select('account_number')
            .eq('company_id', companyId)
            .in('account_number', requestedLedgerAccounts)
          const validAccountNumbers = new Set((chartRows || []).map(r => r.account_number as string))
          const invalid = requestedLedgerAccounts.filter(a => !validAccountNumbers.has(a))
          if (invalid.length > 0) {
            return NextResponse.json(
              {
                error: 'Ett eller flera bokföringskonton finns inte i kontoplanen.',
                invalid_accounts: invalid,
              },
              { status: 400 }
            )
          }
        }

        const enabledSet = new Set(enabled_uids)
        const mappingsByUid = new Map(mappings.map(m => [m.uid, m]))
        const updatedAccounts: StoredAccount[] = existing.map(a => {
          const mapping = mappingsByUid.get(a.uid)
          return {
            ...a,
            enabled: enabledSet.has(a.uid),
            // Apply ledger_account from mapping when present. Explicit null clears it.
            // Absent mapping leaves the existing ledger_account untouched (back-compat
            // with selection-edit calls that don't include account_mappings).
            ...(mapping
              ? { ledger_account: mapping.ledger_account ?? undefined }
              : {}),
          }
        })

        // Resolve the effective mirror ledger for every account up front and
        // reject collisions with a 400 — the mirror pass below writes into
        // cash_accounts, whose UNIQUE (company_id, ledger_account) constraint
        // would otherwise fail per-account and get swallowed, leaving accounts
        // silently unmirrored.
        const { allocatePsd2LedgerAccount, upsertFromPsd2 } = await import(
          '@/lib/cash-accounts/service'
        )

        const { data: companyCashRows } = await supabase
          .from('cash_accounts')
          .select('external_uid, bank_connection_id, ledger_account')
          .eq('company_id', companyId)
        const cashRows = (companyCashRows ?? []) as Array<{
          external_uid: string | null
          bank_connection_id: string | null
          ledger_account: string
        }>
        const existingLedgerByUid = new Map(
          cashRows
            .filter(r => r.bank_connection_id === connection.id && r.external_uid)
            .map(r => [r.external_uid as string, r.ledger_account])
        )
        // Slots held by OTHER connections' PSD2 accounts — an explicit mapping
        // onto one of those would violate the unique constraint. Manual rows
        // are not foreign: upsertFromPsd2 promotes them in place.
        const foreignConnectedLedgers = new Set(
          cashRows
            .filter(r => r.bank_connection_id !== null && r.bank_connection_id !== connection.id)
            .map(r => r.ledger_account)
        )

        const effectiveLedgerByUid = new Map<string, string>()
        const usedLedgers = new Set<string>()
        const duplicateLedgers = new Set<string>()
        const conflictingLedgers = new Set<string>()

        // First pass: accounts with an explicit or previously mirrored ledger.
        for (const a of updatedAccounts) {
          const ledger = a.ledger_account ?? existingLedgerByUid.get(a.uid)
          if (!ledger) continue
          if (usedLedgers.has(ledger)) duplicateLedgers.add(ledger)
          if (foreignConnectedLedgers.has(ledger) && existingLedgerByUid.get(a.uid) !== ledger) {
            conflictingLedgers.add(ledger)
          }
          usedLedgers.add(ledger)
          effectiveLedgerByUid.set(a.uid, ledger)
        }

        if (duplicateLedgers.size > 0) {
          return NextResponse.json(
            {
              error: 'Flera bankkonton kan inte bokföras på samma konto. Välj olika bokföringskonton.',
              duplicate_accounts: [...duplicateLedgers],
            },
            { status: 400 }
          )
        }
        if (conflictingLedgers.size > 0) {
          return NextResponse.json(
            {
              error: 'Bokföringskontot används redan av ett bankkonto från en annan bankanslutning.',
              conflicting_accounts: [...conflictingLedgers],
            },
            { status: 400 }
          )
        }

        // Second pass: allocate a free slot for accounts with no ledger at all
        // (legacy connections mirrored before allocation existed, or mappings
        // explicitly cleared). Allocation failure must never block selection
        // save — fall back to the pre-allocator behavior (1930) and let the
        // mirror pass surface any collision per-account, as before.
        for (const a of updatedAccounts) {
          if (effectiveLedgerByUid.has(a.uid)) continue
          let allocated: string | null = null
          try {
            allocated = await allocatePsd2LedgerAccount(supabase, companyId, user.id, {
              currency: a.currency,
              accountName: a.name,
              exclude: usedLedgers,
            })
          } catch (allocErr) {
            log.warn('[enable-banking] ledger allocation failed on selection save', {
              connectionId: connection.id,
              uid: a.uid,
              error: allocErr instanceof Error ? allocErr.message : String(allocErr),
            })
          }
          const ledger = allocated ?? '1930'
          usedLedgers.add(ledger)
          effectiveLedgerByUid.set(a.uid, ledger)
        }

        // accounts_data mirrors the resolved assignment so the picker
        // pre-fills reality on the next open.
        for (const a of updatedAccounts) {
          a.ledger_account = effectiveLedgerByUid.get(a.uid)
        }

        // State machine: only transition pending_selection → active. Once
        // active, the status field is omitted from the update so the same
        // endpoint can be reused to change account selection without
        // re-asserting a transition that has already happened.
        const updatePayload: { accounts_data: StoredAccount[]; status?: 'active' } = {
          accounts_data: updatedAccounts,
        }
        if (connection.status === 'pending_selection') {
          updatePayload.status = 'active'
        }

        const { error: updateError } = await supabase
          .from('bank_connections')
          .update(updatePayload)
          .eq('id', connection.id)

        if (updateError) {
          log.error('[enable-banking] Failed to update account selection', {
            errorMessage: updateError.message,
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
          return NextResponse.json({ error: 'Kunde inte spara kontoval' }, { status: 500 })
        }

        // Mirror the user's selection into cash_accounts so routing decisions
        // and reconciliation pick up the new enabled state + ledger mapping
        // without reading the JSONB column.
        {
          for (const a of updatedAccounts) {
            try {
              await upsertFromPsd2(supabase, companyId, {
                bank_connection_id: connection.id,
                external_uid: a.uid,
                currency: a.currency,
                ledger_account: a.ledger_account ?? '1930',
                iban: a.iban ?? null,
                name: a.name ?? null,
                balance: a.balance ?? null,
                balance_updated_at: a.balance_updated_at ?? null,
                enabled: a.enabled ?? true,
              })
            } catch (cashErr) {
              log.error('[enable-banking] Failed to mirror cash_account on selection save', {
                connectionId: connection.id,
                uid: a.uid,
                error: cashErr instanceof Error ? cashErr.message : String(cashErr),
              })
            }
          }
        }

        const newStatus = updatePayload.status ?? connection.status
        log.info('[enable-banking] Account selection saved', {
          connectionId: connection.id,
          enabledCount: enabled_uids.length,
          totalCount: existing.length,
          previousStatus: connection.status,
          newStatus,
          userId: user.id,
          companyId,
        })

        try {
          const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
          await emit({
            type: 'bank_connection.account_selection_changed',
            payload: {
              connectionId: connection.id,
              bankName: (connection as { bank_name?: string | null }).bank_name ?? null,
              previousStatus: connection.status,
              newStatus,
              enabledCount: enabled_uids.length,
              totalCount: existing.length,
              userId: user.id,
              companyId,
            },
          })
        } catch (emitError) {
          log.error('[enable-banking] Failed to emit account selection event', {
            errorMessage: emitError instanceof Error ? emitError.message : String(emitError),
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
        }

        // Initial backfill on activation. Run inline so the user has data the
        // moment they finish account selection: no 24h cron wait. Failures
        // here don't fail the PATCH; the cron will retry on its next run
        // (gated on initial_sync_completed_at IS NULL).
        let initialSyncSummary: {
          imported: number
          duplicates: number
          requested_from: string
          returned_min_date: string | null
          returned_max_date: string | null
        } | null = null
        let initialSyncError: string | null = null

        if (connection.status === 'pending_selection') {
          const accountsToSync = updatedAccounts.filter(a => a.enabled !== false)
          const toDate = new Date().toISOString().split('T')[0]
          const fromDate = new Date(Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0]

          log.info('[enable-banking] Starting inline initial backfill', {
            connectionId: connection.id,
            accountCount: accountsToSync.length,
            lookbackDays: initialLookbackDays,
            fromDate,
            toDate,
          })

          let timeoutHandle: ReturnType<typeof setTimeout> | undefined
          try {
            const ingestFn = ctx?.services.ingestTransactions
            const syncPromise = Promise.all(
              accountsToSync.map(account => syncAccountTransactions(
                supabase,
                companyId,
                user.id,
                connection.id,
                account,
                fromDate,
                toDate,
                ingestFn,
                { strategy: 'longest' }
              ))
            )
            // If the timeout wins the race, the underlying Promise.all keeps
            // running. Without a registered handler, a late rejection from the
            // bank API would surface as an unhandledRejection: Node 22 (the
            // self-hosted Docker runtime) terminates the process by default on
            // those, taking the whole server down. The cron retries the
            // backfill via initial_sync_completed_at IS NULL, so a no-op
            // catch is the right policy here.
            syncPromise.catch(() => {})

            const TIMEOUT_MS = 60_000
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error('initial_sync_timeout')), TIMEOUT_MS)
            })
            const results = await Promise.race([syncPromise, timeoutPromise])

            const totalImported = results.reduce((sum, r) => sum + r.imported, 0)
            const totalDuplicates = results.reduce((sum, r) => sum + r.duplicates, 0)

            // Min/max booking date across all synced accounts
            const minDates = results.map(r => r.returnedMinBookingDate).filter((d): d is string => !!d)
            const maxDates = results.map(r => r.returnedMaxBookingDate).filter((d): d is string => !!d)
            const returnedMin = minDates.length > 0 ? minDates.reduce((a, b) => (a < b ? a : b)) : null
            const returnedMax = maxDates.length > 0 ? maxDates.reduce((a, b) => (a > b ? a : b)) : null

            const completedAt = new Date().toISOString()
            // Don't re-write accounts_data here: the first update already wrote it.
            // Including it again races with any concurrent writer (e.g. cron firing in
            // the sub-60s window) and would silently overwrite their changes.
            const { error: metaUpdateError } = await supabase
              .from('bank_connections')
              .update({
                last_synced_at: completedAt,
                initial_sync_completed_at: completedAt,
                initial_sync_requested_from: fromDate,
                initial_sync_returned_min_date: returnedMin,
                initial_sync_returned_max_date: returnedMax,
                initial_sync_lookback_days: initialLookbackDays,
              })
              .eq('id', connection.id)

            if (metaUpdateError) {
              // The sync itself succeeded (transactions are ingested) but we
              // couldn't persist that. Falsely reporting success would tell the
              // client "imported N transactions" while the DB still has
              // initial_sync_completed_at = NULL, causing the cron to re-run a
              // 90-day backfill next morning. Surface this as initial_sync_error
              // so the UI shows a "background sync needs retry" warning, and the
              // cron's gate (initial_sync_completed_at IS NULL) will self-heal.
              initialSyncError = `metadata_update_failed: ${metaUpdateError.message}`
              log.error('[enable-banking] Failed to persist initial_sync metadata after backfill', {
                connectionId: connection.id,
                error: metaUpdateError.message,
                userId: user.id,
                companyId,
              })
            } else {
              initialSyncSummary = {
                imported: totalImported,
                duplicates: totalDuplicates,
                requested_from: fromDate,
                returned_min_date: returnedMin,
                returned_max_date: returnedMax,
              }

              log.info('[enable-banking] Inline initial backfill complete', {
                connectionId: connection.id,
                ...initialSyncSummary,
              })
            }
          } catch (syncError) {
            initialSyncError = syncError instanceof Error ? syncError.message : String(syncError)
            log.error('[enable-banking] Inline initial backfill failed: cron will retry', {
              connectionId: connection.id,
              error: initialSyncError,
              userId: user.id,
              companyId,
            })
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle)
          }
        }

        return NextResponse.json({
          success: true,
          enabled_count: enabled_uids.length,
          total_count: existing.length,
          ...(initialSyncSummary ? { initial_sync: initialSyncSummary } : {}),
          ...(initialSyncError ? { initial_sync_error: initialSyncError } : {}),
        })
      },
    },
    {
      method: 'DELETE',
      path: '/disconnect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }
        const companyId = ctx.companyId

        const rl = await checkRateLimit({
          prefix: 'enable-banking:disconnect',
          identifier: user.id,
          ...RATE_LIMIT_DISCONNECT,
        })
        if (!rl.ok) return rl.response!

        const { connection_id } = await request.json()

        if (!connection_id) {
          return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
        }

        const { data: connection, error: findError } = await supabase
          .from('bank_connections')
          .select('id, session_id, status, bank_name')
          .eq('id', connection_id)
          .eq('company_id', companyId)
          .single()

        if (findError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        // Revoke PSD2 consent if session exists
        if (connection.session_id) {
          try {
            await deleteSession(connection.session_id)
          } catch (error) {
            log.error('[enable-banking] Failed to revoke PSD2 session (may be expired)', {
              message: error instanceof Error ? error.message : String(error),
              sessionId: connection.session_id,
              connectionId: connection_id,
              connectionStatus: connection.status,
              userId: user.id,
              companyId,
            })
          }
        }

        const { error: updateError } = await supabase
          .from('bank_connections')
          .update({ status: 'revoked', session_id: null })
          .eq('id', connection.id)

        if (updateError) {
          log.error('[enable-banking] Failed to mark connection revoked', {
            errorMessage: updateError.message,
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
          return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
        }

        try {
          const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
          await emit({
            type: 'bank_connection.revoked',
            payload: {
              connectionId: connection.id,
              bankName: (connection as { bank_name?: string | null }).bank_name ?? null,
              userId: user.id,
              companyId,
            },
          })
        } catch (emitError) {
          log.error('[enable-banking] Failed to emit revoke event', {
            errorMessage: emitError instanceof Error ? emitError.message : String(emitError),
            connectionId: connection.id,
            userId: user.id,
            companyId,
          })
        }

        return NextResponse.json({ success: true })
      },
    },
  ],

  eventHandlers: [],
}
