import { NextResponse } from 'next/server'
import { withRouteContext, type RouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MarkWebshopOrderBookedSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  WEBSHOP_ORDER_CANCELLED_STATUS,
  isCancelledInStore,
  isCancelledWithoutRefund,
} from '@/lib/webshop-orders/booking-status'

/**
 * POST /api/webshop-orders/[id]/mark-booked
 *
 * Mark one order/refund row as already booked/handled OUTSIDE the
 * integration (typically booked by hand before the store was connected), so
 * it leaves the "Att bokfora" list without creating a verifikat. An optional
 * journal_entry_id records which existing posted verifikat covers the order;
 * the link is informational (the entry was not produced by this row), so the
 * financial freeze deliberately does not apply.
 *
 * With voided: true the mark voids the row instead (Markera som makulerad):
 * only an order the store reports cancelled, with nothing refunded through
 * the store (isCancelledWithoutRefund), and nothing is booked. The same
 * DELETE undoes it, and the row is never deleted.
 *
 * Mutually exclusive with the real exits: refuses rows that are booked or
 * invoiced through the integration, and the book/create-invoice routes
 * refuse marked rows in return. The claim is a conditional update so a
 * concurrent booking cannot interleave.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.mark_booked',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, MarkWebshopOrderBookedSchema)
    if (!validation.success) return validation.response
    const { journal_entry_id } = validation.data
    const voided = validation.data.voided === true

    const { data: order, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('id, row_type, status, refunded_total, journal_entry_id, invoice_id, manually_booked_at, manually_voided, legacy_transaction_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

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

    if (voided) {
      return voidOrder(order, { supabase, user, companyId, log, requestId })
    }
    // A voided row is not booked outside: marking it booked, or linking a
    // verifikat to it, waits until the void is undone.
    if (order.manually_voided) {
      return errorResponseFromCode('WEBSHOP_ORDER_VOIDED', log, { requestId })
    }

    // Same open-twin gate as the book/create-invoice routes (skeptic
    // finding): when the money event also sits as an OPEN row in the legacy
    // transactions inbox, marking the order would hide the twin while it is
    // still bookable there, so the sale could reach the ledger twice. The
    // user must book or ignore the feed row first; an ignored or booked feed
    // row unlocks the mark (no open path to a duplicate remains).
    if (order.legacy_transaction_id) {
      const { data: legacyTxn } = await supabase
        .from('open_bank_rows')
        .select('id')
        .eq('id', order.legacy_transaction_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (legacyTxn) {
        return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN', log, {
          requestId,
          details: { transaction_id: legacyTxn.id },
        })
      }
    }

    // The optional verifikat reference must be a real, posted entry in this
    // company: linking a draft/cancelled entry would assert underlag that
    // does not exist in the ledger.
    if (journal_entry_id) {
      const { data: entry } = await supabase
        .from('journal_entries')
        .select('id, status')
        .eq('id', journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!entry) {
        return errorResponseFromCode('WEBSHOP_ORDER_MARK_ENTRY_NOT_FOUND', log, {
          requestId,
          details: { journal_entry_id },
        })
      }
      if (entry.status !== 'posted') {
        return errorResponseFromCode('WEBSHOP_ORDER_MARK_ENTRY_NOT_POSTED', log, {
          requestId,
          details: { journal_entry_id, status: entry.status },
        })
      }
    }

    if (order.manually_booked_at) {
      // Idempotent for a bare re-mark (mirrors the transactions ignore
      // route). A re-mark WITH a verifikat reference updates the link
      // instead of silently dropping it (skeptic finding): the row is only
      // marked, not booked, so refining the informational link is safe.
      if (!journal_entry_id) {
        return NextResponse.json({ success: true, already_marked: true })
      }
      const { error: linkError } = await supabase
        .from('webshop_orders')
        .update({ manually_booked_journal_entry_id: journal_entry_id })
        .eq('id', id)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .is('invoice_id', null)
      if (linkError) {
        log.error('failed to update manual booking link', linkError, { orderId: id })
        return errorResponse(linkError, log, { requestId })
      }
      return NextResponse.json({ success: true, already_marked: true, link_updated: true })
    }

    // Conditional claim: a concurrent book/create-invoice between our read
    // and this update must win cleanly (zero rows matched here).
    const { data: marked, error: markError } = await supabase
      .from('webshop_orders')
      .update({
        manually_booked_at: new Date().toISOString(),
        manually_booked_by: user.id,
        manually_booked_journal_entry_id: journal_entry_id ?? null,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .is('invoice_id', null)
      .is('manually_booked_at', null)
      .select('id')

    if (markError) {
      log.error('failed to mark webshop order as manually booked', markError, {
        orderId: id,
      })
      return errorResponse(markError, log, { requestId })
    }
    if (!marked || marked.length === 0) {
      // Raced: the row was booked, invoiced or marked concurrently.
      return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/webshop-orders/[id]/mark-booked
 *
 * Undo a manual mark, a void included. Reversible by design (soft-guard
 * doctrine): the mark created no accounting objects, so clearing it has no
 * ledger side effects and the row simply returns to the to-book list.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.unmark_booked',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const { data: cleared, error: updateError } = await supabase
      .from('webshop_orders')
      .update({
        manually_booked_at: null,
        manually_booked_by: null,
        manually_booked_journal_entry_id: null,
        manually_voided: false,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')

    if (updateError) {
      log.error('failed to unmark webshop order', updateError, { orderId: id })
      return errorResponse(updateError, log, { requestId })
    }
    if (!cleared || cleared.length === 0) {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

type MarkContext = Pick<RouteContext, 'supabase' | 'user' | 'companyId' | 'log' | 'requestId'>

interface VoidCandidate {
  id: string
  row_type: 'order' | 'refund'
  status: string
  refunded_total: number
  manually_booked_at: string | null
  manually_voided: boolean | null
  legacy_transaction_id: string | null
}

/**
 * Void an order the store cancelled (Markera som makulerad). The status
 * comes from the store: a row it does not report cancelled is refused, and so
 * is a cancelled order the store refunded money on, whose payment and refund
 * are booked instead (isCancelledWithoutRefund). No verifikat is linked and
 * nothing is booked; the same conditional claim as the booked mark keeps a
 * concurrent booking out.
 */
async function voidOrder(
  order: VoidCandidate,
  { supabase, user, companyId, log, requestId }: MarkContext,
): Promise<NextResponse> {
  if (order.manually_booked_at) {
    if (order.manually_voided) return NextResponse.json({ success: true, already_marked: true })
    return errorResponseFromCode('WEBSHOP_ORDER_MANUALLY_BOOKED', log, {
      requestId,
      details: { manually_booked_at: order.manually_booked_at },
    })
  }
  if (!isCancelledInStore(order)) {
    return errorResponseFromCode('WEBSHOP_ORDER_NOT_CANCELLED', log, {
      requestId,
      details: { status: order.status },
    })
  }
  if (!isCancelledWithoutRefund(order)) {
    return errorResponseFromCode('WEBSHOP_ORDER_CANCELLED_WITH_REFUND', log, {
      requestId,
      details: { refunded_total: order.refunded_total },
    })
  }
  // The booked mark's open-twin gate holds for a void too: while the same
  // money sits as an open row in the legacy transactions inbox, the void
  // would hide the order's pointer to it, and the row could still be booked
  // there as a sale. Book or ignore that row first.
  if (order.legacy_transaction_id) {
    const { data: legacyTxn } = await supabase
      .from('open_bank_rows')
      .select('id')
      .eq('id', order.legacy_transaction_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (legacyTxn) {
      return errorResponseFromCode('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN', log, {
        requestId,
        details: { transaction_id: legacyTxn.id },
      })
    }
  }

  // The store's state is checked again at the write: a sync that reopens or
  // refunds the order between the read and this claim leaves it unvoided.
  const { data: marked, error: markError } = await supabase
    .from('webshop_orders')
    .update({
      manually_booked_at: new Date().toISOString(),
      manually_booked_by: user.id,
      manually_booked_journal_entry_id: null,
      manually_voided: true,
    })
    .eq('id', order.id)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .is('invoice_id', null)
    .is('manually_booked_at', null)
    .eq('row_type', 'order')
    .eq('status', WEBSHOP_ORDER_CANCELLED_STATUS)
    .eq('refunded_total', 0)
    .select('id')

  if (markError) {
    log.error('failed to void webshop order', markError, { orderId: order.id })
    return errorResponse(markError, log, { requestId })
  }
  if (!marked || marked.length === 0) {
    // Raced: booked, invoiced or marked concurrently, or the store reopened
    // or refunded the order since the read.
    return errorResponseFromCode('WEBSHOP_ORDER_VOID_RACED', log, { requestId })
  }
  return NextResponse.json({ success: true })
}
