import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import {
  buildAuthorizeUrl,
  deauthorizeAccount,
  isStripeConnectConfigured,
  isLiveMode,
} from './lib/connect'
import {
  createInvoicePaymentLink,
  handleCreditNoteCreated,
  handleInvoicePaid,
} from './lib/payment-links'
import {
  STRIPE_LEDGER_ACCOUNT,
  syncStripeBalanceTransactions,
  type StripeTransactionSyncSummary,
} from './lib/transaction-sync'
import { feedConnectorRoutes, type FeedConnectorSpec } from '@/lib/feed-sync/connector-routes'
import { MAX_BACKFILL_YEARS } from './types'
import { stockholmWallTimeToUtc } from '@/lib/dates/iso'
import type { StripeConnection } from './types'

// Per-user limit: connect is an outward-facing OAuth operation.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }

// A pending row younger than this blocks a second connect attempt so a
// double-click cannot start two OAuth round-trips (only one state would
// survive, stranding the other at the callback).
const PENDING_FRESH_MS = 60_000

const NOT_CONFIGURED_MESSAGE =
  'Stripe-integrationen är inte konfigurerad på den här installationen.'

/**
 * Status, sync, backfill, the nightly toggle and disconnect: the shared feed
 * routes (lib/feed-sync/connector-routes). Feed-only (2026-07-24): the sync
 * imports balance transactions into the inbox and books nothing. The manual
 * run has the shops' budget (MANUAL_SYNC_BUDGET_MS), so it ends inside the
 * panel's STRIPE_SYNC_TIMEOUT_MS; the cursor persists per window and chunk,
 * so the next sync goes on where it stopped.
 */
export const stripeFeed: FeedConnectorSpec<StripeConnection, StripeTransactionSyncSummary> = {
  extensionId: 'stripe',
  table: 'stripe_connections',
  capability: CAPABILITY.stripe_payments,
  cursorColumn: 'last_balance_txn_synced_at',
  maxBackfillYears: MAX_BACKFILL_YEARS,
  // Rows are dated on the Swedish day (transaction-sync isoDate), so the
  // chosen day starts at Swedish midnight (crm#1344).
  backfillCursor: (day) => stockholmWallTimeToUtc(day, '00:00').toISOString(),
  settlementAccounts: [STRIPE_LEDGER_ACCOUNT],
  notConnectedMessage: 'Inget anslutet Stripe-konto.',
  statusColumns:
    'id, status, stripe_account_id, livemode, display_name, error_message, connected_at, last_event_created_at, transaction_sync_enabled, last_balance_txn_synced_at',
  isConfigured: isStripeConnectConfigured,
  sync: (supabase, connection, deadlineMs) =>
    syncStripeBalanceTransactions(supabase, connection, undefined, deadlineMs),
  disconnect: {
    columns: 'stripe_account_id',
    // Best effort: an already-severed connection throws at Stripe, which is
    // fine (the goal state is reached either way).
    revokeRemote: async (connection) => {
      if (connection.status === 'active' && typeof connection.stripe_account_id === 'string') {
        await deauthorizeAccount(connection.stripe_account_id)
      }
    },
    clearColumns: ['oauth_state'],
    eventIdentity: (connection) => ({ stripeAccountId: (connection.stripe_account_id as string | null) ?? null }),
  },
}

/**
 * Stripe Connect extension
 *
 * Connects a company's Stripe account via Connect OAuth (Standard accounts).
 * Auto-creates a Stripe Payment Link when an invoice is sent, and imports the
 * account's balance transactions into the transactions inbox as a bank feed
 * for the Stripe balance (1686). Feed-only by decision 2026-07-24: nothing is
 * auto-booked.
 *
 * Required environment variables:
 * - STRIPE_SECRET_KEY (the platform account key, shared with billing)
 * - STRIPE_CONNECT_CLIENT_ID (ca_... from the platform's Connect settings)
 */
export const stripeExtension: Extension = {
  id: 'stripe',
  name: 'Stripe-betalningar',
  version: '1.0.0',

  // Core-callable services, resolved via the extension registry (core never
  // imports extension code). The send routes use this to auto-fill
  // invoices.payment_link_url before the email/PDF render.
  services: {
    createInvoicePaymentLink,
  },

  eventHandlers: [
    // A settled or credited invoice must stop accepting money through its link.
    { eventType: 'invoice.paid', handler: handleInvoicePaid },
    { eventType: 'credit_note.created', handler: handleCreditNoteCreated },
  ],

  apiRoutes: [
    ...feedConnectorRoutes(stripeFeed),
    {
      method: 'POST',
      path: '/connect',
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase
        const companyId = ctx.companyId

        // Anonymous/sandbox users must never reach Stripe (same doctrine as
        // billing checkout: the sandbox never talks to external services).
        // The anon check is identity truth and runs first (no DB round trip).
        if (ctx.isAnonymous) return sandboxBlockedResponse()
        const sandboxBlocked = await guardSandbox(supabase, companyId)
        if (sandboxBlocked) return sandboxBlocked

        const capabilityBlocked = await requireCapability(
          supabase,
          companyId,
          CAPABILITY.stripe_payments,
        )
        if (capabilityBlocked) return capabilityBlocked

        const rl = await checkRateLimit({
          prefix: 'stripe:connect',
          identifier: ctx.userId,
          ...RATE_LIMIT_CONNECT,
        })
        if (!rl.ok) return rl.response!

        if (!isStripeConnectConfigured()) {
          return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
        }

        const { data: existing } = await supabase
          .from('stripe_connections')
          .select('id, status, created_at')
          .eq('company_id', companyId)
          .in('status', ['active', 'pending'])
          .order('created_at', { ascending: false })

        if (existing?.some((c) => c.status === 'active')) {
          return NextResponse.json(
            { error: 'Företaget har redan ett anslutet Stripe-konto. Koppla från det först.' },
            { status: 409 },
          )
        }

        const pending = existing?.filter((c) => c.status === 'pending') ?? []
        const freshPending = pending.find(
          (c) => Date.now() - new Date(c.created_at).getTime() < PENDING_FRESH_MS,
        )
        if (freshPending) {
          return NextResponse.json(
            { error: 'En anslutning pågår redan. Vänta och försök igen.' },
            { status: 409 },
          )
        }
        if (pending.length > 0) {
          // Supersede stale pending attempts so their oauth_state can never
          // complete a callback after this new round-trip starts.
          await supabase
            .from('stripe_connections')
            .update({
              status: 'error',
              error_message: 'Superseded by new connection attempt',
              oauth_state: null,
            })
            .eq('company_id', companyId)
            .eq('status', 'pending')
        }

        // Persist the CSRF state BEFORE handing the user to Stripe: the
        // callback locates the row by oauth_state alone, so the row must
        // exist before Stripe can ever redirect back with that state.
        const oauthState = crypto.randomUUID()
        const { data: created, error: insertError } = await supabase
          .from('stripe_connections')
          .insert({
            company_id: companyId,
            user_id: ctx.userId,
            status: 'pending',
            oauth_state: oauthState,
            livemode: isLiveMode(),
          })
          .select('id')
          .single()

        if (insertError || !created) {
          log.error('[stripe] Failed to stage pending connection', {
            message: insertError?.message,
            code: insertError?.code,
            companyId,
          })
          return NextResponse.json(
            { error: 'Kunde inte starta anslutningen. Försök igen.' },
            { status: 500 },
          )
        }

        log.info('[stripe] Starting Connect OAuth', {
          connection_id: created.id,
          company_id: companyId,
          livemode: isLiveMode(),
        })

        return NextResponse.json({ url: buildAuthorizeUrl(oauthState) })
      },
    },
  ],
}

export default stripeExtension
