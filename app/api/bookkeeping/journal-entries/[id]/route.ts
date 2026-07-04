import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createLogger } from '@/lib/logger'
import { syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { updateDraftEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'

const logger = createLogger('journal-entries')

ensureInitialized()

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Read source_type/source_id BEFORE deleting so we can revert the linked
  // invoice/supplier_invoice status afterwards. The GL row gets cancelled by
  // delete_last_voucher but the invoice's paid status lives outside the GL
  // and would otherwise stay stuck on "paid" after the user deletes the
  // payment voucher.
  const { data: entryBefore } = await supabase
    .from('journal_entries')
    .select('id, source_type, source_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  const { data, error } = await supabase.rpc('delete_last_voucher', {
    p_company_id: companyId,
    p_entry_id: id,
  })

  if (error) {
    logger.error('delete_last_voucher failed', { entryId: id, error })
    return NextResponse.json(
      { error: getErrorMessage(error, { context: 'journal_entry', statusCode: 400 }) },
      { status: 400 }
    )
  }

  if (entryBefore) {
    try {
      await syncInvoiceStatusFromPaymentEntry(supabase, companyId, entryBefore)
    } catch (syncError) {
      logger.warn('payment status sync failed after delete', { entryId: id, error: syncError })
    }
  }

  await eventBus.emit({
    type: 'journal_entry.deleted',
    payload: {
      entryId: id,
      voucherSeries: data.voucher_series,
      voucherNumber: data.voucher_number,
      userId: user.id,
      companyId,
    },
  })

  return NextResponse.json({ data })
}

/**
 * PATCH: edit a DRAFT verifikat in place (header + lines). Only drafts are
 * editable; updateDraftEntry rejects committed entries with a 409, and the DB
 * immutability trigger is the backstop. Uses withRouteContext (MFA + write gate):
 * the GET/DELETE above predate that wrapper and are intentionally left as-is.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.update',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CreateJournalEntrySchema)
    if (!validation.success) return validation.response

    try {
      const entry = await updateDraftEntry(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: entry })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to update journal entry' },
        { status: 400 },
      )
    }
  },
  { requireWrite: true },
)
