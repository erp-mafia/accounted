import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { Currency, Customer, Invoice, SalesOrder, SalesOrderItem } from '@/types'
import type { CreateInvoiceFromSalesOrderSchema } from '@/lib/api/schemas'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { loadSalesOrder } from './load'
import { qtyGreater, roundQty } from './progress'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

export type CreateInvoiceFromOrderInput = z.infer<typeof CreateInvoiceFromSalesOrderSchema>

export interface PickedLine {
  item: SalesOrderItem
  quantity: number
}

/**
 * Resolve which order lines (and how much of each) go on the invoice.
 * Explicit picks win (duplicates for the same line are summed); otherwise
 * `mode` selects:
 *   remaining = everything not yet invoiced (default)
 *   delivered = delivered but not yet invoiced (delivered_qty - invoiced_qty)
 * Quantities are rounded to quantity precision so a float remainder such as
 * 0.5999999999999996 never reaches the DB or the invoice. Text rows are
 * carried along as text lines when at least one product line is picked, so
 * the invoice reads like the order.
 */
export function pickLines(
  order: SalesOrder,
  input: Pick<CreateInvoiceFromOrderInput, 'mode' | 'lines'>,
): ServiceResult<{ picked: PickedLine[] }> {
  const items = (order.items ?? []).filter((i) => i.line_type !== 'text')
  const byId = new Map(items.map((i) => [i.id, i]))
  const picked: PickedLine[] = []

  if (input.lines && input.lines.length > 0) {
    const requested = new Map<string, number>()
    for (const line of input.lines) {
      requested.set(line.sales_order_item_id, roundQty((requested.get(line.sales_order_item_id) ?? 0) + line.quantity))
    }
    for (const [itemId, quantity] of requested) {
      const item = byId.get(itemId)
      if (!item) return fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: itemId })
      const remaining = remainingOf(item)
      if (qtyGreater(quantity, remaining)) {
        return fail('SALES_ORDER_OVER_INVOICED', {
          sales_order_item_id: item.id,
          remaining_qty: remaining,
          requested_qty: quantity,
        })
      }
      if (quantity > 0) picked.push({ item, quantity })
    }
  } else {
    const mode = input.mode ?? 'remaining'
    for (const item of items) {
      const invoiced = roundQty(item.invoiced_qty ?? 0)
      const remaining = remainingOf(item)
      const qty =
        mode === 'delivered'
          ? Math.max(0, Math.min(remaining, roundQty(item.delivered_qty - invoiced)))
          : remaining
      if (qty > 0) picked.push({ item, quantity: qty })
    }
  }

  if (picked.length === 0) return fail('SALES_ORDER_NOTHING_TO_INVOICE')
  return { ok: true, picked }
}

function remainingOf(item: SalesOrderItem): number {
  if (typeof item.remaining_qty === 'number') return roundQty(item.remaining_qty)
  return Math.max(0, roundQty(item.quantity - roundQty(item.invoiced_qty ?? 0)))
}

/**
 * Leveransdatum for the invoice (ML 17 kap 24 § p.7; also the FX anchor per
 * ML 8 kap 21-23 §): the latest per-line delivery date over the lines the
 * invoice covers, and only when every covered quantity has actually been
 * delivered (delivered minus already invoiced covers the pick). An advance
 * invoice for undelivered quantity gets no delivery date.
 */
export function deliveryDateFor(picked: PickedLine[]): string | null {
  let latest: string | null = null
  for (const { item, quantity } of picked) {
    const undeliveredInvoiceable = roundQty(item.delivered_qty - roundQty(item.invoiced_qty ?? 0))
    if (qtyGreater(quantity, undeliveredInvoiceable)) return null
    const date = item.last_delivery_date ?? null
    if (!date) return null
    if (!latest || date > latest) latest = date
  }
  return latest
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
 *
 * Refuses when the customer's VAT facts (type, VAT-number validation) no
 * longer match what the order lines were validated under: a frozen 25 %
 * line can pass the permitted-set gate for a since-validated EU business
 * and would otherwise land silently. Re-saving the order re-validates.
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

  if (
    order.customer_type_snapshot &&
    (order.customer_type_snapshot !== customer.customer_type ||
      (order.customer_vat_validated_snapshot ?? false) !== (customer.vat_number_validated ?? false))
  ) {
    return fail('SALES_ORDER_CUSTOMER_VAT_CHANGED', {
      snapshot: {
        customer_type: order.customer_type_snapshot,
        vat_number_validated: order.customer_vat_validated_snapshot ?? false,
      },
      current: {
        customer_type: customer.customer_type,
        vat_number_validated: customer.vat_number_validated ?? false,
      },
    })
  }

  const invoiceDate = input.invoice_date ?? todayIsoStockholm()
  let dueDate = input.due_date
  if (!dueDate) {
    const due = new Date(invoiceDate)
    due.setDate(due.getDate() + (customer.default_payment_terms ?? 30))
    dueDate = due.toISOString().slice(0, 10)
  }
  const deliveryDate = deliveryDateFor(picked)

  const pickedById = new Map(picked.map((p) => [p.item.id, p]))
  const items: InvoiceWriteInput['items'] = []
  for (const line of [...(order.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
    if (line.line_type === 'text') {
      items.push({ line_type: 'text', description: line.description, quantity: 0, unit: '', unit_price: 0 })
      continue
    }
    const pick = pickedById.get(line.id)
    if (!pick) continue
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
