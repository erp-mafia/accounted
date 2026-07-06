import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SupplierInvoice } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'supplier_invoice.approve',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', log, { requestId })
    }

    if (invoice.status !== 'registered') {
      return errorResponseFromCode('SI_APPROVE_NOT_REGISTERED', log, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const { data, error } = await supabase
      .from('supplier_invoices')
      .update({ status: 'approved' })
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      log.error('supplier_invoice update to approved failed', error)
      return errorResponseFromCode('SI_APPROVE_UPDATE_FAILED', log, { requestId })
    }

    // Event emission is non-blocking: the registration entry is created by
    // the supplier-invoice handler bound to this event. If the handler throws,
    // bus.ts persists an EventHandlerFailed row for traceability.
    try {
      await eventBus.emit({
        type: 'supplier_invoice.approved',
        payload: { supplierInvoice: data as SupplierInvoice, companyId, userId: user.id },
      })
    } catch (err) {
      log.warn('supplier_invoice.approved event emission failed', err as Error)
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
