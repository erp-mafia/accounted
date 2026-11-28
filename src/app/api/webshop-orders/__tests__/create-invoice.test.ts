import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', default_payment_terms: 30 } }) // email match
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

  it("puts the matched customer's Fakturareferens in Er referens over the buyer's name (crm#1200)", async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({
      data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', invoice_reference: 'KST 4410', default_payment_terms: 30 },
    }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    expect((await postCreate()).status).toBe(200)
    const input = (mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { your_reference?: string } }).input
    expect(input.your_reference).toBe('KST 4410')
  })

  it("puts the matched customer's Märkning on the invoice (crm#1477)", async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({
      data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', invoice_marking: '4500012345', default_payment_terms: 30 },
    }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    expect((await postCreate()).status).toBe(200)
    const input = (mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { invoice_marking?: string } }).input
    expect(input.invoice_marking).toBe('4500012345')
  })

  it("keeps the buyer's name in Er referens for a customer without a Fakturareferens", async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', invoice_reference: null, default_payment_terms: 30 } })
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null })
    enqueue({ data: [{ id: 'order-1' }] })

    expect((await postCreate()).status).toBe(200)
    const input = (mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { your_reference?: string } }).input
    expect(input.your_reference).toBe(makeOrderRow().customer_name)
  })

  it('creates a customer from the order billing data when none matches', async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: 'swedish_business', default_payment_terms: 30 } }) // customer insert
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
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: expected, default_payment_terms: 30 } })
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
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', default_payment_terms: 30 } })
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
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', default_payment_terms: 30 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched
    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
  })

  it('returns 409 and rolls back when the link-back matches zero rows (raced)', async () => {
    enqueue({ data: makeOrderRow() })
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', default_payment_terms: 30 } })
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
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', default_payment_terms: 30 } })
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

/*
 * accounted#18: the invoice date is the Swedish calendar day and the due
 * date counts the terms from it. 23:30 UTC is already the next day in
 * Stockholm, in summer (UTC+2) and in winter (UTC+1).
 */
describe('POST /api/webshop-orders/[id]/create-invoice: dates on the Swedish day', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-07-02', '2026-07-12'],
    ['winter', '2026-01-15T23:30:00Z', '2026-01-16', '2026-01-26'],
  ])('%s: at %s the invoice is dated %s and due %s', async (_season, instant, invoiceDate, dueDate) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', default_payment_terms: 10 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    const { status } = await parseJsonResponse(await postCreate())
    expect(status).toBe(200)
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invoice_date: invoiceDate, due_date: dueDate }) }),
    )
  })
})

/**
 * The terms an invoice from a webshop order is due by: the customer's, then
 * the company default, then 30, also on the customer the route creates.
 */
describe('POST /api/webshop-orders/[id]/create-invoice: the terms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-01T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a found customer without terms takes the company default', async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', default_payment_terms: null } }) // email match
    enqueue({ data: { invoice_default_days: 10 } }) // the company default
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    expect((await parseJsonResponse(await postCreate())).status).toBe(200)
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ due_date: '2026-08-11' }) }),
    )
  })

  it('a customer the route creates carries the company default on its card', async () => {
    enqueue({ data: makeOrderRow() }) // order fetch
    enqueue({ data: null }) // no email match
    enqueue({ data: { invoice_default_days: 10 } }) // the company default for the new card
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', customer_type: 'swedish_business', default_payment_terms: 10 } }) // customers insert
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    expect((await parseJsonResponse(await postCreate())).status).toBe(200)
    expect(findCall('customers', 'insert')?.[0]).toMatchObject({ default_payment_terms: 10 })
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ due_date: '2026-08-11' }) }),
    )
  })
})

/**
 * A Shopify order row carries no names (crm#1032): the dialog fetches the
 * billing contact from the store on demand and sends the customer the user
 * confirmed. It only shapes a customer the route creates.
 */
describe('POST /api/webshop-orders/[id]/create-invoice: customer confirmed in the dialog', () => {
  const shopifyRow = () =>
    makeOrderRow({
      platform: 'shopify',
      external_id: 'shopify_minbutik.myshopify.com_order_1001',
      customer_name: null,
      customer_company: null,
      customer_email: null,
      customer_orgnr: null,
      customer_country: 'DK',
    })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  it.each([
    ['neither a name nor a company', { email: 'kund@example.se' }],
    ['only blank names', { name: '  ', company: '' }],
    ['an invalid email', { name: 'Anna Andersson', email: 'inte-en-adress' }],
    ['an unknown field', { name: 'Anna Andersson', org_number: '556677-8899' }],
  ])('returns 400 for a customer with %s', async (_label, customer) => {
    const { status } = await parseJsonResponse(await postCreate({ customer }))
    expect(status).toBe(400)
    expect(findCall('webshop_orders', 'select')).toBeUndefined()
  })

  it('creates the confirmed company customer with the person as contact', async () => {
    enqueue({ data: shopifyRow() }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Kund AB', customer_type: 'eu_business', default_payment_terms: 30 } }) // customer insert
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(
      await postCreate({
        customer: { name: 'Anna Andersson', company: 'Kund AB', email: 'kund@example.se' },
      }),
    )

    expect(status).toBe(200)
    expect(findCall('customers', 'ilike')).toEqual(['email', 'kund@example.se'])
    expect(findCall('customers', 'insert')![0]).toMatchObject({
      name: 'Kund AB',
      contact_person: 'Anna Andersson',
      email: 'kund@example.se',
      // Classified by the order's country, as for the row's own snapshot.
      customer_type: 'eu_business',
      country: 'DK',
    })
    const input = (mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { your_reference?: string } }).input
    expect(input.your_reference).toBe('Anna Andersson')
    // The order row itself never receives the contact.
    const linkUpdate = findCall('webshop_orders', 'update')![0] as Record<string, unknown>
    expect(Object.keys(linkUpdate)).toEqual(['invoice_id'])
  })

  it('creates a private customer from a name alone, without an email lookup', async () => {
    enqueue({ data: shopifyRow() }) // order fetch
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Anna Andersson', customer_type: 'individual', default_payment_terms: 30 } }) // customer insert
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(
      await postCreate({ customer: { name: 'Anna Andersson', company: '', email: '' } }),
    )

    expect(status).toBe(200)
    expect(findCall('customers', 'ilike')).toBeUndefined()
    expect(findCall('customers', 'insert')![0]).toMatchObject({
      name: 'Anna Andersson',
      contact_person: null,
      email: null,
      customer_type: 'individual',
    })
  })

  it('reuses an existing customer with the confirmed email instead of creating one', async () => {
    enqueue({ data: shopifyRow() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Kund AB', email: 'kund@example.se', customer_type: 'eu_business', default_payment_terms: 30 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(
      await postCreate({ customer: { name: 'Anna Andersson', email: 'kund@example.se' } }),
    )

    expect(status).toBe(200)
    expect(findCall('customers', 'insert')).toBeUndefined()
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ customer: expect.objectContaining({ id: 'cust-1' }) }),
    )
  })

  it('ignores the confirmed customer when a customer_id is chosen', async () => {
    const chosenId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    enqueue({ data: shopifyRow() }) // order fetch
    enqueue({ data: { id: chosenId, name: 'Befintlig kund', customer_type: 'individual', default_payment_terms: 30 } }) // customer by id
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(
      await postCreate({
        customer_id: chosenId,
        customer: { name: 'Anna Andersson', email: 'kund@example.se' },
      }),
    )

    expect(status).toBe(200)
    expect(findCall('customers', 'eq')).toEqual(['id', chosenId])
    expect(findCall('customers', 'ilike')).toBeUndefined()
    expect(findCall('customers', 'insert')).toBeUndefined()
    const input = (mockBuildInvoiceWriteData.mock.calls[0][0] as { input: { your_reference?: string } }).input
    expect(input.your_reference).toBeUndefined()
  })
})

/**
 * The customer is matched by email with a case-insensitive EXACT match. ILIKE
 * reads `_` and `%` as wildcards, so an unescaped a_b@x.se matched axb@x.se
 * and put one buyer's order on another person's customer.
 */
describe('POST /api/webshop-orders/[id]/create-invoice: the email match is exact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  function enqueueCreatedCustomerAndInvoice(email: string) {
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: 'swedish_business', email, default_payment_terms: 30 } }) // customer insert
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched
  }

  it('escapes the underscore in an email confirmed in the dialog', async () => {
    enqueue({
      data: makeOrderRow({
        platform: 'shopify',
        customer_name: null,
        customer_company: null,
        customer_email: null,
        customer_orgnr: null,
      }),
    }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueueCreatedCustomerAndInvoice('anna_b@example.se')

    const { status } = await parseJsonResponse(
      await postCreate({ customer: { name: 'Anna Andersson', email: 'anna_b@example.se' } }),
    )

    expect(status).toBe(200)
    expect(findCall('customers', 'ilike')).toEqual(['email', 'anna\\_b@example.se'])
    expect(findCall('customers', 'insert')![0]).toMatchObject({ email: 'anna_b@example.se' })
  })

  it("escapes `%`, `_` and `\\` in the order row's billing email", async () => {
    enqueue({ data: makeOrderRow({ customer_email: 'kund_50%\\x@example.se' }) }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueueCreatedCustomerAndInvoice('kund_50%\\x@example.se')

    const { status } = await parseJsonResponse(await postCreate())

    expect(status).toBe(200)
    expect(findCall('customers', 'ilike')).toEqual(['email', 'kund\\_50\\%\\\\x@example.se'])
  })

  it('never invoices a customer whose email only matched a wildcard', async () => {
    // PostgREST reads `*` as `%` and it cannot be escaped, so the query can
    // still return another customer; the route checks the email itself.
    enqueue({ data: makeOrderRow({ customer_email: 'a*b@example.se' }) }) // order fetch
    enqueue({ data: { id: 'cust-other', name: 'Annan kund', email: 'axyzb@example.se', default_payment_terms: 30 } }) // wildcard hit
    enqueueCreatedCustomerAndInvoice('a*b@example.se')

    const { status } = await parseJsonResponse(await postCreate())

    expect(status).toBe(200)
    expect(findCall('customers', 'insert')![0]).toMatchObject({ email: 'a*b@example.se' })
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ customer: expect.objectContaining({ id: 'cust-new' }) }),
    )
  })

  it('still reuses an existing customer whose email differs only in case', async () => {
    enqueue({ data: makeOrderRow({ customer_email: 'kund@example.se' }) }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'Kund@Example.SE', default_payment_terms: 30 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } })
    enqueue({ data: null }) // items
    enqueue({ data: [{ id: 'order-1' }] }) // link-back matched

    const { status } = await parseJsonResponse(await postCreate())

    expect(status).toBe(200)
    expect(findCall('customers', 'insert')).toBeUndefined()
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ customer: expect.objectContaining({ id: 'cust-1' }) }),
    )
  })
})

/**
 * The billing address the store sent with a WooCommerce order goes onto the
 * customer the route creates, so the draft invoice is addressed without the
 * user typing it in. A customer matched by email or chosen in the dialog
 * keeps its own card: the route never writes to it.
 */
describe('POST /api/webshop-orders/[id]/create-invoice: the billing address', () => {
  const CHOSEN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const addressedRow = () =>
    makeOrderRow({
      platform: 'woocommerce',
      customer_address_line1: 'Storgatan 1',
      customer_address_line2: 'Lgh 1102',
      customer_postal_code: '111 22',
      customer_city: 'Stockholm',
    })
  const cardWithAddress = {
    name: 'Testbolaget AB',
    email: 'kund@example.se',
    customer_type: 'swedish_business',
    address_line1: 'Gamla vägen 5',
    address_line2: null,
    postal_code: '222 33',
    city: 'Lund',
    default_payment_terms: 30,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
  })

  function enqueueInvoiceWrites() {
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched
  }

  it('puts it on a customer the route creates', async () => {
    enqueue({ data: addressedRow() }) // order fetch
    enqueue({ data: null }) // email match: none
    enqueue({ data: null }) // the company default for the new card
    enqueue({ data: { id: 'cust-new', name: 'Testbolaget AB', customer_type: 'swedish_business', default_payment_terms: 30 } }) // customers insert
    enqueueInvoiceWrites()

    expect((await parseJsonResponse(await postCreate())).status).toBe(200)
    expect(findCall('customers', 'insert')![0]).toMatchObject({
      name: 'Testbolaget AB',
      address_line1: 'Storgatan 1',
      address_line2: 'Lgh 1102',
      postal_code: '111 22',
      city: 'Stockholm',
    })
  })

  it('leaves a customer matched by email as it is', async () => {
    enqueue({ data: addressedRow() }) // order fetch
    enqueue({ data: { id: 'cust-1', ...cardWithAddress } }) // email match
    enqueueInvoiceWrites()

    expect((await parseJsonResponse(await postCreate())).status).toBe(200)
    expect(findCall('customers', 'insert')).toBeUndefined()
    expect(findCall('customers', 'update')).toBeUndefined()
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: expect.objectContaining({ id: 'cust-1', address_line1: 'Gamla vägen 5', city: 'Lund' }),
      }),
    )
  })

  it('leaves a customer chosen in the dialog as it is', async () => {
    enqueue({ data: addressedRow() }) // order fetch
    enqueue({ data: { id: CHOSEN_ID, ...cardWithAddress } }) // customer by id
    enqueueInvoiceWrites()

    expect((await parseJsonResponse(await postCreate({ customer_id: CHOSEN_ID }))).status).toBe(200)
    expect(findCall('customers', 'insert')).toBeUndefined()
    expect(findCall('customers', 'update')).toBeUndefined()
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: expect.objectContaining({ id: CHOSEN_ID, address_line1: 'Gamla vägen 5', city: 'Lund' }),
      }),
    )
  })
})

/**
 * Skapa kontantfaktura (crm#2322): the draft for a cash invoice is dated the
 * day the order was paid, the day Bokför books the same order, so the sale
 * and its VAT land on the day the customer paid (founder decision
 * 2026-11-27). Only a paid order gets one.
 */
describe('POST /api/webshop-orders/[id]/create-invoice: a kontantfaktura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'test@test.se' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockBuildInvoiceWriteData.mockResolvedValue(okBuild)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const paidOrder = () =>
    makeOrderRow({ is_paid: true, order_date: '2026-11-19', paid_date: '2026-11-20', payment_method: 'klarna' })

  it('dates the draft the day the order was paid, not today', async () => {
    enqueue({ data: paidOrder() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', default_payment_terms: 30 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    const { status, body } = await parseJsonResponse<{ invoice_id: string }>(await postCreate({ paid_at_issue: true }))

    expect(status).toBe(200)
    expect(body.invoice_id).toBe('inv-1')
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invoice_date: '2026-11-20' }) }),
    )
  })

  it('keeps today for a plain Skapa faktura on the same order', async () => {
    enqueue({ data: paidOrder() }) // order fetch
    enqueue({ data: { id: 'cust-1', name: 'Testbolaget AB', email: 'kund@example.se', customer_type: 'swedish_business', default_payment_terms: 30 } }) // email match
    enqueue({ data: { id: 'inv-1', status: 'draft', invoice_number: null } }) // invoices insert
    enqueue({ data: null }) // invoice_items insert
    enqueue({ data: [{ id: 'order-1' }] }) // order link-back matched

    const { status } = await parseJsonResponse(await postCreate())

    expect(status).toBe(200)
    expect(mockBuildInvoiceWriteData).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invoice_date: '2026-11-27' }) }),
    )
  })

  it('refuses an unpaid order with 409 WEBSHOP_ORDER_NOT_PAID before any customer or invoice is written', async () => {
    enqueue({ data: makeOrderRow({ is_paid: false }) }) // order fetch

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await postCreate({ paid_at_issue: true }))

    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_PAID')
    expect(findCall('invoices', 'insert')).toBeUndefined()
    expect(findCall('customers', 'insert')).toBeUndefined()
  })

  it('returns 400 for a paid_at_issue that is not a boolean', async () => {
    const { status } = await parseJsonResponse(await postCreate({ paid_at_issue: 'yes' }))

    expect(status).toBe(400)
    expect(findCall('webshop_orders', 'select')).toBeUndefined()
  })
})
