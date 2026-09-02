import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { Currency, Customer, Invoice, SalesOrder, SalesOrderItem } from '@/types'
import type { CreateInvoiceFromSalesOrderSchema } from '@/lib/api/schemas'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { loadSalesOrder } from './load'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

export type CreateInvoiceFromOrderInput = z.infer<typeof CreateInvoiceFromSalesOrderSchema>

export interface PickedLine {
  item: SalesOrderItem
  quantity: number
}

/**
 * Resolve which order lines (and how much of each) go on the invoice.
 * Explicit picks win; otherwise `mode` selects:
 *   remaining = everything not yet invoiced (default)
 *   delivered = delivered but not yet invoiced (delivered_qty - invoiced_qty)
 * Text rows are carried along as text lines when at least one product line
 * is picked, so the invoice reads like the order.
 */
export function pickLines(
  order: SalesOrder,
  input: Pick<CreateInvoiceFromOrderInput, 'mode' | 'lines'>,
): ServiceResult<{ picked: PickedLine[] }> {
  const items = (order.items ?? []).filter((i) => i.line_type !== 'text')
  const byId = new Map(items.map((i) => [i.id, i]))
  const picked: PickedLine[] = []

  if (input.lines && input.lines.length > 0) {
    for (const line of input.lines) {
      const item = byId.get(line.sales_order_item_id)
      if (!item) return fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: line.sales_order_item_id })
      const remaining = item.remaining_qty ?? Math.max(0, item.quantity - (item.invoiced_qty ?? 0))
      if (line.quantity > remaining) {
        return fail('SALES_ORDER_OVER_INVOICED', {
          sales_order_item_id: item.id,
          remaining_qty: remaining,
          requested_qty: line.quantity,
        })
      }
      picked.push({ item, quantity: line.quantity })
    }
  } else {
    const mode = input.mode ?? 'remaining'
    for (const item of items) {
      const invoiced = item.invoiced_qty ?? 0
      const remaining = Math.max(0, item.quantity - invoiced)
      const qty = mode === 'delivered' ? Math.max(0, Math.min(remaining, item.delivered_qty - invoiced)) : remaining
      if (qty > 0) picked.push({ item, quantity: qty })
    }
  }

  if (picked.length === 0) return fail('SALES_ORDER_NOTHING_TO_INVOICE')
  return { ok: true, picked }
}

/**
 * Create an unnumbered DRAFT kundfaktura from an order.
 *
 * Goes through buildInvoiceWriteData() like every other invoice (VAT gating,
 * totals, currency, revenue-account validation), so booking stays in the
 * engine when the draft is later sent. Each invoice line carries
 * sales_order_item_id; the order's invoiced quantity is derived from those
 * links and the DB trigger refuses over-invoicing even under a race. The
 * order's completion (confirmed -> completed) is maintained by the DB.
 */
export async function createInvoiceFromSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; orderId: string; input: CreateInvoiceFromOrderInput },
): Promise<ServiceResult<{ invoice: Invoice; order: SalesOrder }>> {
  const { companyId, userId, orderId, input } = params
  const current = await loadSalesOrder(supabase, companyId, orderId)
  if (!current.ok) return current
  const order = current.order
  if (order.status !== 'confirmed') {
    return fail('SALES_ORDER_INVALID_STATE', { status: order.status, action: 'invoice' })
  }
  if (!order.customer_id) return fail('SALES_ORDER_CUSTOMER_MISSING')

  const pickedRes = pickLines(order, input)
  if (!pickedRes.ok) return pickedRes
  const { picked } = pickedRes

  // Raw customer row for the builder (the embed on the order is masked).
  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', order.customer_id)
    .eq('company_id', companyId)
    .maybeSingle<Customer>()
  if (!customer) return fail('CUSTOMER_NOT_FOUND', { customerId: order.customer_id })

  const invoiceDate = input.invoice_date ?? new Date().toISOString().slice(0, 10)
  let dueDate = input.due_date
  if (!dueDate) {
    const due = new Date(invoiceDate)
    due.setDate(due.getDate() + (customer.default_payment_terms ?? 30))
    dueDate = due.toISOString().slice(0, 10)
  }
  // Delivery date only when the invoice covers delivered goods: an advance
  // invoice for undelivered lines has no taxable-event date yet.
  const anyDelivered = picked.some((p) => p.item.delivered_qty > 0)
  const deliveryDate = anyDelivered ? order.last_delivery_date : null

  const pickedIds = new Set(picked.map((p) => p.item.id))
  const items: InvoiceWriteInput['items'] = []
  for (const line of [...(order.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
    if (line.line_type === 'text') {
      items.push({ line_type: 'text', description: line.description, quantity: 0, unit: '', unit_price: 0 })
      continue
    }
    if (!pickedIds.has(line.id)) continue
    const pick = picked.find((p) => p.item.id === line.id) as PickedLine
    items.push({
      line_type: 'product',
      description: line.description,
      quantity: pick.quantity,
      unit: line.unit,
      unit_price: line.unit_price,
      discount_percent: line.discount_percent > 0 ? line.discount_percent : null,
      vat_rate: line.vat_rate,
      article_id: line.article_id,
      revenue_account: line.revenue_account,
      sales_order_item_id: line.id,
      dimensions: line.dimensions,
    })
  }

  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    customer,
    documentType: 'invoice',
    input: {
      customer_id: customer.id,
      invoice_date: invoiceDate,
      due_date: dueDate,
      delivery_date: deliveryDate,
      currency: order.currency as Currency,
      your_reference: order.your_reference ?? undefined,
      our_reference: order.our_reference ?? undefined,
      notes: order.order_number ? `Kundorder ${order.order_number}` : undefined,
      default_dimensions: order.default_dimensions ?? {},
      items,
    },
  })
  if (!build.ok) {
    if ('dbError' in build) return failDb(build.dbError)
    return fail(build.code, build.details)
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: null,
      status: 'draft',
      sales_order_id: orderId,
      ...build.invoiceFields,
    })
    .select()
    .single<Invoice>()
  if (invoiceError || !invoice) return failDb(invoiceError ?? new Error('invoice insert returned no row'))

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(build.items.map((item) => ({ ...item, invoice_id: invoice.id })))
  if (itemsError) {
    // Unnumbered draft: hard delete leaves no F-series gap.
    await supabase.from('invoice_items').delete().eq('invoice_id', invoice.id)
    await supabase.from('invoices').delete().eq('id', invoice.id)
    const code = codeFromPgError(itemsError)
    return code ? fail(code) : failDb(itemsError)
  }

  const reloaded = await loadSalesOrder(supabase, companyId, orderId)
  if (!reloaded.ok) return reloaded
  return { ok: true, invoice, order: reloaded.order }
}
