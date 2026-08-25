import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookWebshopOrderSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { ensureWebshopPrefillAccounts } from '@/lib/webshop-orders/ensure-accounts'
import { archiveWebshopOrderUnderlag } from '@/lib/webshop-orders/order-underlag'
import { roundOre } from '@/lib/money'
import type { Currency, WebshopOrder } from '@/types'

ensureInitialized()

/**
 * Book one webshop order/refund row as a verifikat. The dialog sends the
 * (user-reviewed) lines built by lib/webshop-orders/booking-lines; the server
 * re-guards state and routes everything through the engine
 * (source_type 'webshop_order'). Period/company locks and balance are
 * enforced by the engine + DB triggers as usual.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.book',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, BookWebshopOrderSchema)
    if (!validation.success) return validation.response
    const { fiscal_period_id, entry_date, description, lines, voucher_series, notes } =
      validation.data

    const { data: order, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single<WebshopOrder>()

    if (fetchError || !order) {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
    }

    if (order.journal_entry_id) {
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, {
        requestId,
        details: { journal_entry_id: order.journal_entry_id },
      })
    }
    if (order.invoice_id) {
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_INVOICED', log, {
        requestId,
        details: { invoice_id: order.invoice_id },
      })
    }
    // Marked as booked outside the integration: booking it here would post
    // the same business event twice. The mark is user-reversible.
    if (order.manually_booked_at) {
      return errorResponseFromCode('WEBSHOP_ORDER_MANUALLY_BOOKED', log, {
        requestId,
        details: { manually_booked_at: order.manually_booked_at },
      })
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
        return errorResponseFromCode('WEBSHOP_ORDER_REFUND_PARENT_INVOICED', log, {
          requestId,
          details: { invoice_id: parent.invoice_id },
        })
      }
    }
    if (!order.is_paid && order.row_type === 'order') {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_PAID', log, { requestId })
    }

    // Double-booking lock against the legacy transactions feed: the same
    // money event may already sit in the inbox (imported before the Orders
    // switch-over). A booked feed row means this order IS booked via the
    // feed; an open one must be booked or IGNORED there first — and an
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
          return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED', log, {
            requestId,
            details: {
              transaction_id: legacyTxn.id,
              journal_entry_id: legacyTxn.journal_entry_id,
            },
          })
        }
        if (!legacyTxn.is_ignored) {
          return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN', log, {
            requestId,
            details: { transaction_id: legacyTxn.id },
          })
        }
      }
    }

    // Non-SEK rows book in SEK; retry the rate once at booking time before
    // refusing (a sync-time Riksbanken hiccup should not strand the order).
    if (order.currency.toUpperCase() !== 'SEK' && order.total_sek === null) {
      let resolved = false
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
            .eq('id', id)
            .eq('company_id', companyId)
          resolved = !fxError
          if (resolved) {
            // Keep the in-memory row in sync: the underlag renders the SEK
            // conversion facts from it after commit.
            order.total_sek = totalSek
            order.exchange_rate = rate.rate
          }
        }
      } catch (err) {
        log.warn('booking-time FX retry failed', err as Error)
      }
      if (!resolved) {
        return errorResponseFromCode('WEBSHOP_ORDER_FX_UNRESOLVED', log, {
          requestId,
          details: { currency: order.currency },
        })
      }
    }

    // Race-free booking: draft -> atomic claim -> commit. The read-then-book
    // pattern let two concurrent requests each post an immutable verifikat
    // for the same order (skeptic finding). Instead the order row is claimed
    // with a conditional update BEFORE anything gets a voucher number: the
    // loser's claim matches zero rows and its draft (no voucher yet, so no
    // series gap) is cancelled.
    // The prefill can legitimately reach 3004, 3740 and the 1686 clearing
    // account, none of which seed_chart_of_accounts() seeds. Without this the
    // first Bokför on a fresh company died on AccountsNotInChartError for an
    // account the user never chose. Only our own closed prefill set is added,
    // and failures here are swallowed so the engine's typed error still wins.
    await ensureWebshopPrefillAccounts(
      supabase,
      companyId,
      user.id,
      lines.map((l) => l.account_number),
      log,
    )

    let draft
    try {
      draft = await createDraftEntry(supabase, companyId, user.id, {
        fiscal_period_id,
        entry_date,
        description,
        source_type: 'webshop_order',
        source_id: id,
        voucher_series,
        notes,
        lines,
      })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      log.error('failed to draft journal entry for webshop order', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'transaction' }) },
        { status: 400 },
      )
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
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('manually_booked_at', null)
      .select('id')
    if (claimError || !claimed || claimed.length === 0) {
      await cancelDraft()
      if (claimError) {
        log.error('webshop order claim failed', claimError, { orderId: id })
        return NextResponse.json(
          { error: getErrorMessage(claimError, { context: 'transaction' }) },
          { status: 500 },
        )
      }
      // Zero rows matched: someone else booked it between our read and claim.
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, { requestId })
    }

    let journalEntry
    try {
      journalEntry = await commitEntry(supabase, companyId, user.id, draft.id)
    } catch (err) {
      // Unlink so the row does not point at a cancelled draft, then cancel.
      // Order matters: the financial-freeze trigger keys on journal_entry_id
      // being set, but journal_entry_id itself is not in its protected list,
      // so the unlink passes.
      await supabase
        .from('webshop_orders')
        .update({ journal_entry_id: null })
        .eq('id', id)
        .eq('company_id', companyId)
        .eq('journal_entry_id', draft.id)
      await cancelDraft()
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      log.error('failed to commit journal entry for webshop order', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'transaction' }) },
        { status: 400 },
      )
    }

    // No extra event here: commitEntry() already emits
    // journal_entry.committed from inside the engine.

    // Archive the orderunderlag (lines, customer, payment method) on the
    // committed verifikat (#1881). Never fatal: the booking is immutable at
    // this point, and a verifikat left without underlag surfaces on the
    // "saknar underlag" worklist (webshop_order is a needs-doc source type),
    // where the user can attach a document by hand.
    const underlag = await archiveWebshopOrderUnderlag({
      supabase,
      companyId,
      userId: user.id,
      order,
      journalEntryId: journalEntry?.id ?? draft.id,
      log,
    })

    return NextResponse.json({
      data: journalEntry,
      // commitEntry's post-commit fetch can theoretically return no row;
      // the entry still exists under draft.id.
      journal_entry_id: journalEntry?.id ?? draft.id,
      underlag_archived: underlag.ok,
      success: true,
    })
  },
  { requireWrite: true },
)
