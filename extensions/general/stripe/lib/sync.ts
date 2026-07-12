import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { eventBus } from '@/lib/events/bus'
import {
  settleInvoicePayment,
  type InvoiceWithCustomerName,
} from '@/lib/invoices/settle-invoice-payment'
import { createLogger, type Logger } from '@/lib/logger'
import type { EntityType } from '@/types'
import { connectedAccountOptions, isRevokedConnectionError } from './connect'
import { processPayoutPaidEvent } from './payouts'
import type { StripeConnection } from '../types'

const defaultLog = createLogger('stripe/sync')

/**
 * Stripe payment sync: polls the connected account's event stream and applies
 * checkout.session.completed events (payments through our auto-created invoice
 * payment links) to bookkeeping.
 *
 * Matching is DETERMINISTIC ONLY (project doctrine: act on exact keys, never
 * confidence). A session settles its invoice when ALL hold:
 *   - the session's payment link (or metadata.invoice_id fallback) resolves to
 *     an invoice in the connection's company
 *   - invoice status is payable (sent / overdue / partially_paid)
 *   - session amount equals the invoice's remaining amount exactly (öre)
 *   - currencies match, invoice currency is SEK (v1 automation scope)
 *   - session livemode matches the connection
 * Anything else is recorded as needs_review with a reason and surfaced in the
 * settings panel: never guessed at, never dropped silently.
 *
 * Settlement books Debit 1686 (Fordringar för kontokort) / Credit 1510 via the
 * shared settleInvoicePayment service: the money sits in the Stripe balance
 * until the payout, which clears 1686 against 1930 (payout booking).
 *
 * Idempotency: each event is claimed into stripe_payment_events under a
 * (connection, event id) unique constraint before processing; the polling
 * cursor always overlaps, so re-seen events are no-ops. Stale 'processing'
 * claims (a crash mid-run) are reclaimed after 1h.
 */

const EVENT_TYPES = ['checkout.session.completed', 'payout.paid'] as const
/** Re-poll overlap; unique constraints make the duplicates no-ops. */
const CURSOR_OVERLAP_SECONDS = 600
/** A 'processing' claim older than this is considered crashed and reclaimed. */
const STALE_CLAIM_MS = 60 * 60 * 1000
const PAYABLE_STATUSES = ['sent', 'overdue', 'partially_paid']

interface CheckoutSessionLike {
  id: string
  payment_link?: string | { id: string } | null
  payment_intent?: string | { id: string } | null
  amount_total?: number | null
  currency?: string | null
  payment_status?: string | null
  livemode?: boolean
  metadata?: Record<string, string> | null
}

export interface StripeSyncSummary {
  fetched: number
  settled: number
  payoutsBooked: number
  needsReview: number
  ignored: number
  alreadyProcessed: number
  /** Set when the connection turned out to be revoked upstream. */
  revoked?: boolean
  /** Set when the caller's time budget ran out before all events were processed. */
  deadlineReached?: boolean
}

type TerminalStatus = 'matched_booked' | 'needs_review' | 'ignored'

interface ProcessOutcome {
  status: TerminalStatus
  reason: string | null
  invoiceId: string | null
  journalEntryId: string | null
}

export async function syncStripeConnection(
  supabase: SupabaseClient,
  connection: StripeConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget (the cron
   * route). When it passes mid-batch the event loop stops BEFORE the next
   * unprocessed event; the cursor then advances only over what was actually
   * processed, so the next run resumes exactly where this one stopped.
   * Omitted (manual sync, tests): no budget, the full batch is processed.
   */
  deadlineMs?: number,
): Promise<StripeSyncSummary> {
  const summary: StripeSyncSummary = {
    fetched: 0,
    settled: 0,
    payoutsBooked: 0,
    needsReview: 0,
    ignored: 0,
    alreadyProcessed: 0,
  }
  if (!connection.stripe_account_id) return summary

  const stripe = getStripe()
  const opts = connectedAccountOptions(connection.stripe_account_id)

  // Poll window: from the cursor (with overlap) or, on the first run, from
  // when the connection was established: no payment links of ours exist
  // before that.
  const cursorMs = connection.last_event_created_at
    ? new Date(connection.last_event_created_at).getTime()
    : connection.connected_at
      ? new Date(connection.connected_at).getTime()
      : Date.now() - 24 * 60 * 60 * 1000
  const gte = Math.max(0, Math.floor(cursorMs / 1000) - CURSOR_OVERLAP_SECONDS)

  let events: Stripe.Event[]
  try {
    events = await stripe.events
      .list({ types: [...EVENT_TYPES], created: { gte }, limit: 100 }, opts)
      .autoPagingToArray({ limit: 1000 })
  } catch (err) {
    if (isRevokedConnectionError(err)) {
      log.warn('connection revoked upstream; marking revoked', {
        connectionId: connection.id,
      })
      await supabase
        .from('stripe_connections')
        .update({
          status: 'revoked',
          disconnected_at: new Date().toISOString(),
          error_message: 'Åtkomsten återkallades hos Stripe.',
        })
        .eq('id', connection.id)
      // An upstream revocation is the same outward-facing consent transition
      // as a user-initiated disconnect: land it in the audit trail too.
      try {
        await eventBus.emit({
          type: 'stripe.disconnected',
          payload: {
            connectionId: connection.id,
            stripeAccountId: connection.stripe_account_id,
            reason: 'revoked_upstream',
            userId: connection.user_id,
            companyId: connection.company_id,
          },
        })
      } catch {
        // Audit event failure must not block marking the connection revoked.
      }
      summary.revoked = true
      return summary
    }
    throw err
  }

  summary.fetched = events.length
  // Stripe returns newest first; apply oldest first so partial payments and
  // cursor advancement stay chronological.
  events.sort((a, b) => a.created - b.created)

  let maxCreated = 0
  let lastProcessedEventId: string | null = null
  let processedCount = 0
  for (const event of events) {
    // Enforce the time budget per event, not just per connection: a large
    // batch must not blow the cron's maxDuration. The fetch above is a single
    // bounded call; the expensive part is the per-event DB + bookkeeping work
    // below. Breaking here, before claiming or counting the event, keeps the
    // cursor behind the unprocessed tail so the next run picks it up.
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      summary.deadlineReached = true
      log.info('time budget exhausted mid-connection; stopping event batch', {
        connectionId: connection.id,
        processed: processedCount,
        remaining: events.length - processedCount,
      })
      break
    }

    maxCreated = Math.max(maxCreated, event.created)
    lastProcessedEventId = event.id
    processedCount++

    // Payouts run through their own idempotent ledger (stripe_payouts).
    if (event.type === 'payout.paid') {
      const payoutOutcome = await processPayoutPaidEvent(supabase, connection, event, log)
      if (payoutOutcome.status === 'booked') summary.payoutsBooked++
      else if (payoutOutcome.status === 'needs_review') summary.needsReview++
      else if (payoutOutcome.status === 'ignored') summary.ignored++
      else summary.alreadyProcessed++
      if (payoutOutcome.status === 'needs_review') {
        log.info('stripe payout not auto-booked', {
          connectionId: connection.id,
          eventId: event.id,
          reason: payoutOutcome.reason,
        })
      }
      continue
    }

    const claim = await claimEvent(supabase, connection, event)
    if (!claim) {
      summary.alreadyProcessed++
      continue
    }

    let outcome: ProcessOutcome
    try {
      outcome = await processCheckoutSessionEvent(supabase, connection, event, log)
    } catch (err) {
      // Unexpected processing failure: record for review rather than leaving
      // a dangling 'processing' claim until the stale-reclaim window.
      outcome = {
        status: 'needs_review',
        reason: `processing_failed: ${err instanceof Error ? err.message : String(err)}`,
        invoiceId: null,
        journalEntryId: null,
      }
    }

    await supabase
      .from('stripe_payment_events')
      .update({
        status: outcome.status,
        reason: outcome.reason,
        invoice_id: outcome.invoiceId,
        journal_entry_id: outcome.journalEntryId,
      })
      .eq('id', claim.id)

    if (outcome.status === 'matched_booked') summary.settled++
    else if (outcome.status === 'needs_review') summary.needsReview++
    else summary.ignored++

    if (outcome.status !== 'matched_booked') {
      log.info('stripe event not auto-applied', {
        connectionId: connection.id,
        eventId: event.id,
        status: outcome.status,
        reason: outcome.reason,
      })
    }
  }

  if (maxCreated > 0) {
    await supabase
      .from('stripe_connections')
      .update({
        last_event_created_at: new Date(maxCreated * 1000).toISOString(),
        last_event_id: lastProcessedEventId,
      })
      .eq('id', connection.id)
  }

  return summary
}

/**
 * Claim the event for processing. Returns the claim row id, or null when the
 * event was already handled (or is being handled) by an earlier run.
 */
async function claimEvent(
  supabase: SupabaseClient,
  connection: StripeConnection,
  event: Stripe.Event,
): Promise<{ id: string } | null> {
  const session = event.data.object as CheckoutSessionLike
  const { data: inserted } = await supabase
    .from('stripe_payment_events')
    .upsert(
      {
        company_id: connection.company_id,
        connection_id: connection.id,
        stripe_event_id: event.id,
        checkout_session_id: session.id ?? null,
        payment_intent_id: idOf(session.payment_intent),
        payment_link_id: idOf(session.payment_link),
        amount: typeof session.amount_total === 'number' ? session.amount_total / 100 : null,
        currency: session.currency?.toUpperCase() ?? null,
        status: 'processing',
        event_created_at: new Date(event.created * 1000).toISOString(),
      },
      { onConflict: 'connection_id,stripe_event_id', ignoreDuplicates: true },
    )
    .select('id')

  if (inserted && inserted.length > 0) return inserted[0] as { id: string }

  // Conflict: reclaim only if the prior claim crashed (stale 'processing').
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data: reclaimed } = await supabase
    .from('stripe_payment_events')
    .update({ status: 'processing' })
    .eq('connection_id', connection.id)
    .eq('stripe_event_id', event.id)
    .eq('status', 'processing')
    .lt('updated_at', staleBefore)
    .select('id')
  return reclaimed && reclaimed.length > 0 ? (reclaimed[0] as { id: string }) : null
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

async function processCheckoutSessionEvent(
  supabase: SupabaseClient,
  connection: StripeConnection,
  event: Stripe.Event,
  log: Logger,
): Promise<ProcessOutcome> {
  const session = event.data.object as CheckoutSessionLike
  const none = { invoiceId: null, journalEntryId: null }

  if (session.livemode !== connection.livemode) {
    return { status: 'ignored', reason: 'livemode_mismatch', ...none }
  }
  // Async payment methods emit checkout.session.completed with
  // payment_status 'unpaid'; money that has not arrived is not booked.
  if (session.payment_status && session.payment_status !== 'paid') {
    return { status: 'ignored', reason: `payment_status_${session.payment_status}`, ...none }
  }

  // Resolve the invoice: primary key is our stored payment link id; fallback
  // is the invoice id we stamped into the link metadata. Both are exact keys,
  // both scoped to the connection's company.
  const paymentLinkId = idOf(session.payment_link)
  // Only the customer's name is joined; InvoiceWithCustomerName models that
  // partial relation honestly (shared with the settlement boundary).
  let invoice: InvoiceWithCustomerName | null = null

  if (paymentLinkId) {
    const { data } = await supabase
      .from('invoices')
      .select('*, customer:customers(name), items:invoice_items(*)')
      .eq('company_id', connection.company_id)
      .eq('stripe_payment_link_id', paymentLinkId)
      .maybeSingle()
    invoice = data as InvoiceWithCustomerName | null
  }
  if (!invoice && session.metadata?.invoice_id) {
    const { data } = await supabase
      .from('invoices')
      .select('*, customer:customers(name), items:invoice_items(*)')
      .eq('company_id', connection.company_id)
      .eq('id', session.metadata.invoice_id)
      .maybeSingle()
    invoice = data as InvoiceWithCustomerName | null
  }

  if (!invoice) {
    return { status: 'needs_review', reason: 'invoice_not_found', ...none }
  }

  const outcomeBase = { invoiceId: invoice.id, journalEntryId: null }

  if (invoice.status === 'paid') {
    return { status: 'needs_review', reason: 'invoice_already_paid', ...outcomeBase }
  }
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    return {
      status: 'needs_review',
      reason: `invoice_not_payable_${invoice.status}`,
      ...outcomeBase,
    }
  }

  const sessionCurrency = session.currency?.toUpperCase()
  if (!sessionCurrency || sessionCurrency !== invoice.currency) {
    return { status: 'needs_review', reason: 'currency_mismatch', ...outcomeBase }
  }
  // v1 automation scope: SEK only. A non-SEK settlement needs FX handling on
  // both the clearing account and the payout leg; reviewed manually instead.
  if (invoice.currency !== 'SEK') {
    return { status: 'needs_review', reason: 'non_sek_invoice', ...outcomeBase }
  }

  const amount = typeof session.amount_total === 'number' ? session.amount_total / 100 : null
  const remaining = invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
  if (amount == null || Math.round(amount * 100) !== Math.round(remaining * 100)) {
    return { status: 'needs_review', reason: 'amount_mismatch', ...outcomeBase }
  }

  // maybeSingle: a company without a settings row is a legitimate no-result
  // case that falls back to the defaults below, not a swallowed error.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method, entity_type')
    .eq('company_id', connection.company_id)
    .maybeSingle()
  const accountingMethod = settings?.accounting_method || 'accrual'
  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  const paymentDate = new Date(event.created * 1000).toISOString().split('T')[0]

  const result = await settleInvoicePayment(supabase, connection.company_id, connection.user_id, {
    invoice,
    paymentAmountInInvoiceCurrency: amount,
    paymentDate,
    accountingMethod,
    entityType,
    // Money is in the Stripe balance, not the bank: settle against 1686
    // (Fordringar för kontokort); the payout later clears 1686 into 1930.
    settlementAccountNumber: '1686',
  })

  if (!result.ok) {
    const reason =
      result.code === 'BOOKKEEPING_ERROR'
        ? `bookkeeping_error: ${result.error instanceof Error ? result.error.message : String(result.error)}`
        : result.code.toLowerCase()
    return { status: 'needs_review', reason, ...outcomeBase }
  }

  log.info('stripe payment settled invoice', {
    connectionId: connection.id,
    invoiceId: invoice.id,
    journalEntryId: result.journalEntryId,
    amount,
  })

  return {
    status: 'matched_booked',
    reason: null,
    invoiceId: invoice.id,
    journalEntryId: result.journalEntryId,
  }
}
