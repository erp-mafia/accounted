import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { Customer, SalesOrder, SalesOrderItem } from '@/types'
import type { CreateSalesOrderSchema, UpdateSalesOrderSchema } from '@/lib/api/schemas'
import { normalizeSalesOrderLines, type SalesOrderLineRow } from './lines'
import { ensureSalesOrderNumber } from './ensure-order-number'
import { fetchInvoicedQuantities, loadSalesOrder } from './load'
import { codeFromPgError, fail, failDb, type ServiceResult } from './result'

export type CreateSalesOrderInput = z.infer<typeof CreateSalesOrderSchema>
export type UpdateSalesOrderInput = z.infer<typeof UpdateSalesOrderSchema>

const EDITABLE_STATUSES = new Set(['draft', 'confirmed'])

async function loadCustomer(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<{ ok: true; customer: Customer } | { ok: false; code: string; details?: Record<string, unknown> }> {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle<Customer>()
  if (!data) return { ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customerId } }
  return { ok: true, customer: data }
}

/**
 * Create a draft order with its lines. Number allocated at creation (orders
 * are not verifikationer; gaps are irrelevant). A failed line insert rolls
 * the header back so no empty order survives.
 */
export async function createSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; input: CreateSalesOrderInput; sourceInvoiceId?: string | null },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, userId, input } = params
  const customerRes = await loadCustomer(supabase, companyId, input.customer_id)
  if (!customerRes.ok) return fail(customerRes.code, customerRes.details)

  const lines = normalizeSalesOrderLines(input.items, customerRes.customer)
  if (!lines.ok) return fail(lines.code, lines.details)

  const { data: header, error: headerError } = await supabase
    .from('sales_orders')
    .insert({
      company_id: companyId,
      user_id: userId,
      customer_id: input.customer_id,
      status: 'draft',
      source_invoice_id: params.sourceInvoiceId ?? null,
      order_date: input.order_date ?? new Date().toISOString().slice(0, 10),
      requested_delivery_date: input.requested_delivery_date ?? null,
      currency: input.currency ?? 'SEK',
      your_reference: input.your_reference ?? null,
      our_reference: input.our_reference ?? null,
      notes: input.notes ?? null,
      default_dimensions: input.default_dimensions ?? {},
      ...lines.totals,
    })
    .select('id')
    .single<{ id: string }>()
  if (headerError || !header) return failDb(headerError ?? new Error('sales order insert returned no row'))

  const { error: itemsError } = await supabase
    .from('sales_order_items')
    .insert(lines.rows.map((row) => toInsertRow(row, companyId, header.id)))
  if (itemsError) {
    await supabase.from('sales_orders').delete().eq('id', header.id)
    return failDb(itemsError)
  }

  // Non-fatal: an unnumbered order is still usable and gets numbered on the
  // next write (the RPC is idempotent).
  try {
    await ensureSalesOrderNumber(supabase, companyId, header.id)
  } catch {
    // reported through the order's null order_number
  }

  return loadSalesOrder(supabase, companyId, header.id)
}

/**
 * Full replace of header + lines while draft or confirmed.
 *
 * Lines are matched by id so a confirmed order keeps delivered/invoiced
 * history on the lines that survive. A line that has been delivered or
 * invoiced cannot be dropped (SALES_ORDER_LINE_LOCKED) and cannot go below
 * its delivered quantity (SALES_ORDER_OVER_DELIVERED); the DB trigger
 * additionally refuses lowering below the invoiced quantity.
 */
export async function updateSalesOrder(
  supabase: SupabaseClient,
  params: { companyId: string; orderId: string; input: UpdateSalesOrderInput },
): Promise<ServiceResult<{ order: SalesOrder }>> {
  const { companyId, orderId, input } = params
  const current = await loadSalesOrder(supabase, companyId, orderId)
  if (!current.ok) return current
  const order = current.order
  if (!EDITABLE_STATUSES.has(order.status)) return fail('SALES_ORDER_NOT_EDITABLE', { status: order.status })

  const customerId = input.customer_id ?? order.customer_id
  if (!customerId) return fail('SALES_ORDER_CUSTOMER_MISSING')
  const customerRes = await loadCustomer(supabase, companyId, customerId)
  if (!customerRes.ok) return fail(customerRes.code, customerRes.details)

  const existing = new Map((order.items ?? []).map((i) => [i.id, i]))
  let rows: SalesOrderLineRow[] | null = null
  let totals = { subtotal: order.subtotal, vat_amount: order.vat_amount, total: order.total }

  if (input.items) {
    const lines = normalizeSalesOrderLines(input.items, customerRes.customer)
    if (!lines.ok) return fail(lines.code, lines.details)
    rows = lines.rows
    totals = lines.totals

    const incomingIds = new Set(rows.map((r) => r.id).filter((id): id is string => Boolean(id)))
    for (const id of incomingIds) {
      if (!existing.has(id)) return fail('SALES_ORDER_LINE_NOT_FOUND', { sales_order_item_id: id })
    }
    for (const row of rows) {
      if (!row.id) continue
      const prev = existing.get(row.id) as SalesOrderItem
      if (row.quantity < prev.delivered_qty) {
        return fail('SALES_ORDER_OVER_DELIVERED', { sales_order_item_id: row.id, delivered_qty: prev.delivered_qty })
      }
      if (row.quantity < (prev.invoiced_qty ?? 0)) {
        return fail('SALES_ORDER_QUANTITY_BELOW_INVOICED', { sales_order_item_id: row.id, invoiced_qty: prev.invoiced_qty })
      }
    }
    for (const prev of existing.values()) {
      if (incomingIds.has(prev.id)) continue
      if (prev.delivered_qty > 0 || (prev.invoiced_qty ?? 0) > 0) {
        return fail('SALES_ORDER_LINE_LOCKED', { sales_order_item_id: prev.id })
      }
    }
  } else if (input.customer_id && input.customer_id !== order.customer_id) {
    // Customer change without lines: re-validate the stored lines against
    // the new customer's VAT rules so the order still converts cleanly.
    const lines = normalizeSalesOrderLines(
      (order.items ?? []).map((i) => ({
        id: i.id,
        line_type: i.line_type,
        description: i.description,
        quantity: i.quantity,
        unit: i.unit,
        unit_price: i.unit_price,
        discount_percent: i.discount_percent,
        vat_rate: i.vat_rate,
        article_id: i.article_id,
        revenue_account: i.revenue_account,
        dimensions: i.dimensions,
      })),
      customerRes.customer,
    )
    if (!lines.ok) return fail(lines.code, lines.details)
  }

  const headerPatch: Record<string, unknown> = { ...totals }
  if (input.customer_id !== undefined) headerPatch.customer_id = input.customer_id
  if (input.order_date !== undefined) headerPatch.order_date = input.order_date
  if (input.requested_delivery_date !== undefined) headerPatch.requested_delivery_date = input.requested_delivery_date
  if (input.currency !== undefined) headerPatch.currency = input.currency
  if (input.your_reference !== undefined) headerPatch.your_reference = input.your_reference
  if (input.our_reference !== undefined) headerPatch.our_reference = input.our_reference
  if (input.notes !== undefined) headerPatch.notes = input.notes
  if (input.default_dimensions !== undefined) headerPatch.default_dimensions = input.default_dimensions

  const { error: headerError } = await supabase
    .from('sales_orders')
    .update(headerPatch)
    .eq('id', orderId)
    .eq('company_id', companyId)
  if (headerError) return failDb(headerError)

  if (rows) {
    const keep = new Set(rows.map((r) => r.id).filter(Boolean))
    const toDelete = [...existing.keys()].filter((id) => !keep.has(id))
    if (toDelete.length > 0) {
      const { error } = await supabase.from('sales_order_items').delete().in('id', toDelete).eq('company_id', companyId)
      if (error) return mapPg(error)
    }
    for (const row of rows) {
      if (row.id) {
        const { id, ...patch } = row
        const { error } = await supabase
          .from('sales_order_items')
          .update(patch)
          .eq('id', id)
          .eq('company_id', companyId)
        if (error) return mapPg(error)
      }
    }
    const inserts = rows.filter((r) => !r.id).map((r) => toInsertRow(r, companyId, orderId))
    if (inserts.length > 0) {
      const { error } = await supabase.from('sales_order_items').insert(inserts)
      if (error) return mapPg(error)
    }
  }

  return loadSalesOrder(supabase, companyId, orderId)
}

function toInsertRow(row: SalesOrderLineRow, companyId: string, orderId: string) {
  const { id: _id, ...rest } = row
  return { ...rest, company_id: companyId, sales_order_id: orderId }
}

function mapPg(error: unknown): ServiceResult<never> {
  const code = codeFromPgError(error)
  return code ? fail(code) : failDb(error)
}

/** Progress-aware existence check reused by transitions and delivery. */
export async function hasOpenInvoices(
  supabase: SupabaseClient,
  companyId: string,
  orderId: string,
): Promise<{ ok: true; open: boolean } | { ok: false; dbError: unknown }> {
  const invoiced = await fetchInvoicedQuantities(supabase, [orderId])
  if (!invoiced.ok) return invoiced
  for (const qty of invoiced.byItem.values()) {
    if (qty > 0) return { ok: true, open: true }
  }
  // Zero-quantity links (e.g. a draft with a 0 line) still tie the invoice
  // to the order; count header links too.
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('sales_order_id', orderId)
    .not('status', 'in', '("cancelled","credited")')
  if (error) return { ok: false, dbError: error }
  return { ok: true, open: (count ?? 0) > 0 }
}
