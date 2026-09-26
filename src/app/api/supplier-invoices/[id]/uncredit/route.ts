import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * "Ångra kreditering": cancel the credit note's verifikat with a storno,
 * keep the credit row as 'reversed' and restore the original from its
 * payments. Rules live in lib/supplier-invoices/manage.ts, shared with v1
 * supplier-invoices.uncredit and gnubok_uncredit_supplier_invoice.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.uncredit',
  async (_request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await uncreditSupplierInvoice({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    // Idempotent no-op on an invoice that is not credited: the bare row, as before.
    if (!outcome.data.changed) return NextResponse.json({ data: outcome.data.supplier_invoice })
    return NextResponse.json({
      data: outcome.data.supplier_invoice,
      reversal_entry_id: outcome.data.reversal_entry_id,
    })
  },
  { requireWrite: true },
)
