import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { resolveSekAmountOrNull, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { ensureWebshopPrefillAccounts } from '@/lib/webshop-orders/ensure-accounts'
import { checkOrderBankRow, linkOrderBankRow, type OrderBankRowLink } from '@/lib/webshop-orders/order-bank-row'
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
 *      the posting port (lib/posting) to lib/bookkeeping/engine
 *      (source_type 'webshop_order').
 *
 * Anything added to the single-order path (e.g. underlag anchoring) belongs
 * in these functions, never inline in one route, so single and bulk booking
 * can not drift apart. bookWebshopOrder() chains the three for one order by
 * id: the dashboard's single-order route and the webshop-orders.book
 * operation (v1 and MCP, lib/webshop-orders/service.ts) both call it.
 */

/** Guard failure: a structured-error code plus optional envelope details. */
export interface OrderBookableFailure {
  code:
    | 'WEBSHOP_ORDER_ALREADY_BOOKED'
    | 'WEBSHOP_ORDER_ALREADY_INVOICED'
    | 'WEBSHOP_ORDER_MANUALLY_BOOKED'
    | 'WEBSHOP_ORDER_VOIDED'
    | 'WEBSHOP_ORDER_REFUND_PARENT_INVOICED'
    | 'WEBSHOP_ORDER_REFUND_PARENT_VOIDED'
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
  // Marked as booked outside the integration: booking it here would post
  // the same business event twice. Voided (the store cancelled the order):
  // the user said nothing is booked. Both marks are user-reversible.
  if (order.manually_booked_at) {
    return {
      code: order.manually_voided ? 'WEBSHOP_ORDER_VOIDED' : 'WEBSHOP_ORDER_MANUALLY_BOOKED',
      details: { manually_booked_at: order.manually_booked_at },
    }
  }
  // Refunds of an invoiced order belong in the credit-note flow. A refund of
  // a voided order would book a return of a sale that was never booked: the
  // store refunded money after the void, so the void is undone and the order
  // and its refund book together.
  if (order.row_type === 'refund' && order.parent_order_id) {
    const { data: parent } = await supabase
      .from('webshop_orders')
      .select('invoice_id, manually_voided')
      .eq('id', order.parent_order_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (parent?.invoice_id) {
      return {
        code: 'WEBSHOP_ORDER_REFUND_PARENT_INVOICED',
        details: { invoice_id: parent.invoice_id },
      }
    }
    if (parent?.manually_voided) {
      return { code: 'WEBSHOP_ORDER_REFUND_PARENT_VOIDED', details: { parent_order_id: order.parent_order_id } }
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
 * `persist: false` (a dry run) resolves the rate without storing it.
 */
export async function resolveOrderFx(
  supabase: SupabaseClient,
  companyId: string,
  order: WebshopOrder,
  log: Logger,
  options: { persist?: boolean } = {},
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
      const totalSek = sekOfForeign(order.total, rate.rate)
      if (options.persist === false) {
        return { ...order, total_sek: totalSek, exchange_rate: rate.rate }
      }
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
  | {
      ok: true
      journalEntry: JournalEntry | null
      journalEntryId: string
      /** Orderunderlag PDF archived on the verifikat (#1881); never fatal. */
      underlagArchived: boolean
    }
  /** Another request booked/invoiced the row between our read and the claim. */
  | { ok: false; kind: 'claimed_elsewhere' }
  /** The conditional claim update itself errored (DB failure). */
  | { ok: false; kind: 'claim_error'; error: unknown }
  /** createDraftEntry/commitEntry threw; usually a typed bookkeeping error. */
  | { ok: false; kind: 'engine_error'; stage: 'draft' | 'commit'; error: unknown }

/**
 * The business event of a booked webbshop order or refund (kind
 * sale.webshop_order, a refund told apart by its direction), for the posting
 * port: recorded while POSTING_EVENTS is shadow or strict, never built while
 * it is off. Pure. The order row is named by the verifikat's source_id; the
 * customer has no party record (the order carries names, never copied here).
 */
export function webshopOrderBusinessEvent(order: WebshopOrder, linkBasis: LinkBasisColumns): BusinessEventDraft {
  const currency = order.currency.toUpperCase()
  const vatSek = resolveSekAmountOrNull(Math.abs(order.total_tax), null, currency, order.exchange_rate)
  return {
    kind: 'sale.webshop_order',
    category: 'income.sales',
    occurredOn: (order.paid_date ?? order.order_date).slice(0, 10),
    currency,
    amount: Math.abs(order.total),
    amountSek: order.total_sek === null ? null : Math.abs(order.total_sek),
    taxAmounts: vatSek !== null && vatSek > 0 ? [{ tax: 'vat', treatment: null, amount_sek: vatSek }] : [],
    evidence: {
      direction: order.row_type === 'refund' ? 'out' : 'in',
      link_basis: linkBasis.link_basis,
      link_evidence: linkBasis.link_evidence ?? undefined,
    },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('webshopOrder'),
    jurisdiction: 'SE',
  }
}

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
  /**
   * The order row, with FX already resolved (resolveOrderFx): the underlag
   * archived after commit renders the SEK conversion facts from it.
   */
  order: WebshopOrder,
  input: BookOrderEngineInput,
  log: Logger,
): Promise<BookOrderEngineOutcome> {
  const orderId = order.id
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
    // Posting port (step 2): the engine gets the input unchanged; while
    // POSTING_EVENTS is shadow or strict the sale.webshop_order event is
    // recorded first and linked to the draft, before the claim below and
    // before a voucher number is drawn.
    draft = await postingPort.draftJournalEntry({
      supabase,
      companyId,
      userId,
      // Built only while the port is on: off, the call is the one it was.
      event: () => webshopOrderBusinessEvent(order, linkBasisColumns('user_created')),
      input: {
        fiscal_period_id: input.fiscal_period_id,
        entry_date: input.entry_date,
        description: input.description,
        source_type: 'webshop_order',
        source_id: orderId,
        voucher_series: input.voucher_series,
        notes: input.notes,
        lines: input.lines,
      },
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

  // The claim guards BOTH links plus the manual mark: a concurrent
  // create-invoice or mark-booked between our read and this update must
  // lose too (mutual exclusivity, not just no-double-booking).
  const { data: claimed, error: claimError } = await supabase
    .from('webshop_orders')
    .update({ journal_entry_id: draft.id })
    .eq('id', orderId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .is('manually_booked_at', null)
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
    journalEntry = await postingPort.commitJournalEntry({ supabase, companyId, userId, entryId: draft.id })
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

  // Archive the orderunderlag (lines, customer, payment method) on the
  // committed verifikat (#1881). Never fatal: the booking is immutable at
  // this point, and a verifikat left without underlag surfaces on the
  // "saknar underlag" worklist (webshop_order is a needs-doc source type),
  // where the user can attach a document by hand. Living here, not in a
  // route, so the single-order and bulk paths can never diverge on it.
  // Imported here so react-pdf loads only when an order is booked.
  const { archiveWebshopOrderUnderlag } = await import('@/lib/webshop-orders/order-underlag')
  const underlag = await archiveWebshopOrderUnderlag({
    supabase,
    companyId,
    userId,
    order,
    journalEntryId: journalEntry?.id ?? draft.id,
    log,
  })

  return {
    ok: true,
    journalEntry,
    // commitEntry's post-commit fetch can theoretically return no row;
    // the entry still exists under draft.id.
    journalEntryId: journalEntry?.id ?? draft.id,
    underlagArchived: underlag.ok,
  }
}

/** One order row of the company, or null when it does not exist there. */
export async function loadWebshopOrder(
  supabase: SupabaseClient,
  companyId: string,
  orderId: string,
): Promise<WebshopOrder | null> {
  const { data, error } = await supabase
    .from('webshop_orders')
    .select('*')
    .eq('id', orderId)
    .eq('company_id', companyId)
    .single<WebshopOrder>()
  if (error || !data) return null
  return data
}

export type BookWebshopOrderOutcome =
  | (Extract<BookOrderEngineOutcome, { ok: true }> & {
      order: WebshopOrder
      /** Set when the caller named a bank row: whether it was linked to the posted verifikat. */
      transactionLink?: OrderBankRowLink
    })
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'not_bookable'; failure: OrderBookableFailure }
  | { ok: false; kind: 'fx_unresolved'; currency: string }
  /** The named bank row cannot be this order's payment (checkOrderBankRow); nothing was posted. */
  | { ok: false; kind: 'bank_row_refused'; code: string; details: Record<string, unknown> }
  | Exclude<BookOrderEngineOutcome, { ok: true }>

/**
 * Book one order row by id with the caller's lines: load, re-guard, resolve
 * FX, then draft -> claim -> commit with the orderunderlag archived. The one
 * write path for a single order, whoever asks (the dashboard dialog or an
 * agent through the operation registry); each door only translates the
 * outcome into its own envelope.
 *
 * `transactionId` names the bank row that paid the order (crm#1993): it is
 * checked before anything is posted (checkOrderBankRow) and linked to the
 * posted verifikat after it (linkOrderBankRow). A link that fails then
 * leaves the booking standing and is answered in transactionLink.
 */
export async function bookWebshopOrder(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  orderId: string,
  input: BookOrderEngineInput,
  log: Logger,
  options: { transactionId?: string } = {},
): Promise<BookWebshopOrderOutcome> {
  const order = await loadWebshopOrder(supabase, companyId, orderId)
  if (!order) return { ok: false, kind: 'not_found' }

  const guardFailure = await assertOrderBookable(supabase, companyId, order)
  if (guardFailure) return { ok: false, kind: 'not_bookable', failure: guardFailure }

  // Also keeps the in-memory row in sync (total_sek/exchange_rate): the
  // underlag renders the SEK conversion facts from it after commit.
  const resolvedOrder = await resolveOrderFx(supabase, companyId, order, log)
  if (!resolvedOrder) return { ok: false, kind: 'fx_unresolved', currency: order.currency }

  const { transactionId } = options
  if (transactionId) {
    const bankRow = await checkOrderBankRow(supabase, companyId, resolvedOrder, input.lines, transactionId, log)
    if (!bankRow.ok) return { ok: false, kind: 'bank_row_refused', code: bankRow.code, details: bankRow.details }
  }

  const outcome = await bookOrderThroughEngine(supabase, companyId, userId, resolvedOrder, input, log)
  if (!outcome.ok) return outcome
  if (!transactionId) return { ...outcome, order: resolvedOrder }
  const transactionLink = await linkOrderBankRow(supabase, companyId, userId, transactionId, outcome.journalEntryId, log)
  return { ...outcome, order: resolvedOrder, transactionLink }
}
