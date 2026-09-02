/**
 * Executor tests for the four staged kundorder (sales order) operations.
 * The executors are private to commit.ts and reached through
 * commitPendingOperation (same pattern as ignore-transaction-executor.test.ts).
 *
 * The lib/sales-orders services are mocked: the executors own only the
 * commit-boundary re-validation, the service call and the mapping of a
 * ServiceFailure onto the CommitResult contract. Totals, VAT and the state
 * machine are the services' business and are tested there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation, SalesOrder } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/sales-orders/write', () => ({
  createSalesOrder: vi.fn(),
}))
vi.mock('@/lib/sales-orders/transitions', () => ({
  transitionSalesOrder: vi.fn(),
}))
vi.mock('@/lib/sales-orders/register-delivery', () => ({
  registerSalesOrderDelivery: vi.fn(),
}))
vi.mock('@/lib/sales-orders/create-invoice-from-order', () => ({
  createInvoiceFromSalesOrder: vi.fn(),
}))

import { createSalesOrder } from '@/lib/sales-orders/write'
import { transitionSalesOrder } from '@/lib/sales-orders/transitions'
import { registerSalesOrderDelivery } from '@/lib/sales-orders/register-delivery'
import { createInvoiceFromSalesOrder } from '@/lib/sales-orders/create-invoice-from-order'
import { commitPendingOperation } from '../commit'

const ORDER_ID = '00000000-0000-4000-8000-0000000000aa'
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000bb'
const ITEM_ID = '00000000-0000-4000-8000-0000000000cc'
const INVOICE_ID = '00000000-0000-4000-8000-0000000000dd'

function makeOrder(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: ORDER_ID,
    company_id: 'company-1',
    user_id: 'user-1',
    customer_id: CUSTOMER_ID,
    order_number: 'OR-7',
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
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    items: [],
    delivery_progress: 'none',
    invoicing_progress: 'none',
    ...overrides,
  }
}

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_sales_order',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-09-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

const CREATE_PARAMS = {
  customer_id: CUSTOMER_ID,
  order_date: '2026-09-01',
  currency: 'SEK',
  items: [{ description: 'Konsulttimmar', quantity: 10, unit: 'tim', unit_price: 100 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_sales_order', () => {
  it('happy path: validates the staged params, calls the service and returns the order ids', async () => {
    vi.mocked(createSalesOrder).mockResolvedValue({ ok: true, order: makeOrder() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_sales_order', params: CREATE_PARAMS }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ sales_order_id: ORDER_ID, order_number: 'OR-7', status: 'draft', total: 1250 })
    expect(createSalesOrder).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      userId: 'user-1',
      input: expect.objectContaining({ customer_id: CUSTOMER_ID, items: expect.any(Array) }),
    })
  })

  it('maps a coded service failure onto the structured error (CUSTOMER_NOT_FOUND -> 404 auto-reject)', async () => {
    vi.mocked(createSalesOrder).mockResolvedValue({ ok: false, code: 'CUSTOMER_NOT_FOUND', details: { customerId: CUSTOMER_ID } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // reject write

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_sales_order', params: CREATE_PARAMS }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
    expect(result.code).toBe('CUSTOMER_NOT_FOUND')
    expect(result.data).toEqual({ customerId: CUSTOMER_ID })
  })

  it('rejects tampered params at the commit boundary before the service runs', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // reject write

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_sales_order', params: { ...CREATE_PARAMS, customer_id: 'not-a-uuid' } }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/customer_id/)
    expect(createSalesOrder).not.toHaveBeenCalled()
  })

  it('surfaces a raw DB failure as a 500 with the driver message', async () => {
    vi.mocked(createSalesOrder).mockResolvedValue({ ok: false, dbError: { message: 'connection reset' } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_sales_order', params: CREATE_PARAMS }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.error).toBe('connection reset')
  })
})

describe('commitPendingOperation: transition_sales_order', () => {
  it('happy path: confirms through the service', async () => {
    vi.mocked(transitionSalesOrder).mockResolvedValue({ ok: true, order: makeOrder({ status: 'confirmed' }) })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'transition_sales_order', params: { sales_order_id: ORDER_ID, action: 'confirm' } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ sales_order_id: ORDER_ID, status: 'confirmed', action: 'confirm' })
    expect(transitionSalesOrder).toHaveBeenCalledWith(supabase, { companyId: 'company-1', orderId: ORDER_ID, action: 'confirm' })
  })

  it('maps SALES_ORDER_HAS_INVOICES onto a 409 auto-reject', async () => {
    vi.mocked(transitionSalesOrder).mockResolvedValue({ ok: false, code: 'SALES_ORDER_HAS_INVOICES' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'transition_sales_order', params: { sales_order_id: ORDER_ID, action: 'cancel' } }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('SALES_ORDER_HAS_INVOICES')
    expect(result.error).toMatch(/fakturor/i)
  })

  it('rejects an action outside the enum before the service runs', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'transition_sales_order', params: { sales_order_id: ORDER_ID, action: 'complete' } }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.error).toMatch(/action/)
    expect(transitionSalesOrder).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: register_sales_order_delivery', () => {
  const params = {
    sales_order_id: ORDER_ID,
    delivery_date: '2026-09-02',
    lines: [{ sales_order_item_id: ITEM_ID, delivered_qty: 4 }],
  }

  it('happy path: passes the cumulative quantities to the service', async () => {
    vi.mocked(registerSalesOrderDelivery).mockResolvedValue({
      ok: true,
      order: makeOrder({ status: 'confirmed', last_delivery_date: '2026-09-02', delivery_progress: 'partial' }),
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'register_sales_order_delivery', params }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ sales_order_id: ORDER_ID, last_delivery_date: '2026-09-02', delivery_progress: 'partial' })
    expect(registerSalesOrderDelivery).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      orderId: ORDER_ID,
      input: { delivery_date: '2026-09-02', lines: [{ sales_order_item_id: ITEM_ID, delivered_qty: 4 }] },
    })
  })

  it('maps SALES_ORDER_OVER_DELIVERED (400) onto a failed op with the line details', async () => {
    vi.mocked(registerSalesOrderDelivery).mockResolvedValue({
      ok: false,
      code: 'SALES_ORDER_OVER_DELIVERED',
      details: { sales_order_item_id: ITEM_ID, quantity: 3, delivered_qty: 4 },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'register_sales_order_delivery', params }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.code).toBe('SALES_ORDER_OVER_DELIVERED')
    expect(result.data).toMatchObject({ sales_order_item_id: ITEM_ID, quantity: 3 })
  })
})

describe('commitPendingOperation: create_invoice_from_sales_order', () => {
  const params = { sales_order_id: ORDER_ID, mode: 'remaining', invoice_date: '2026-09-02', due_date: '2026-10-02' }
  const invoice = { id: INVOICE_ID, invoice_number: null, status: 'draft', total: 1250, currency: 'SEK' }

  it('happy path: creates the draft through the service and emits invoice.created', async () => {
    vi.mocked(createInvoiceFromSalesOrder).mockResolvedValue({
      ok: true,
      invoice: invoice as never,
      order: makeOrder({ status: 'completed', invoicing_progress: 'full' }),
    })
    const handler = vi.fn()
    eventBus.on('invoice.created', handler)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { ...invoice, items: [], customer: null } }) // complete-invoice select for the event
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_invoice_from_sales_order', params }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: null,
      sales_order_id: ORDER_ID,
      order_status: 'completed',
      invoicing_progress: 'full',
    })
    expect(createInvoiceFromSalesOrder).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      userId: 'user-1',
      orderId: ORDER_ID,
      input: { mode: 'remaining', invoice_date: '2026-09-02', due_date: '2026-10-02' },
    })
    expect(handler).toHaveBeenCalledTimes(1)
    // Handlers receive the payload, not the envelope.
    expect(handler.mock.calls[0][0]).toMatchObject({
      invoice: expect.objectContaining({ id: INVOICE_ID }),
      userId: 'user-1',
      companyId: 'company-1',
    })
  })

  it('maps SALES_ORDER_NOTHING_TO_INVOICE onto a 409 auto-reject and emits nothing', async () => {
    vi.mocked(createInvoiceFromSalesOrder).mockResolvedValue({ ok: false, code: 'SALES_ORDER_NOTHING_TO_INVOICE' })
    const handler = vi.fn()
    eventBus.on('invoice.created', handler)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ operation_type: 'create_invoice_from_sales_order', params }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('SALES_ORDER_NOTHING_TO_INVOICE')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a non-positive explicit pick at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({
        operation_type: 'create_invoice_from_sales_order',
        params: { sales_order_id: ORDER_ID, lines: [{ sales_order_item_id: ITEM_ID, quantity: 0 }] },
      }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.error).toMatch(/lines\.0\.quantity/)
    expect(createInvoiceFromSalesOrder).not.toHaveBeenCalled()
  })
})
