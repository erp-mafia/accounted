import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem, SalesOrder } from '@/types'
import { createSalesOrder } from './write'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

/**
 * Proforma or offert (quote) -> kundorder: the "Skapa order" action on both.
 * Copies header + lines into a new DRAFT order (source_invoice_id
 * back-pointer). Only one live order per source.
 *
 * Source handling differs by document type, mirroring convertToInvoice:
 *   - proforma: marked cancelled (it was a pre-document for the same sale);
 *     the order now carries the agreement.
 *   - quote: stays as the customer's accepted agreement and flips to
 *     quote_status = 'accepted' with a compare-and-set on the decision that
 *     was read. A declined quote must be re-opened first, and a quote with a
 *     live converted invoice (converted_from_id) is refused: the sale is
 *     already invoiced. The reverse guard lives in convertToInvoice
 *     (INVOICE_QUOTE_ALREADY_ORDERED).
 *
 * Order lines have no ROT/RUT or periodisering fields and no negative
 * quantities. A source carrying any of those is refused outright
 * (SALES_ORDER_SOURCE_UNSUPPORTED_LINES) instead of silently losing the
 * skattereduktion or the accrual on the invoice that the order later
 * produces.
 */
export async function convertToSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; invoiceId: string },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, userId, invoiceId } = params
  const { data: source, error } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle<Invoice & { items: InvoiceItem[] }>()
  if (error) return failDb(error)
  if (!source) return fail('INVOICE_NOT_FOUND')
  const isQuote = source.document_type === 'quote'
  if (source.document_type !== 'proforma' && !isQuote) return fail('SALES_ORDER_SOURCE_NOT_PROFORMA')
  if (source.status === 'cancelled') return fail('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
  if (isQuote && source.quote_status === 'declined') return fail('INVOICE_CONVERT_QUOTE_DECLINED')

  // One live order per source. A cancelled order frees the source again
  // (the proforma is cancelled with its order anyway, so this only matters
  // for quotes).
  const { count, error: countError } = await supabase
    .from('sales_orders')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('source_invoice_id', invoiceId)
    .neq('status', 'cancelled')
  if (countError) return failDb(countError)
  if ((count ?? 0) > 0) return fail('SALES_ORDER_SOURCE_ALREADY_CONVERTED')

  if (isQuote) {
    // Same guard as convertToInvoice in the other direction: the sale must
    // not exist both as a live invoice and as an order.
    const { data: invoiced, error: invoicedError } = await supabase
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('converted_from_id', invoiceId)
      .neq('status', 'cancelled')
      .limit(1)
      .maybeSingle()
    if (invoicedError) return failDb(invoicedError)
    if (invoiced) return fail('INVOICE_QUOTE_ALREADY_INVOICED')
  }

  if (!source.customer_id) return fail('SALES_ORDER_CUSTOMER_MISSING')

  const sourceItems = [...(source.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
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
      customer_id: source.customer_id,
      currency: source.currency,
      your_reference: source.your_reference ?? null,
      our_reference: source.our_reference ?? null,
      notes: source.notes ?? null,
      default_dimensions: source.default_dimensions ?? {},
      items,
    },
  })
  if (!created.ok) {
    // The database holds the atomic guards (migration 20260908152555): a
    // second live order for the source, or a live converted invoice on the
    // quote, refuses the insert with a code even when the pre-checks above
    // raced with another conversion.
    if ('dbError' in created) {
      const code = codeFromPgError(created.dbError)
      if (code) return fail(code)
    }
    return created
  }

  // Compare-and-set so a concurrent cancel or quote decision cannot both
  // succeed; on a lost race the fresh draft order is removed again. (A
  // concurrent conversion is refused by the database at the insert above:
  // for an already-accepted quote this accepted -> accepted update would
  // not notice it.) Literal payloads on purpose: the phantom-column schema
  // guard can only check object literals.
  const { data: marked, error: markError } = isQuote
    ? await supabase
        .from('invoices')
        .update({
          quote_status: 'accepted',
          quote_decided_at: source.quote_decided_at ?? new Date().toISOString(),
        })
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .eq('quote_status', source.quote_status)
        .neq('status', 'cancelled')
        .select('id')
    : await supabase
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
