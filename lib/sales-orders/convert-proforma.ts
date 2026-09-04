import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem, SalesOrder } from '@/types'
import { createSalesOrder } from './write'
import { fail, failDb, type ServiceResult } from './result'

/**
 * Proforma -> kundorder. The proforma is the closest thing to an offert
 * the product has today, so this is the "Skapa order" action on it. Copies
 * header + lines into a new DRAFT order (source_invoice_id back-pointer)
 * and, like proforma -> invoice, marks the proforma cancelled: the order
 * now carries the agreement. Only one order per proforma.
 *
 * Order lines have no ROT/RUT or periodisering fields and no negative
 * quantities. A proforma carrying any of those is refused outright
 * (SALES_ORDER_SOURCE_UNSUPPORTED_LINES) instead of silently losing the
 * skattereduktion or the accrual on the invoice that the order later
 * produces.
 */
export async function convertProformaToSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; invoiceId: string },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, userId, invoiceId } = params
  const { data: proforma, error } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle<Invoice & { items: InvoiceItem[] }>()
  if (error) return failDb(error)
  if (!proforma) return fail('INVOICE_NOT_FOUND')
  if (proforma.document_type !== 'proforma') return fail('SALES_ORDER_SOURCE_NOT_PROFORMA')
  if (proforma.status === 'cancelled') return fail('SALES_ORDER_SOURCE_ALREADY_CONVERTED')

  const { count } = await supabase
    .from('sales_orders')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('source_invoice_id', invoiceId)
  if ((count ?? 0) > 0) return fail('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
  if (!proforma.customer_id) return fail('SALES_ORDER_CUSTOMER_MISSING')

  const sourceItems = [...(proforma.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  const unsupported = sourceItems.filter(
    (item) =>
      (item.line_type ?? 'product') === 'product' &&
      (Boolean(item.deduction_type) ||
        Boolean(item.accrual_period_start) ||
        Boolean(item.accrual_period_end) ||
        Boolean(item.accrual_balance_account) ||
        item.quantity < 0),
  )
  if (unsupported.length > 0) {
    return fail('SALES_ORDER_SOURCE_UNSUPPORTED_LINES', {
      lines: unsupported.map((item) => ({
        invoice_item_id: item.id,
        deduction_type: item.deduction_type ?? null,
        accrual: Boolean(item.accrual_period_start || item.accrual_period_end),
        quantity: item.quantity,
      })),
    })
  }

  const items = sourceItems.map((item) => ({
    line_type: (item.line_type ?? 'product') as 'product' | 'text',
    description: item.description,
    quantity: item.line_type === 'text' ? 0 : item.quantity,
    unit: item.unit ?? 'st',
    unit_price: item.unit_price,
    discount_percent: item.discount_percent ?? null,
    vat_rate: item.vat_rate,
    article_id: item.article_id ?? null,
    revenue_account: item.revenue_account ?? null,
    dimensions: item.dimensions ?? {},
  }))
  if (items.length === 0) return fail('SALES_ORDER_NOTHING_TO_INVOICE')

  const created = await createSalesOrder(supabase, {
    companyId,
    userId,
    sourceInvoiceId: invoiceId,
    input: {
      customer_id: proforma.customer_id,
      currency: proforma.currency,
      your_reference: proforma.your_reference ?? null,
      our_reference: proforma.our_reference ?? null,
      notes: proforma.notes ?? null,
      default_dimensions: proforma.default_dimensions ?? {},
      items,
    },
  })
  if (!created.ok) return created

  // Compare-and-set so a concurrent convert (to invoice or to order) cannot
  // both succeed; on a lost race the fresh draft order is removed again.
  const { data: marked, error: markError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled' })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .neq('status', 'cancelled')
    .select('id')
  if (markError || !marked || marked.length === 0) {
    await supabase.from('sales_orders').delete().eq('id', created.order.id).eq('company_id', companyId)
    if (markError) return failDb(markError)
    return fail('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
  }

  return created
}
