import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import {
  bookkeepingErrorResponse,
  CannotReverseNonPostedError,
  EntryAlreadyReversedError,
} from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { SupplierInvoice, SupplierInvoicePayment } from '@/types'

ensureInitialized()

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: original, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select('*, payments:supplier_invoice_payments(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Idempotent no-op: an already-uncredited or never-credited invoice just returns the row.
  // Friendlier than a 409: the client retry path can blindly call this without checking first.
  if (original.status !== 'credited') {
    return NextResponse.json({ data: original })
  }

  // Filter out already-reversed credits: re-crediting the same original after a prior
  // uncredit creates a second credit row, so we may find multiple historical matches.
  const { data: creditNote } = await supabase
    .from('supplier_invoices')
    .select('id, registration_journal_entry_id')
    .eq('company_id', companyId)
    .eq('credited_invoice_id', id)
    .eq('is_credit_note', true)
    .neq('status', 'reversed')
    .maybeSingle()

  let reversalEntryId: string | null = null

  if (creditNote?.registration_journal_entry_id) {
    try {
      const reversal = await reverseEntry(
        supabase,
        companyId,
        user.id,
        creditNote.registration_journal_entry_id
      )
      reversalEntryId = reversal.id
    } catch (err) {
      // Already reversed (manually or by another concurrent uncredit): fine, continue.
      if (err instanceof CannotReverseNonPostedError || err instanceof EntryAlreadyReversedError) {
        // proceed to row cleanup
      } else {
        const typed = bookkeepingErrorResponse(err)
        if (typed) return typed
        // Period lock and similar trigger errors: surface a clear Swedish message
        // so the user knows WHY the action failed (per project's error-UX guidelines).
        return NextResponse.json(
          { error: getErrorMessage(err, { context: 'supplier_invoice' }) },
          { status: 400 }
        )
      }
    }
  }

  if (creditNote) {
    // Soft-delete: mark the credit row 'reversed' and stamp reversed_at. BFL 7 kap
    // requires räkenskapsinformation to be preserved for 7 years; BFL 5 kap 7§ wants
    // an unbroken ankomstnummer series; sambandskravet requires the posted JE to
    // remain traceable back to its business-layer row. A hard-delete would break all
    // three. The row and its items are kept; the partial unique index excludes
    // status='reversed' so re-crediting is still possible.
    const { error: reverseMarkError } = await supabase
      .from('supplier_invoices')
      .update({ status: 'reversed', reversed_at: new Date().toISOString() })
      .eq('id', creditNote.id)
      .eq('company_id', companyId)

    if (reverseMarkError) {
      return NextResponse.json(
        { error: getErrorMessage(reverseMarkError, { context: 'supplier_invoice' }) },
        { status: 500 }
      )
    }
  }

  // Recompute original status from payments. The credit had reduced remaining_amount
  // to 0 and bumped status to 'credited': undo both based on what's actually paid.
  const payments = (original.payments as SupplierInvoicePayment[]) || []
  const paidSum = payments.reduce((sum, p) => sum + (p.amount || 0), 0)
  const total = original.total || 0
  const remaining = Math.round((total - paidSum) * 100) / 100

  let newStatus: SupplierInvoice['status']
  if (paidSum >= total && total > 0) {
    newStatus = 'paid'
  } else if (paidSum > 0) {
    newStatus = 'partially_paid'
  } else if (original.due_date && new Date(original.due_date) < new Date()) {
    newStatus = 'overdue'
  } else if (original.registration_journal_entry_id) {
    // Posted verifikation exists -> safe to restore to 'approved'.
    newStatus = 'approved'
  } else {
    // No registration JE on the original (cash method, or an inconsistent row
    // that somehow reached 'credited' without a booking). Restoring to
    // 'approved' would yield an approved invoice with no verifikation, which
    // violates sambandskravet (BFL 4 kap 2§). Fall back to 'registered'.
    newStatus = 'registered'
  }

  const { data: restored, error: updateError } = await supabase
    .from('supplier_invoices')
    .update({
      status: newStatus,
      remaining_amount: remaining,
    })
    .eq('id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (updateError || !restored) {
    return NextResponse.json(
      { error: getErrorMessage(updateError, { context: 'supplier_invoice' }) },
      { status: 500 }
    )
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.uncredited',
      payload: {
        supplierInvoice: restored as SupplierInvoice,
        reversedCreditNoteId: creditNote?.id ?? '',
        reversalEntryId,
        userId: user.id,
        companyId,
      },
    })
  } catch {
    // Non-blocking
  }

  return NextResponse.json({
    data: restored,
    reversal_entry_id: reversalEntryId,
  })
}
