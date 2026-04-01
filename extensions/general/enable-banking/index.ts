import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  startAuthorization,
  getASPSPs,
  deleteSession,
  isSandboxMode,
  type ASPSP,
} from './lib/api-client'
import { syncAccountTransactions } from './lib/sync'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import type { StoredAccount } from './types'
import type { Transaction } from '@/types'

/**
 * Enable Banking (PSD2) extension
 *
 * Provides automatic bank transaction sync via PSD2 open banking.
 * This is an opt-in extension — uncomment the import in loader.ts to activate.
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
          const aspsps = await getASPSPs('SE')
          const banks = aspsps.map((aspsp: ASPSP) => ({
            name: aspsp.name,
            country: aspsp.country,
            logo: aspsp.logo,
            bic: aspsp.bic,
          }))
          return NextResponse.json({ banks, sandbox: isSandboxMode() })
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

        const { aspsp_name, aspsp_country } = await request.json()

        if (!aspsp_name || !aspsp_country) {
          return NextResponse.json(
            { error: 'aspsp_name and aspsp_country are required' },
            { status: 400 }
          )
        }

        try {
          // Determine PSU type from entity type
          const { data: companySettings } = await supabase
            .from('company_settings')
            .select('entity_type')
            .eq('company_id', ctx?.companyId ?? user.id)
            .single()

          const psuType = companySettings?.entity_type === 'aktiebolag' ? 'business' : 'personal'

          log.info('[enable-banking] Starting bank connection', {
            user_id: user.id,
            bank: aspsp_name,
            country: aspsp_country,
            entity_type: companySettings?.entity_type,
            psu_type: psuType,
          })

          // Reject if there's already a recent pending connection for this user+bank
          // to prevent double-click race conditions that confuse the bank's consent flow
          const { data: recentPending } = await supabase
            .from('bank_connections')
            .select('id, created_at')
            .eq('company_id', ctx?.companyId ?? user.id)
            .eq('bank_name', aspsp_name)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (recentPending) {
            const pendingAge = Date.now() - new Date(recentPending.created_at).getTime()
            const STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

            if (pendingAge < STALE_THRESHOLD_MS) {
              log.info('[enable-banking] Rejecting duplicate connect — recent pending exists', {
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
              .eq('company_id', ctx?.companyId ?? user.id)
              .eq('bank_name', aspsp_name)
              .eq('status', 'pending')
          }

          const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/extensions/enable-banking/callback`

          // Generate cryptographic state token for CSRF protection
          const oauthState = crypto.randomUUID()

          const { url, authorization_id } = await startAuthorization(
            aspsp_name,
            aspsp_country,
            redirectUrl,
            oauthState,
            psuType
          )

          const { data: connection, error } = await supabase
            .from('bank_connections')
            .insert({
              company_id: ctx?.companyId ?? user.id,
              user_id: user.id,
              provider: `${aspsp_name.toLowerCase().replace(/\s+/g, '-')}-${aspsp_country.toLowerCase()}`,
              bank_name: aspsp_name,
              authorization_id,
              oauth_state: oauthState,
              status: 'pending',
            })
            .select()
            .single()

          if (error) {
            log.error('[enable-banking] Database error storing connection', {
              errorMessage: error.message,
              errorCode: error.code,
              errorDetails: error.details,
              user_id: user.id,
              bank: aspsp_name,
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

        const { connection_id, days_back: rawDaysBack = 30 } = await request.json()
        const days_back = Math.min(Math.max(1, rawDaysBack), 365)

        const { data: connection, error: connectionError } = await supabase
          .from('bank_connections')
          .select('*')
          .eq('id', connection_id)
          .eq('company_id', ctx?.companyId ?? user.id)
          .single()

        if (connectionError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        if (connection.status !== 'active') {
          return NextResponse.json({ error: 'Connection is not active' }, { status: 400 })
        }

        try {
          const accounts = (connection.accounts_data as StoredAccount[] || []).map(a => ({ ...a }))

          const toDate = new Date().toISOString().split('T')[0]
          const fromDate = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0]
          const syncStartedAt = new Date().toISOString()

          // Use ctx.services.ingestTransactions when available
          const ingestFn = ctx?.services.ingestTransactions

          // Detect SIE overlap — skip auto-categorization if the sync range
          // overlaps with a completed SIE import to prevent double-booking.
          // Reconciliation still links bank transactions to existing GL lines.
          const { data: sieOverlap } = await supabase
            .from('sie_imports')
            .select('id')
            .eq('company_id', ctx?.companyId ?? user.id)
            .eq('status', 'completed')
            .gte('fiscal_year_end', fromDate)
            .limit(1)
            .maybeSingle()

          const syncOptions = sieOverlap
            ? { skipAutoCategorization: true }
            : undefined

          if (sieOverlap) {
            log.info('SIE import overlap detected — suppressing auto-categorization', {
              sieImportId: sieOverlap.id,
              fromDate,
              toDate,
            })
          }

          const companyId = ctx?.companyId ?? user.id
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
          if (sieOverlap && totalImported > 0) {
            try {
              const reconResult = await runReconciliation(supabase, ctx?.companyId ?? user.id, {
                dateFrom: fromDate,
                dateTo: toDate,
              })
              if (reconResult.applied > 0) {
                log.info('Post-sync batch reconciliation matched additional transactions', {
                  applied: reconResult.applied,
                  total: reconResult.matches.length,
                })
              }
            } catch {
              // Non-critical — transactions remain uncategorized for manual review
            }
          }

          const syncedAt = new Date().toISOString()
          await supabase
            .from('bank_connections')
            .update({
              accounts_data: accounts,
              last_synced_at: syncedAt,
            })
            .eq('id', connection.id)

          if (totalImported > 0) {
            const { data: syncedTransactions } = await supabase
              .from('transactions')
              .select('*')
              .eq('company_id', ctx?.companyId ?? user.id)
              .eq('bank_connection_id', connection.id)
              .gte('created_at', syncStartedAt)
              .order('created_at', { ascending: false })
              .limit(totalImported)

            if (syncedTransactions && syncedTransactions.length > 0) {
              const emit = ctx?.emit ?? (await import('@/lib/events/bus')).eventBus.emit.bind((await import('@/lib/events/bus')).eventBus)
              await emit({
                type: 'transaction.synced',
                payload: { transactions: syncedTransactions as Transaction[], userId: user.id, companyId: ctx?.companyId ?? user.id },
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
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Sync failed' },
            { status: 500 }
          )
        }
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

        const { connection_id } = await request.json()

        if (!connection_id) {
          return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
        }

        const { data: connection, error: findError } = await supabase
          .from('bank_connections')
          .select('id, session_id, status')
          .eq('id', connection_id)
          .eq('company_id', ctx?.companyId ?? user.id)
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
            })
          }
        }

        const { error: updateError } = await supabase
          .from('bank_connections')
          .update({ status: 'revoked', session_id: null })
          .eq('id', connection.id)

        if (updateError) {
          return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
      },
    },
  ],

  eventHandlers: [],
}
