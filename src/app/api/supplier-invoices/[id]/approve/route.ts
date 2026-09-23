import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import {
  canApproveSupplierInvoice,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'
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

    // 'overdue' is approvable too: the daily cron puts unbooked invoices there
    // just by aging, and a registered-only gate left an aged invoice with no
    // way through attest at all (#1206). approved_at, not the status, is what
    // makes approval idempotent.
    if (!canApproveSupplierInvoice(invoice)) {
      return errorResponseFromCode('SI_APPROVE_NOT_REGISTERED', log, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // An invoice that is both attested and past due stays labelled 'overdue':
    // that is what the cron would do on its next run, and approving is not a
    // reason to hide that money is late.
    const approvedAt = new Date().toISOString()
    const { data, error } = await supabase
      .from('supplier_invoices')
      .update({
        status: resolveUnsettledStatus(
          { ...invoice, approved_at: approvedAt },
          getSwedishLocalDate(),
        ),
        approved_at: approvedAt,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      // Optimistic concurrency on the pre-approval state, same guard as the v1
      // route: the eligibility check above ran on a snapshot, so without this
      // two concurrent approvals would both write (different) approved_at
      // values and both emit supplier_invoice.approved.
      .in('status', ['registered', 'overdue'])
      .is('approved_at', null)
      .select()
      .maybeSingle()

    if (error) {
      log.error('supplier_invoice update to approved failed', error)
      return errorResponseFromCode('SI_APPROVE_UPDATE_FAILED', log, { requestId })
    }

    if (!data) {
      // Lost the race: another approval (or a status change) landed first.
      return errorResponseFromCode('SI_APPROVE_NOT_REGISTERED', log, {
        requestId,
        details: { reason: 'race' },
      })
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
