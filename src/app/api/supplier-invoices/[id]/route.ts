import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { deleteSupplierInvoice } from '@/lib/supplier-invoices/manage'
import { updateSupplierInvoiceHeader } from '@/lib/supplier-invoices/update-header'
import { sessionFailureResponse } from '@/lib/operations/session'
import { unlinkablePaymentIds, type UnlinkablePaymentRow } from '@/lib/invoices/supplier-voucher-unlink'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.get',
  async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params

  const { data: invoice, error } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*), payments:supplier_invoice_payments(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Supplier invoice not found' }, { status: 404 })
  }

  // The invoice a credit note reverses, fetched separately. credited_invoice_id
  // is a self-reference, and PostgREST cannot pick a direction for a
  // self-referencing embed from the column hint: the old
  // `credited_original:supplier_invoices!credited_invoice_id(...)` resolved to
  // the one-to-many side and came back as an empty array, which the detail
  // page rendered as "Krediterar: Ankomst #" with no number.
  let creditedOriginal: { id: string; supplier_invoice_number: string | null; arrival_number: number } | null = null
  if (invoice.credited_invoice_id) {
    const { data: original } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, arrival_number')
      .eq('id', invoice.credited_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    creditedOriginal = original ?? null
  }

  // Which payment rows are a plain link to an existing verifikat, the kind
  // "Koppla bort" takes back (unlink-voucher). A hint for the page: the RPC
  // behind the action decides.
  const payments = (invoice.payments ?? []) as Array<UnlinkablePaymentRow & Record<string, unknown>>
  const unlinkable = new Set(await unlinkablePaymentIds(supabase, companyId, invoice, payments))

  return NextResponse.json({
    data: {
      ...invoice,
      payments: payments.map((p) => (unlinkable.has(p.id) ? { ...p, can_unlink_voucher: true } : p)),
      credited_original: creditedOriginal,
    },
  })
  },
)

/**
 * Edit the header of an unsettled supplier invoice (numbers, dates, reference,
 * notes; never amounts or accounts). The rules live in
 * lib/supplier-invoices/update-header.ts, shared with the v1 PATCH and the
 * MCP tool (operation supplier-invoices.update): the fields a posted
 * registration verifikat carries are refused there (#1230), and the overdue
 * label follows the new due date (#1206).
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.update',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, UpdateSupplierInvoiceSchema)
    if (!validation.success) return validation.response

    const outcome = await updateSupplierInvoiceHeader(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

/**
 * Delete an unbooked supplier invoice. Rules (never a credit note, only
 * unpaid states, no verifikat / payment / accrual / payment-batch row) live
 * in lib/supplier-invoices/manage.ts, shared with v1 supplier-invoices.delete.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.delete',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await deleteSupplierInvoice({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
