/**
 * Synthetic fixtures for the kundorder (sales order) tests. Shared by the
 * service tests in this directory and the route tests under
 * app/api/sales-orders and app/api/invoices/[id]/convert-to-order.
 *
 * Ids are RFC 4122 v4-shaped so they pass the Zod `uuid` primitive.
 */
import type { Customer, SalesOrder, SalesOrderItem } from '@/types'
import { makeCustomer } from '@/tests/helpers'

export const IDS = {
  company: 'company-1',
  user: 'user-1',
  order: 'a1000000-0000-4000-8000-000000000001',
  customer: 'c1000000-0000-4000-8000-000000000001',
  otherCustomer: 'c1000000-0000-4000-8000-000000000002',
  item1: 'd1000000-0000-4000-8000-000000000001',
  item2: 'd1000000-0000-4000-8000-000000000002',
  item3: 'd1000000-0000-4000-8000-000000000003',
  unknownItem: 'e1000000-0000-4000-8000-000000000009',
  invoice: 'f1000000-0000-4000-8000-000000000001',
} as const

export function makeOrderCustomer(overrides: Partial<Customer> = {}): Customer {
  return makeCustomer({
    id: IDS.customer,
    name: 'Testbrand AB',
    email: 'test@testbrand.example',
    customer_type: 'swedish_business',
    vat_number: null,
    vat_number_validated: false,
    vat_number_validated_at: null,
    personal_number: null,
    default_payment_terms: 30,
    ...overrides,
  })
}

export function makeSalesOrderItem(overrides: Partial<SalesOrderItem> = {}): SalesOrderItem {
  return {
    id: IDS.item1,
    company_id: IDS.company,
    sales_order_id: IDS.order,
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimme',
    quantity: 10,
    delivered_qty: 0,
    unit: 'h',
    unit_price: 100,
    discount_percent: 0,
    vat_rate: 25,
    line_total: 1000,
    article_id: null,
    revenue_account: null,
    dimensions: {},
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

export function makeSalesOrder(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: IDS.order,
    company_id: IDS.company,
    user_id: IDS.user,
    customer_id: IDS.customer,
    order_number: 'OR-1',
    status: 'draft',
    source_invoice_id: null,
    order_date: '2026-09-01',
    requested_delivery_date: null,
    last_delivery_date: null,
    currency: 'SEK',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    your_reference: null,
    our_reference: null,
    notes: null,
    default_dimensions: {},
    confirmed_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-01T08:00:00Z',
    customer: makeOrderCustomer(),
    items: [makeSalesOrderItem()],
    ...overrides,
  }
}

/** Row shape returned by the sales_order_invoiced_quantities RPC. */
export function invoicedRow(itemId: string, qty: number | string) {
  return { sales_order_item_id: itemId, invoiced_qty: qty }
}
