import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MarkWebshopOrderBookedSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

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

    const { data: order, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('id, journal_entry_id, invoice_id, manually_booked_at, legacy_transaction_id')
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

    // Same open-twin gate as the book/create-invoice routes (skeptic
    // finding): when the money event also sits as an OPEN row in the legacy
    // transactions inbox, marking the order would hide the twin while it is
    // still bookable there, so the sale could reach the ledger twice. The
    // user must book or ignore the feed row first; an ignored or booked feed
    // row unlocks the mark (no open path to a duplicate remains).
    if (order.legacy_transaction_id) {
      const { data: legacyTxn } = await supabase
        .from('transactions')
        .select('id, journal_entry_id, is_ignored')
        .eq('id', order.legacy_transaction_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (legacyTxn && !legacyTxn.journal_entry_id && !legacyTxn.is_ignored) {
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
 * Undo a manual mark. Reversible by design (soft-guard doctrine): the mark
 * created no accounting objects, so clearing it has no ledger side effects
 * and the row simply returns to the to-book list.
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
