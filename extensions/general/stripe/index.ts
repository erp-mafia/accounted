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
import { syncStripeConnection } from './lib/sync'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { StripeConnection, StripeStatusResponse } from './types'

// Per-user limits: connect/disconnect are outward-facing OAuth operations,
// sync hits the Stripe API.
const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }

// A pending row younger than this blocks a second connect attempt so a
// double-click cannot start two OAuth round-trips (only one state would
// survive, stranding the other at the callback).
const PENDING_FRESH_MS = 60_000

const NOT_CONFIGURED_MESSAGE =
  'Stripe-integrationen är inte konfigurerad på den här installationen.'

/**
 * Stripe Connect extension
 *
 * Connects a company's Stripe account via Connect OAuth (Standard accounts).
 * Auto-creates a Stripe Payment Link when an invoice is sent, marks invoices
 * paid from Stripe checkout events, and books payouts (gross/fees/net) against
 * the 1686 clearing account.
 *
 * Required environment variables:
 * - STRIPE_SECRET_KEY (the platform account key, shared with billing)
 * - STRIPE_CONNECT_CLIENT_ID (ca_... from the platform's Connect settings)
 */
export const stripeExtension: Extension = {
  id: 'stripe',
  name: 'Stripe-betalningar',
  version: '1.0.0',

  settingsPanel: {
    label: 'Betalningar (Stripe)',
    path: '/settings/payments',
  },

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
    {
      method: 'GET',
      path: '/status',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        if (!ctx?.companyId) {
          return NextResponse.json({ error: 'Company context required' }, { status: 400 })
        }

        // Prefer the active connection; otherwise surface the most recent row
        // so the panel can show pending/error/revoked states.
        const { data: rows } = await supabase
          .from('stripe_connections')
          .select(
            'id, status, stripe_account_id, livemode, display_name, error_message, connected_at, last_event_created_at',
          )
          .eq('company_id', ctx.companyId)
          .order('created_at', { ascending: false })
          .limit(10)

        const connection =
          rows?.find((r) => r.status === 'active') ?? rows?.[0] ?? null

        // Events + payouts the deterministic matcher refused to auto-apply.
        // Members can read both ledgers under RLS; the panel lists them for
        // manual handling.
        const { data: reviewRows, count: reviewCount } = await supabase
          .from('stripe_payment_events')
          .select('id, reason, amount, currency, invoice_id, event_created_at', {
            count: 'exact',
          })
          .eq('company_id', ctx.companyId)
          .eq('status', 'needs_review')
          .order('event_created_at', { ascending: false })
          .limit(5)

        const { data: payoutRows, count: payoutCount } = await supabase
          .from('stripe_payouts')
          .select('id, reason, amount, currency, event_created_at', { count: 'exact' })
          .eq('company_id', ctx.companyId)
          .eq('status', 'needs_review')
          .order('event_created_at', { ascending: false })
          .limit(5)

        const payload: StripeStatusResponse = {
          configured: isStripeConnectConfigured(),
          connection,
          needs_review_count: (reviewCount ?? 0) + (payoutCount ?? 0),
          needs_review: [
            ...(reviewRows ?? []),
            ...(payoutRows ?? []).map((p) => ({ ...p, invoice_id: null })),
          ],
        }
        return NextResponse.json(payload)
      },
    },
    {
      method: 'POST',
      path: '/sync',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
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

        const capabilityBlocked = await requireCapability(
          supabase,
          companyId,
          CAPABILITY.stripe_payments,
        )
        if (capabilityBlocked) return capabilityBlocked

        const rl = await checkRateLimit({
          prefix: 'stripe:sync',
          identifier: user.id,
          ...RATE_LIMIT_SYNC,
        })
        if (!rl.ok) return rl.response!

        // Membership-scoped lookup via the user client; the sync itself runs
        // on the service client because the event ledger is service-write-only.
        const { data: connection } = await supabase
          .from('stripe_connections')
          .select('*')
          .eq('company_id', companyId)
          .eq('status', 'active')
          .maybeSingle()

        if (!connection) {
          return NextResponse.json({ error: 'Inget anslutet Stripe-konto.' }, { status: 404 })
        }

        try {
          const serviceClient = createServiceClientNoCookies()
          const summary = await syncStripeConnection(
            serviceClient,
            connection as StripeConnection,
          )
          return NextResponse.json({ success: true, ...summary })
        } catch (error) {
          log.error('[stripe] Manual sync failed', {
            message: error instanceof Error ? error.message : String(error),
            connection_id: connection.id,
          })
          return NextResponse.json(
            { error: 'Synkroniseringen misslyckades. Försök igen.' },
            { status: 502 },
          )
        }
      },
    },
    {
      method: 'POST',
      path: '/connect',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
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

        // Anonymous/sandbox users must never reach Stripe (same doctrine as
        // billing checkout: the sandbox never talks to external services).
        // The anon check is identity truth and runs first (no DB round trip).
        if (user.is_anonymous) return sandboxBlockedResponse()
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
          identifier: user.id,
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
            user_id: user.id,
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
          prefix: 'stripe:disconnect',
          identifier: user.id,
          ...RATE_LIMIT_DISCONNECT,
        })
        if (!rl.ok) return rl.response!

        const body = (await request.json().catch(() => ({}))) as { connection_id?: string }

        const base = supabase
          .from('stripe_connections')
          .select('id, status, stripe_account_id')
          .eq('company_id', companyId)
        const query = body.connection_id
          ? base.eq('id', body.connection_id).limit(1)
          : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
        const { data: rows, error: findError } = await query
        const connection = rows?.[0] as
          | Pick<StripeConnection, 'id' | 'status' | 'stripe_account_id'>
          | undefined

        if (findError || !connection) {
          return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
        }

        // Best-effort revoke at Stripe: an already-severed connection throws,
        // which is fine (the goal state is reached either way). Logged at WARN
        // so a systematic revoke failure stays visible to monitoring.
        if (connection.status === 'active' && connection.stripe_account_id) {
          try {
            await deauthorizeAccount(connection.stripe_account_id)
          } catch (revokeError) {
            log.warn('[stripe] Deauthorize skipped (likely already revoked)', {
              message: revokeError instanceof Error ? revokeError.message : String(revokeError),
              connection_id: connection.id,
            })
          }
        }

        const { error: updateError } = await supabase
          .from('stripe_connections')
          .update({
            status: 'revoked',
            oauth_state: null,
            disconnected_at: new Date().toISOString(),
          })
          .eq('id', connection.id)
          .eq('company_id', companyId)

        if (updateError) {
          log.error('[stripe] Failed to mark connection revoked', {
            message: updateError.message,
            connection_id: connection.id,
          })
          return NextResponse.json(
            { error: 'Kunde inte koppla från. Försök igen.' },
            { status: 500 },
          )
        }

        if (ctx?.emit) {
          try {
            await ctx.emit({
              type: 'stripe.disconnected',
              payload: {
                connectionId: connection.id,
                stripeAccountId: connection.stripe_account_id,
                reason: 'user',
                userId: user.id,
                companyId,
              },
            })
          } catch {
            // Audit event failure must not block the disconnect itself.
          }
        }

        return NextResponse.json({ success: true })
      },
    },
  ],
}

export default stripeExtension
