import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { ensureWebshopPrefillAccounts } from '@/lib/webshop-orders/ensure-accounts'
import { roundOre } from '@/lib/money'
import type {
  CreateJournalEntryLineInput,
  Currency,
  JournalEntry,
  WebshopOrder,
} from '@/types'

/**
 * The server-side booking flow for one webshop order/refund row, extracted
 * from POST /api/webshop-orders/[id]/book so the bulk endpoint runs the exact
 * same code per order. Three composable steps, called in this order by both
 * routes:
 *
 *   1. assertOrderBookable(): state guards (already booked/invoiced, unpaid,
 *      refund-of-invoiced-parent, legacy transactions-feed overlap).
 *   2. resolveOrderFx(): booking-time retry for a missing SEK conversion on
 *      non-SEK rows.
 *   3. bookOrderThroughEngine(): chart repair for our own prefill accounts,
 *      then the race-free draft -> atomic claim -> commit sequence through
 *      lib/bookkeeping/engine (source_type 'webshop_order').
 *
 * Anything added to the single-order path (e.g. underlag anchoring) belongs
 * in these functions, never inline in one route, so single and bulk booking
 * can not drift apart.
 */

/** Guard failure: a structured-error code plus optional envelope details. */
export interface OrderBookableFailure {
  code:
    | 'WEBSHOP_ORDER_ALREADY_BOOKED'
    | 'WEBSHOP_ORDER_ALREADY_INVOICED'
    | 'WEBSHOP_ORDER_REFUND_PARENT_INVOICED'
    | 'WEBSHOP_ORDER_NOT_PAID'
    | 'WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED'
    | 'WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN'
  details?: Record<string, unknown>
}

/**
 * Re-check the order's state server-side (the client list can be stale).
 * Returns null when the row may be booked, otherwise the structured-error
 * code the route should answer with.
 */
export async function assertOrderBookable(
  supabase: SupabaseClient,
  companyId: string,
  order: WebshopOrder,
): Promise<OrderBookableFailure | null> {
  if (order.journal_entry_id) {
    return {
      code: 'WEBSHOP_ORDER_ALREADY_BOOKED',
      details: { journal_entry_id: order.journal_entry_id },
    }
  }
  if (order.invoice_id) {
    return {
      code: 'WEBSHOP_ORDER_ALREADY_INVOICED',
      details: { invoice_id: order.invoice_id },
    }
  }
  // Refunds of an invoiced order belong in the credit-note flow.
  if (order.row_type === 'refund' && order.parent_order_id) {
    const { data: parent } = await supabase
      .from('webshop_orders')
      .select('invoice_id')
      .eq('id', order.parent_order_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (parent?.invoice_id) {
      return {
        code: 'WEBSHOP_ORDER_REFUND_PARENT_INVOICED',
        details: { invoice_id: parent.invoice_id },
      }
    }
  }
  if (!order.is_paid && order.row_type === 'order') {
    return { code: 'WEBSHOP_ORDER_NOT_PAID' }
  }

  // Double-booking lock against the legacy transactions feed: the same
  // money event may already sit in the inbox (imported before the Orders
  // switch-over). A booked feed row means this order IS booked via the
  // feed; an open one must be booked or IGNORED there first, and an
  // ignored row (is_ignored) unlocks order-side booking, exactly as the
  // error message instructs.
  if (order.legacy_transaction_id) {
    const { data: legacyTxn } = await supabase
      .from('transactions')
      .select('id, journal_entry_id, is_ignored')
      .eq('id', order.legacy_transaction_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (legacyTxn) {
      if (legacyTxn.journal_entry_id) {
        return {
          code: 'WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED',
          details: {
            transaction_id: legacyTxn.id,
            journal_entry_id: legacyTxn.journal_entry_id,
          },
        }
      }
      if (!legacyTxn.is_ignored) {
        return {
          code: 'WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN',
          details: { transaction_id: legacyTxn.id },
        }
      }
    }
  }

  return null
}

/**
 * Non-SEK rows book in SEK; retry the rate once at booking time before
 * refusing (a sync-time Riksbanken hiccup should not strand the order).
 * Returns the order with total_sek/exchange_rate resolved, or null when the
 * rate still cannot be fetched (the route answers WEBSHOP_ORDER_FX_UNRESOLVED).
 */
export async function resolveOrderFx(
  supabase: SupabaseClient,
  companyId: string,
  order: WebshopOrder,
  log: Logger,
): Promise<WebshopOrder | null> {
  if (order.currency.toUpperCase() === 'SEK' || order.total_sek !== null) {
    return order
  }
  try {
    const rate = await fetchExchangeRate(
      order.currency.toUpperCase() as Currency,
      new Date(`${order.paid_date ?? order.order_date}T00:00:00Z`),
      supabase,
    )
    if (rate?.rate) {
      const totalSek = roundOre(order.total * rate.rate)
      const { error: fxError } = await supabase
        .from('webshop_orders')
        .update({ total_sek: totalSek, exchange_rate: rate.rate })
        .eq('id', order.id)
        .eq('company_id', companyId)
      if (!fxError) {
        return { ...order, total_sek: totalSek, exchange_rate: rate.rate }
      }
    }
  } catch (err) {
    log.warn('booking-time FX retry failed', err as Error)
  }
  return null
}

export interface BookOrderEngineInput {
  fiscal_period_id: string
  entry_date: string
  description: string
  lines: CreateJournalEntryLineInput[]
  voucher_series?: string
  notes?: string
}

export type BookOrderEngineOutcome =
  /** Committed; journalEntry is commitEntry's post-commit fetch (may be null). */
  | { ok: true; journalEntry: JournalEntry | null; journalEntryId: string }
  /** Another request booked/invoiced the row between our read and the claim. */
  | { ok: false; kind: 'claimed_elsewhere' }
  /** The conditional claim update itself errored (DB failure). */
  | { ok: false; kind: 'claim_error'; error: unknown }
  /** createDraftEntry/commitEntry threw; usually a typed bookkeeping error. */
  | { ok: false; kind: 'engine_error'; stage: 'draft' | 'commit'; error: unknown }

/**
 * Race-free booking: draft -> atomic claim -> commit. The read-then-book
 * pattern let two concurrent requests each post an immutable verifikat
 * for the same order (skeptic finding). Instead the order row is claimed
 * with a conditional update BEFORE anything gets a voucher number: the
 * loser's claim matches zero rows and its draft (no voucher yet, so no
 * series gap) is cancelled.
 */
export async function bookOrderThroughEngine(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  orderId: string,
  input: BookOrderEngineInput,
  log: Logger,
): Promise<BookOrderEngineOutcome> {
  // The prefill can legitimately reach 3004, 3740 and the 1686 clearing
  // account, none of which seed_chart_of_accounts() seeds. Without this the
  // first Bokför on a fresh company died on AccountsNotInChartError for an
  // account the user never chose. Only our own closed prefill set is added,
  // and failures here are swallowed so the engine's typed error still wins.
  await ensureWebshopPrefillAccounts(
    supabase,
    companyId,
    userId,
    input.lines.map((l) => l.account_number),
    log,
  )

  let draft: JournalEntry
  try {
    draft = await createDraftEntry(supabase, companyId, userId, {
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.entry_date,
      description: input.description,
      source_type: 'webshop_order',
      source_id: orderId,
      voucher_series: input.voucher_series,
      notes: input.notes,
      lines: input.lines,
    })
  } catch (err) {
    return { ok: false, kind: 'engine_error', stage: 'draft', error: err }
  }

  const cancelDraft = async () => {
    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('status', 'draft')
    if (cancelError) {
      log.error('draft cleanup failed after claim/commit failure', cancelError, {
        entryId: draft.id,
      })
    }
  }

  // The claim guards BOTH links: a concurrent create-invoice between our
  // read and this update must lose too (mutual exclusivity, not just
  // no-double-booking).
  const { data: claimed, error: claimError } = await supabase
    .from('webshop_orders')
    .update({ journal_entry_id: draft.id })
    .eq('id', orderId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .select('id')
  if (claimError || !claimed || claimed.length === 0) {
    await cancelDraft()
    if (claimError) {
      log.error('webshop order claim failed', claimError, { orderId })
      return { ok: false, kind: 'claim_error', error: claimError }
    }
    // Zero rows matched: someone else booked it between our read and claim.
    return { ok: false, kind: 'claimed_elsewhere' }
  }

  let journalEntry: JournalEntry | null
  try {
    journalEntry = await commitEntry(supabase, companyId, userId, draft.id)
  } catch (err) {
    // Unlink so the row does not point at a cancelled draft, then cancel.
    // Order matters: the financial-freeze trigger keys on journal_entry_id
    // being set, but journal_entry_id itself is not in its protected list,
    // so the unlink passes.
    await supabase
      .from('webshop_orders')
      .update({ journal_entry_id: null })
      .eq('id', orderId)
      .eq('company_id', companyId)
      .eq('journal_entry_id', draft.id)
    await cancelDraft()
    return { ok: false, kind: 'engine_error', stage: 'commit', error: err }
  }

  // No extra event here: commitEntry() already emits
  // journal_entry.committed from inside the engine.

  return {
    ok: true,
    journalEntry,
    // commitEntry's post-commit fetch can theoretically return no row;
    // the entry still exists under draft.id.
    journalEntryId: journalEntry?.id ?? draft.id,
  }
}
