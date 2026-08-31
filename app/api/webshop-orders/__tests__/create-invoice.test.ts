import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const mockBuildInvoiceWriteData = vi.fn()
vi.mock('@/lib/invoices/build-invoice-write', () => ({
  buildInvoiceWriteData: (...args: unknown[]) => mockBuildInvoiceWriteData(...args),
}))

import { POST } from '../[id]/create-invoice/route'

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    company_id: 'company-1',
    row_type: 'order',
    external_id: 'woo_butik.example.se_order_1001',
    order_number: '1001',
    status: 'processing',
    is_paid: false,
    order_date: '2026-08-01',
    paid_date: null,
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [
      { name: 'Produkt A', quantity: 2, total: 400, total_tax: 100, vat_rate: 25 },
    ],
    customer_name: 'Test Person',
    customer_company: 'Testbolaget AB',
    customer_email: 'kund@example.se',
    customer_orgnr: '556677-8899',
    payment_method: 'bacs',
    payment_method_title: 'Faktura',
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    store_label: 'Butiken',
    store_scope: 'butik.example.se',
    ...overrides,
  }
}

const okBuild = {
  ok: true,
  invoiceFields: {
    customer_id: 'cust-1',
    invoice_date: '2026-08-10',
    due_date: '2026-09-09',
    currency: 'SEK',
    subtotal: 400,
    vat_amount: 100,
    total: 500,
  },
  items: [
    {
      sort_order: 0,
      description: 'Produkt A',
      quantity: 2,
      unit: 'st',
      unit_price: 200,
      line_total: 400,
      vat_rate: 25,
      vat_amount: 100,
    },
  ],
}

function postCreate(body: unknown = {}, id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/create-invoice`, {
    method: 'POST',
    body,
  })
  return POST(request, createMockRouteParams({ id }))
}

describe('POST /api/webshop-orders/[id]/create-invoice', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(401)
  })

  it('returns 404 when the order is missing', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('returns 409 when already invoiced', async () => {
    enqueue({ data: makeOrderRow({ invoice_id: 'inv-1' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_INVOICED')
  })

  it('returns 409 when already booked', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-1' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
  })

  it('returns 409 when marked as booked outside the integration', async () => {
    enqueue({ data: makeOrderRow({ manually_booked_at: '2026-08-01T00:00:00Z' }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_MANUALLY_BOOKED')
  })

  it('returns 422 when the order carries no customer data and none is chosen', async () => {
    enqueue({
      data: makeOrderRow({
        customer_name: null,
        customer_company: null,
        customer_email: null,
      }),
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_CREATE_INVOICE_MISSING_CUSTOMER')
  })

  it('creates an unnumbered draft from a matched customer and links back', async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', customer_type: 'swedish_business' } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    const { status, body } = await parseJsonResponse<{ invoice_id: string }>(
      await postCreate(),
    )
    expect(status).toBe(200)
    expect(body.invoice_id).toBe('inv-1')

    const invoiceInsert = findCall('invoices', 'insert')
    expect(invoiceInsert).toBeDefined()
    expect((invoiceInsert![0] as Record<string, unknown>).invoice_number).toBeNull()
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ documentType: 'invoice' }),
    )
    const linkUpdate = findCall('webshop_orders', 'update')
    expect(linkUpdate).toBeDefined()
    expect((linkUpdate![0] as Record<string, unknown>).invoice_id).toBe('inv-1')
  })

  it('creates a customer from the order billing data when none matches', async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: 'swedish_business' } }) // customer insert
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
    const customerInsert = findCall('customers', 'insert')
    expect(customerInsert).toBeDefined()
    expect(customerInsert![0]).toMatchObject({
      name: 'Testbolaget AB',
      // Must be a value customers_customer_type_check accepts; 'business' is
      // not one and made every business-order conversion 500 in production.
      // No customer_country on the order defaults to domestic.
      customer_type: 'swedish_business',
      contact_person: 'Test Person',
    })
    // Scraped orgnr must NOT auto-land on the customer's legal field
    // (Swedish compliance review): the dialog shows it for manual review.
    expect(customerInsert![0]).not.toHaveProperty('org_number')
  })

  // Reverse charge (EU) and export (non-EU) treatment key off customer_type,
  // so the billing country must classify the created customer up front
  // instead of stamping every business order as domestic.
  it.each([
    ['SE', 'swedish_business'],
    ['DE', 'eu_business'],
    ['no', 'non_eu_business'],
  ])('classifies a business order with country %s as %s', async (country, expected) => {
    enqueue({ data: makeOrderRow({ customer_country: country }) }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: expected } })
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
    const customerInsert = findCall('customers', 'insert')
    expect(customerInsert![0]).toMatchObject({ customer_type: expected })
  })

  it('rolls back the draft when the order link-back fails', async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB' } })
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items insert ok
    enqueue({ data: null, error: { message: 'link failed' } }) // link-back DB error
    enqueue({ data: null }) // items delete
    enqueue({ data: null }) // invoice delete

    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBeGreaterThanOrEqual(500)
    const deletes = findCall('invoices', 'delete')
    expect(deletes).toBeDefined()
  })

  it('refuses refund rows', async () => {
    enqueue({ data: makeOrderRow({ row_type: 'refund' }) })
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(409)
  })

  it('returns 409 while the legacy feed transaction is open (double-booking lock)', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: false } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN')
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('creates the draft when the legacy feed transaction was ignored', async () => {
    enqueue({ data: makeOrderRow({ legacy_transaction_id: 'txn-1' }) })
    enqueue({ data: { id: 'txn-1', journal_entry_id: null, is_ignored: true } })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB' } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
  })

  it('returns 409 and rolls back when the link-back matches zero rows (raced)', async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB' } })
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items insert ok
    enqueue({ data: [] }) // link-back matched ZERO rows
    enqueue({ data: null }) // items delete
    enqueue({ data: null }) // invoice delete
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await postCreate(),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_ALREADY_INVOICED')
    expect(findCall('invoices', 'delete')).toBeDefined()
  })

  it('returns 403 when the caller is a viewer (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(403)
    expect(mockBuildInvoiceWriteData).not.toHaveBeenCalled()
  })

  it('collapses non-divisible lines to quantity 1 and applies the single-bucket rate', async () => {
    enqueue({
      data: makeOrderRow({
        line_items: [
          { name: 'Produkt B', quantity: 3, total: 100, total_tax: 25, vat_rate: null },
        ],
        vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
      }),
    })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB' } })
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'order-1' }] })
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
    const input = mockBuildInvoiceWriteData.mock.calls[0][0] as {
      input: { items: Array<Record<string, unknown>> }
    }
    // 100/3 does not divide evenly in öre: exact total at quantity 1 instead
    // of 3 x 33.33 = 99.99 silently shrinking the invoice.
    expect(input.input.items[0]).toMatchObject({
      quantity: 1,
      unit_price: 100,
      description: 'Produkt B (3 st)',
      vat_rate: 25,
    })
  })
})
