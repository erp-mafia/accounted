/**
 * POST /api/invoices/[id]/convert-to-order: proforma or offert -> draft
 * kundorder.
 *
 * Queue order: invoices select (source + items), sales_orders head count
 * (live order already?), for a quote the invoices converted_from_id lookup
 * (live invoice already?), then createSalesOrder (customers select,
 * sales_orders insert, sales_order_items insert, generate number rpc,
 * sales_orders select, invoiced rpc), then the invoices compare-and-set
 * update that marks the proforma cancelled or the quote accepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  makeInvoice,
} from '@/tests/helpers'
import { IDS, makeOrderCustomer, makeSalesOrder } from '@/lib/sales-orders/__tests__/fixtures'
import type { SalesOrder } from '@/types'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const params = createMockRouteParams({ id: IDS.invoice })

function post() {
  return POST(createMockRequest(`/api/invoices/${IDS.invoice}/convert-to-order`, { method: 'POST' }), params)
}

function makeProforma(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({
      id: IDS.invoice,
      customer_id: IDS.customer,
      document_type: 'proforma',
      status: 'sent',
      invoice_number: 'P-2026001',
      your_reference: 'Anna',
      notes: 'Enligt offert',
    }),
    items: [
      {
        id: 'e2000000-0000-4000-8000-000000000002',
        sort_order: 1,
        line_type: 'text',
        description: 'Tack för förtroendet',
        quantity: 0,
        unit: null,
        unit_price: 0,
        vat_rate: 0,
      },
      {
        id: 'e2000000-0000-4000-8000-000000000001',
        sort_order: 0,
        line_type: 'product',
        description: 'Konsulttimme',
        quantity: 10,
        unit: 'h',
        unit_price: 100,
        discount_percent: null,
        vat_rate: 25,
        article_id: null,
        revenue_account: '3011',
        dimensions: { project: 'P1' },
      },
    ] as Record<string, unknown>[],
    ...overrides,
  }
}

describe('POST /api/invoices/[id]/convert-to-order', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: IDS.user }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(403)
  })

  it('returns 404 when the invoice is missing', async () => {
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('returns 400 SALES_ORDER_SOURCE_NOT_PROFORMA for a real invoice', async () => {
    enqueue({ data: makeProforma({ document_type: 'invoice' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_NOT_PROFORMA')
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('returns 409 SALES_ORDER_SOURCE_ALREADY_CONVERTED for a cancelled proforma', async () => {
    enqueue({ data: makeProforma({ status: 'cancelled' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
  })

  it('returns 409 SALES_ORDER_SOURCE_ALREADY_CONVERTED when an order already points at the proforma', async () => {
    enqueue({ data: makeProforma() })
    enqueue({ data: null, count: 1 })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['source_invoice_id', IDS.invoice])
  })

  it('returns 409 SALES_ORDER_CUSTOMER_MISSING for a proforma without customer', async () => {
    enqueue({ data: makeProforma({ customer_id: null }) })
    enqueue({ data: null, count: 0 })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_CUSTOMER_MISSING')
  })

  it('returns 400 SALES_ORDER_SOURCE_UNSUPPORTED_LINES for a ROT line (order lines carry no skattereduktion)', async () => {
    const proforma = makeProforma()
    proforma.items[1] = {
      ...proforma.items[1],
      deduction_type: 'rot',
      labor_hours: 8,
      work_type: 'bygg',
    }
    enqueue({ data: proforma })
    enqueue({ data: null, count: 0 })

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { lines: Record<string, unknown>[] } } }>(
      await post(),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_UNSUPPORTED_LINES')
    expect(body.error.details.lines).toEqual([
      {
        invoice_item_id: 'e2000000-0000-4000-8000-000000000001',
        deduction_type: 'rot',
        accrual: false,
        quantity: 10,
      },
    ])
    // Refused after the already-converted count, before the customer load and any insert.
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['source_invoice_id', IDS.invoice])
    expect(findCall('customers', 'select')).toBeUndefined()
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  it('returns 400 SALES_ORDER_SOURCE_UNSUPPORTED_LINES for a negative-quantity line', async () => {
    const proforma = makeProforma()
    proforma.items.push({
      ...proforma.items[1],
      id: 'e2000000-0000-4000-8000-000000000003',
      sort_order: 2,
      description: 'Rabatt',
      quantity: -1,
      unit_price: 200,
    })
    enqueue({ data: proforma })
    enqueue({ data: null, count: 0 })

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { lines: Record<string, unknown>[] } } }>(
      await post(),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_UNSUPPORTED_LINES')
    expect(body.error.details.lines).toEqual([
      {
        invoice_item_id: 'e2000000-0000-4000-8000-000000000003',
        deduction_type: null,
        accrual: false,
        quantity: -1,
      },
    ])
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('returns 400 SALES_ORDER_SOURCE_UNSUPPORTED_LINES for a periodised line', async () => {
    const proforma = makeProforma()
    proforma.items[1] = {
      ...proforma.items[1],
      accrual_period_start: '2026-09-01',
      accrual_period_end: '2027-08-31',
      accrual_balance_account: '2990',
    }
    enqueue({ data: proforma })
    enqueue({ data: null, count: 0 })

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { lines: Record<string, unknown>[] } } }>(
      await post(),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_UNSUPPORTED_LINES')
    expect(body.error.details.lines[0]).toMatchObject({ deduction_type: null, accrual: true })
    expect(findCall('sales_orders', 'insert')).toBeUndefined()
  })

  it('does not treat a text row as unsupported (text rows have no deduction or quantity)', async () => {
    // Same happy path as below, with the text row carrying a stray negative
    // quantity: text rows are copied as quantity 0 and never gate the convert.
    const proforma = makeProforma()
    proforma.items[0] = { ...proforma.items[0], quantity: -1 }
    enqueue({ data: proforma })
    enqueue({ data: null, count: 0 })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } })
    enqueue({ data: null })
    enqueue({ data: 'OR-1' })
    enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice, order_number: 'OR-1' }) })
    enqueue({ data: [] })
    enqueue({ data: [{ id: IDS.invoice }] })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(201)
    const lines = findCall('sales_order_items', 'insert')![0] as Record<string, unknown>[]
    expect(lines[1]).toMatchObject({ line_type: 'text', quantity: 0 })
  })

  it('creates a draft order from the proforma, cancels the proforma and answers 201 with sales_order_id', async () => {
    enqueue({ data: makeProforma() })
    enqueue({ data: null, count: 0 })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } }) // sales_orders insert
    enqueue({ data: null }) // sales_order_items insert
    enqueue({ data: 'OR-1' }) // generate_sales_order_number
    enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice, order_number: 'OR-1' }) })
    enqueue({ data: [] })
    enqueue({ data: [{ id: IDS.invoice }] }) // proforma CAS update

    const { status, body } = await parseJsonResponse<{ data: SalesOrder; sales_order_id: string }>(await post())

    expect(status).toBe(201)
    expect(body.sales_order_id).toBe(IDS.order)
    expect(body.data.id).toBe(IDS.order)
    expect(body.data.source_invoice_id).toBe(IDS.invoice)
    expect(body.data.status).toBe('draft')

    expect(findCall('sales_orders', 'insert')![0]).toMatchObject({
      customer_id: IDS.customer,
      source_invoice_id: IDS.invoice,
      currency: 'SEK',
      your_reference: 'Anna',
      notes: 'Enligt offert',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
    })
    // Lines copied in proforma sort order: product first, text row second.
    const lines = findCall('sales_order_items', 'insert')![0] as Record<string, unknown>[]
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      sort_order: 0,
      line_type: 'product',
      description: 'Konsulttimme',
      quantity: 10,
      unit: 'h',
      revenue_account: '3011',
      dimensions: { project: 'P1' },
      line_total: 1000,
    })
    expect(lines[1]).toMatchObject({ sort_order: 1, line_type: 'text', quantity: 0, line_total: 0 })

    expect(findCall('invoices', 'update')![0]).toEqual({ status: 'cancelled' })
    expect(findCall('invoices', 'neq')).toEqual(['status', 'cancelled'])
    expect(findCall('sales_orders', 'delete')).toBeUndefined()
  })

  describe('offert (quote) sources', () => {
    function makeQuote(overrides: Record<string, unknown> = {}) {
      return makeProforma({
        document_type: 'quote',
        status: 'sent',
        invoice_number: 'OF-003',
        valid_until: '2026-06-30',
        due_date: '2026-06-30',
        quote_status: 'open',
        quote_decided_at: null,
        ...overrides,
      })
    }

    it('returns 409 INVOICE_CONVERT_QUOTE_DECLINED for a declined quote', async () => {
      enqueue({ data: makeQuote({ quote_status: 'declined' }) })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_CONVERT_QUOTE_DECLINED')
      expect(findCall('sales_orders', 'insert')).toBeUndefined()
    })

    it('returns 409 SALES_ORDER_SOURCE_ALREADY_CONVERTED when a live order already points at the quote', async () => {
      enqueue({ data: makeQuote({ quote_status: 'accepted' }) })
      enqueue({ data: null, count: 1 })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
      expect(status).toBe(409)
      expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
      // A cancelled order frees the quote: the count excludes cancelled rows.
      expect(findCalls('sales_orders', 'neq')).toContainEqual(['status', 'cancelled'])
    })

    it('returns 409 INVOICE_QUOTE_ALREADY_INVOICED when a live invoice was converted from the quote', async () => {
      enqueue({ data: makeQuote({ quote_status: 'accepted' }) })
      enqueue({ data: null, count: 0 })
      enqueue({ data: { id: 'f1000000-0000-4000-8000-000000000009' } })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
      expect(findCalls('invoices', 'eq')).toContainEqual(['converted_from_id', IDS.invoice])
      expect(findCall('sales_orders', 'insert')).toBeUndefined()
    })

    it('creates a draft order from an open quote, marks the quote accepted (it stays) and answers 201', async () => {
      enqueue({ data: makeQuote() })
      enqueue({ data: null, count: 0 }) // no live order
      enqueue({ data: null }) // no live converted invoice
      enqueue({ data: makeOrderCustomer() })
      enqueue({ data: { id: IDS.order } }) // sales_orders insert
      enqueue({ data: null }) // sales_order_items insert
      enqueue({ data: 'OR-1' }) // generate_sales_order_number
      enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice, order_number: 'OR-1' }) })
      enqueue({ data: [] })
      enqueue({ data: [{ id: IDS.invoice }] }) // quote CAS update

      const { status, body } = await parseJsonResponse<{ data: SalesOrder; sales_order_id: string }>(await post())

      expect(status).toBe(201)
      expect(body.sales_order_id).toBe(IDS.order)
      expect(body.data.source_invoice_id).toBe(IDS.invoice)
      expect(findCall('sales_orders', 'insert')![0]).toMatchObject({
        customer_id: IDS.customer,
        source_invoice_id: IDS.invoice,
        total: 1250,
      })

      // The quote is the customer's accepted agreement: it flips to accepted
      // with a compare-and-set on the decision that was read, never cancelled.
      const update = findCall('invoices', 'update')![0] as Record<string, unknown>
      expect(update.quote_status).toBe('accepted')
      expect(typeof update.quote_decided_at).toBe('string')
      expect(update.status).toBeUndefined()
      expect(findCalls('invoices', 'eq')).toContainEqual(['quote_status', 'open'])
      expect(findCall('invoices', 'neq')).toEqual(['status', 'cancelled'])
      expect(findCall('sales_orders', 'delete')).toBeUndefined()
    })

    it('keeps the original decision timestamp when an accepted quote becomes an order', async () => {
      enqueue({ data: makeQuote({ quote_status: 'accepted', quote_decided_at: '2026-06-01T10:00:00Z' }) })
      enqueue({ data: null, count: 0 })
      enqueue({ data: null })
      enqueue({ data: makeOrderCustomer() })
      enqueue({ data: { id: IDS.order } })
      enqueue({ data: null })
      enqueue({ data: 'OR-1' })
      enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice, order_number: 'OR-1' }) })
      enqueue({ data: [] })
      enqueue({ data: [{ id: IDS.invoice }] })

      const { status } = await parseJsonResponse(await post())

      expect(status).toBe(201)
      expect(findCall('invoices', 'update')![0]).toEqual({
        quote_status: 'accepted',
        quote_decided_at: '2026-06-01T10:00:00Z',
      })
      expect(findCalls('invoices', 'eq')).toContainEqual(['quote_status', 'accepted'])
    })

    it('maps the one-live-order index violation on the header insert to 409 SALES_ORDER_SOURCE_ALREADY_CONVERTED', async () => {
      enqueue({ data: makeQuote({ quote_status: 'accepted' }) })
      enqueue({ data: null, count: 0 }) // pre-check passed (race)
      enqueue({ data: null })
      enqueue({ data: makeOrderCustomer() })
      enqueue({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_sales_orders_one_live_per_source"' },
      })

      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

      expect(status).toBe(409)
      expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
      expect(findCall('invoices', 'update')).toBeUndefined()
    })

    it('maps the source guard trigger on the header insert to 409 INVOICE_QUOTE_ALREADY_INVOICED', async () => {
      enqueue({ data: makeQuote({ quote_status: 'accepted' }) })
      enqueue({ data: null, count: 0 })
      enqueue({ data: null }) // pre-check passed (race)
      enqueue({ data: makeOrderCustomer() })
      enqueue({
        data: null,
        error: { code: 'P0001', message: `INVOICE_QUOTE_ALREADY_INVOICED: quote ${IDS.invoice} has a live converted invoice` },
      })

      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
      expect(findCall('invoices', 'update')).toBeUndefined()
    })

    it('removes the fresh order and answers 409 when the quote was decided or converted concurrently', async () => {
      enqueue({ data: makeQuote() })
      enqueue({ data: null, count: 0 })
      enqueue({ data: null })
      enqueue({ data: makeOrderCustomer() })
      enqueue({ data: { id: IDS.order } })
      enqueue({ data: null })
      enqueue({ data: 'OR-1' })
      enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice }) })
      enqueue({ data: [] })
      enqueue({ data: [] }) // CAS update matched nothing
      enqueue({ data: null }) // order delete

      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

      expect(status).toBe(409)
      expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
      expect(findCall('sales_orders', 'delete')).toBeDefined()
    })
  })

  it('removes the fresh order and answers 409 when the proforma was converted concurrently', async () => {
    enqueue({ data: makeProforma() })
    enqueue({ data: null, count: 0 })
    enqueue({ data: makeOrderCustomer() })
    enqueue({ data: { id: IDS.order } })
    enqueue({ data: null })
    enqueue({ data: 'OR-1' })
    enqueue({ data: makeSalesOrder({ source_invoice_id: IDS.invoice }) })
    enqueue({ data: [] })
    enqueue({ data: [] }) // CAS update matched nothing
    enqueue({ data: null }) // order delete

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('SALES_ORDER_SOURCE_ALREADY_CONVERTED')
    expect(findCall('sales_orders', 'delete')).toBeDefined()
    expect(findCalls('sales_orders', 'eq')).toContainEqual(['id', IDS.order])
  })
})
