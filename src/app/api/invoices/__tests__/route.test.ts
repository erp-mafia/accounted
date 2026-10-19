import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { createMockRouteParams } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockGetVatRules = vi.fn()
const mockGetAvailableVatRates = vi.fn()
vi.mock('@/lib/invoices/vat-rules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/invoices/vat-rules')>('@/lib/invoices/vat-rules')
  return {
    getVatRules: (...args: unknown[]) => mockGetVatRules(...args),
    deriveInvoiceVatHeader: actual.deriveInvoiceVatHeader,
    getAvailableVatRates: (...args: unknown[]) => mockGetAvailableVatRates(...args),
    // The builder gates on the permitted set (taxed-where-performed exceptions);
    // these route tests only care that the gate reads the stubbed rates.
    getPermittedVatRates: (...args: unknown[]) => mockGetAvailableVatRates(...args),
    // The builder's one rule entry (#2906): the customer path reads the
    // stubs above; an invoice that states its own treatment uses the real one.
    resolveInvoiceVatRules: (
      customer: { customer_type: string; vat_number_validated?: boolean | null; country?: string | null },
      override?: { vat_treatment: string | null; delivery_country: string | null } | null,
    ) =>
      override?.vat_treatment || override?.delivery_country
        ? actual.resolveInvoiceVatRules(customer as Parameters<typeof actual.resolveInvoiceVatRules>[0], override as Parameters<typeof actual.resolveInvoiceVatRules>[1])
        : {
            ok: true,
            rules: mockGetVatRules(customer.customer_type, customer.vat_number_validated, customer.country),
            permittedRates: mockGetAvailableVatRates(customer.customer_type, customer.vat_number_validated, customer.country),
            explainFromCustomer: true,
          },
    // Real: the warnings channel is what the response-shape test below pins.
    explainVatTreatment: actual.explainVatTreatment,
  }
})

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
  convertToSEK: vi.fn(),
}))

import { GET, POST } from '../route'

describe('GET /api/invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns invoices list', async () => {
    const invoices = [makeInvoice(), makeInvoice()]
    enqueue({ data: invoices, error: null, count: 2 })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
    expect(body.count).toBe(2)
  })

  it('masks the embedded customer personnummer in the list', async () => {
    // The customer:customers(*) join carries the stored personal_number out to
    // the browser. A legacy plaintext value is used here so the assertion does
    // not depend on PERSONNUMMER_ENCRYPTION_KEY being set in the test env; the
    // ciphertext path lands on the same masked shape.
    const invoices = [
      { ...makeInvoice(), customer: { id: 'cust-1', name: 'Test', personal_number: '19900101-1234' } },
    ]
    enqueue({ data: invoices, error: null, count: 1 })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: { customer: { personal_number: string | null; name: string } }[]
    }>(response)

    expect(status).toBe(200)
    expect(body.data[0].customer.personal_number).toBe('********-1234')
    expect(JSON.stringify(body)).not.toContain('19900101-1234')
    // Masking must not strip the rest of the embed.
    expect(body.data[0].customer.name).toBe('Test')
  })

  it('leaves an invoice without an embedded customer untouched', async () => {
    // PostgREST returns customer: null when the customer was removed; the mask
    // must be null-safe rather than 500 the whole list.
    const invoices = [{ ...makeInvoice(), customer: null }]
    enqueue({ data: invoices, error: null, count: 1 })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: { customer: null }[] }>(response)

    expect(status).toBe(200)
    expect(body.data[0].customer).toBeNull()
  })

  it('reports invoice-register coverage alongside the list', async () => {
    // List, then the coverage helper's two lookups: earliest register
    // invoice + a posted AR verifikat predating it (migrated/backfilled
    // invoice history living only as journal entries).
    enqueue({ data: [makeInvoice()], error: null, count: 1 })
    enqueue({ data: { invoice_date: '2026-07-19' }, error: null })
    enqueue({ data: { id: 'line-1' }, error: null })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      invoice_register_coverage: { covers_from: string | null; has_pre_register_invoices: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.invoice_register_coverage).toEqual({
      covers_from: '2026-07-19',
      has_pre_register_invoices: true,
    })
  })

  it('degrades to no coverage instead of failing the list', async () => {
    enqueue({ data: [makeInvoice()], error: null, count: 1 })
    // Coverage lookups resolve to nothing (empty queue → null data).

    const request = createMockRequest('/api/invoices')
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      invoice_register_coverage: { covers_from: string | null; has_pre_register_invoices: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.invoice_register_coverage).toEqual({
      covers_from: null,
      has_pre_register_invoices: false,
    })
  })

  it('applies status filter', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/invoices', {
      searchParams: { status: 'sent' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('invoices')
  })

  it('applies pagination', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/invoices', {
      searchParams: { limit: '10', offset: '20' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    // GET passes through errorResponse which maps unknown DB errors to INTERNAL_ERROR
    expect((body.error as unknown as { code: string }).code).toBe('INTERNAL_ERROR')
  })
})

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'

const mockResolveInvoicePayeeChoice = vi.hoisted(() => vi.fn())
vi.mock('@/lib/invoices/invoice-payee', () => ({
  resolveInvoicePayeeChoice: (...args: unknown[]) => mockResolveInvoicePayeeChoice(...args),
  snapshotInvoicePayee: vi.fn().mockResolvedValue({ ok: true, payee: null }),
}))

describe('POST /api/invoices (create invoice)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockResolveInvoicePayeeChoice.mockResolvedValue({
      ok: true,
      fields: { payment_cash_account_id: null, payment_details: null },
    })
  })

  it('returns 400 when the chosen payee account is not usable for the invoice', async () => {
    enqueue({ data: makeCustomer({ id: VALID_UUID }) })
    mockResolveInvoicePayeeChoice.mockResolvedValue({
      ok: false,
      code: 'INVOICE_PAYEE_ACCOUNT_INVALID',
      details: { cash_account_id: VALID_UUID_2, currency: 'SEK', reason: 'not_payee' },
    })
    mockGetVatRules.mockReturnValue({ treatment: 'standard_25', rate: 25, momsRuta: '10', reverseChargeText: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        payment_cash_account_id: VALID_UUID_2,
        items: [{ description: 'Test', quantity: 1, unit: 'st', unit_price: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAYEE_ACCOUNT_INVALID')
    expect(mockResolveInvoicePayeeChoice).toHaveBeenCalledWith(expect.anything(), 'company-1', 'SEK', VALID_UUID_2)
    expect(findCalls('invoices', 'insert')).toHaveLength(0)
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { customer_id: VALID_UUID, items: [] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when customer not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID_2,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Test', quantity: 1, unit: 'st', unit_price: 1000 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('creates invoice with items and emits event', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdInvoice = makeInvoice({ id: 'inv-1', invoice_number: null })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    // Fetch customer
    enqueue({ data: customer, error: null })
    // company_settings.vat_registered gate (registered → VAT flows as before)
    enqueue({ data: { vat_registered: true }, error: null })
    // Insert invoice (number is null on insert; allocated immediately after items)
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // ensureInvoiceNumber → generate_invoice_number RPC
    enqueue({ data: '2026001', error: null })
    // Fetch complete invoice
    enqueue({ data: { ...createdInvoice, invoice_number: '2026001', customer, items: [] }, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    // A domestic customer has nothing to explain: no warnings key at all.
    expect(body).not.toHaveProperty('warnings')
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.created' })
    )
  })

  it('creates the invoice with 25 % for an EU business without a validated VAT number and says why (#2749)', async () => {
    const customer = makeCustomer({
      id: VALID_UUID,
      customer_type: 'eu_business',
      vat_number: 'DE123456789',
      vat_number_validated: false,
      country: 'DE',
    })
    const createdInvoice = makeInvoice({ id: 'inv-1', invoice_number: null })

    mockGetVatRules.mockReturnValue({ treatment: 'standard_25', rate: 25, momsRuta: '05', reverseChargeText: null })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    enqueue({ data: customer, error: null }) // customer
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings
    enqueue({ data: createdInvoice, error: null }) // insert invoice
    enqueue({ data: null, error: null }) // insert items
    enqueue({ data: '2026001', error: null }) // generate_invoice_number
    enqueue({ data: { ...createdInvoice, invoice_number: '2026001', customer, items: [] }, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000 }],
      },
    })
    const response = await POST(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{
      data: unknown
      warnings: Array<{ code: string; message_sv: string; remediation?: { tool?: string } }>
    }>(response)

    // The rule is unchanged (the draft exists, with Swedish VAT); the caller
    // is told which reverse-charge condition failed, and how to fix it.
    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0].code).toBe('EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED')
    expect(body.warnings[0].message_sv).toMatch(/^Omvänd skattskyldighet tillämpas inte: momsnumret är inte validerat/)
    expect(body.warnings[0].remediation?.tool).toBe('gnubok_update_customer')
  })

  it('saves an unnumbered draft without a number or event when save_as_draft is true', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdInvoice = makeInvoice({ id: 'inv-1', invoice_number: null })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    // Fetch customer
    enqueue({ data: customer, error: null })
    // company_settings.vat_registered gate (registered → VAT flows as before)
    enqueue({ data: { vat_registered: true }, error: null })
    // Insert invoice (stays unnumbered: the allocation step is skipped)
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch complete invoice (still unnumbered; no generate_invoice_number RPC)
    enqueue({ data: { ...createdInvoice, invoice_number: null, customer, items: [] }, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        save_as_draft: true,
        items: [{ description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { invoice_number: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.invoice_number).toBeNull()
    expect(emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.created' })
    )
  })

  it('rolls back invoice when items insertion fails', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdInvoice = makeInvoice({ id: 'inv-1' })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    enqueue({ data: customer, error: null })
    // company_settings.vat_registered gate (registered → VAT flows as before)
    enqueue({ data: { vat_registered: true }, error: null })
    enqueue({ data: createdInvoice, error: null })
    // Items insertion fails
    enqueue({ data: null, error: { message: 'Items insert failed' } })
    // Rollback delete
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Test', quantity: 1, unit: 'st', unit_price: 1000 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREATE_ITEMS_FAILED')
  })

  it('soft-cancels the invoice when invoice-number allocation fails', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdInvoice = makeInvoice({ id: 'inv-1', invoice_number: null })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    enqueue({ data: customer, error: null })
    // company_settings.vat_registered gate (registered → VAT flows as before)
    enqueue({ data: { vat_registered: true }, error: null })
    enqueue({ data: createdInvoice, error: null })
    // Items insertion succeeds
    enqueue({ data: null, error: null })
    // generate_invoice_number RPC fails
    enqueue({ data: null, error: { message: 'sequence locked' } })
    // Rollback path: re-fetch invoice_number, then soft-cancel.
    enqueue({ data: { invoice_number: null }, error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Test', quantity: 1, unit: 'st', unit_price: 1000 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
  })

  it('removes the unnumbered row when the series already has a higher number: nothing was used up', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdInvoice = makeInvoice({ id: 'inv-1', invoice_number: null })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([{ rate: 25, label: '25%', treatment: 'standard_25' }])

    enqueue({ data: customer, error: null })
    enqueue({ data: { vat_registered: true }, error: null })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null }) // items
    enqueue({
      data: null,
      error: {
        code: 'PT409',
        message: 'INVOICE_NUMBER_SERIES_BEHIND',
        details: JSON.stringify({ prefix: '', next_invoice_number: 1, highest_number: 114647, first_allowed: 114648 }),
      },
    })
    enqueue({ data: null, error: null }) // delete of the unnumbered draft

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        currency: 'SEK',
        items: [{ description: 'Test', quantity: 1, unit: 'st', unit_price: 1000 }],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: Record<string, unknown> }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(body.error.message).toContain('114648 eller högre')
    expect(body.error.details).toEqual({ prefix: '', highest_number: 114647, first_allowed: 114648 })
    const removal = findCall('invoices', 'delete')
    expect(removal).toBeDefined()
    // Never a soft-cancelled leftover: the row had no number to keep.
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  // GitLab accounted #33: the delivery-note branch ignored the RPC error and
  // inserted a note with a null number.
  describe('delivery note numbering (#33)', () => {
    function deliveryNoteRequest() {
      return createMockRequest('/api/invoices', {
        method: 'POST',
        body: {
          customer_id: VALID_UUID,
          invoice_date: '2024-06-15',
          due_date: '2024-07-15',
          document_type: 'delivery_note',
          currency: 'SEK',
          items: [{ description: 'Leverans', quantity: 2, unit: 'st', unit_price: 500 }],
        },
      })
    }

    beforeEach(() => {
      mockGetVatRules.mockReturnValue({
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '10',
        reverseChargeText: null,
      })
      mockGetAvailableVatRates.mockReturnValue([
        { rate: 25, label: '25%', treatment: 'standard_25' },
      ])
    })

    it('numbers the note from the FS-series at insert', async () => {
      const customer = makeCustomer({ id: VALID_UUID })
      const createdNote = makeInvoice({
        id: 'dn-1',
        invoice_number: 'FS-20241000',
        document_type: 'delivery_note',
      })
      // Fetch customer
      enqueue({ data: customer, error: null })
      // company_settings.vat_registered gate
      enqueue({ data: { vat_registered: true }, error: null })
      // generate_delivery_note_number RPC
      enqueue({ data: 'FS-20241000', error: null })
      // Insert note
      enqueue({ data: createdNote, error: null })
      // Insert items
      enqueue({ data: null, error: null })
      // Fetch complete note
      enqueue({ data: { ...createdNote, customer, items: [] }, error: null })

      const response = await POST(deliveryNoteRequest(), { params: Promise.resolve({}) })
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      expect(mockSupabase.rpc).toHaveBeenCalledWith('generate_delivery_note_number', { p_company_id: 'company-1' })
      const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
      expect(inserted.invoice_number).toBe('FS-20241000')
      expect(inserted.document_type).toBe('delivery_note')
    })

    it('returns 500 and inserts nothing when the number cannot be allocated', async () => {
      const customer = makeCustomer({ id: VALID_UUID })
      enqueue({ data: customer, error: null })
      enqueue({ data: { vat_registered: true }, error: null })
      // generate_delivery_note_number RPC fails
      enqueue({ data: null, error: { message: 'Company settings not found', code: 'P0001' } })

      const response = await POST(deliveryNoteRequest(), { params: Promise.resolve({}) })
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(500)
      expect(body.error.code).toBe('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
      expect(findCall('invoices', 'insert')).toBeUndefined()
    })
  })
})

describe('POST /api/invoices (create credit note)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 404 when original invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID_2 },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_ORIGINAL_NOT_FOUND')
  })

  it('returns 400 when invoice is already credited', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'credited' })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_ALREADY_CREDITED')
  })

  it('returns 400 when invoice is in draft status', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'draft' })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NOT_SENT')
  })

  it('returns 400 when invoice is cancelled', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'cancelled' })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NOT_SENT')
  })

  // A credit note is document_type 'invoice' too: crediting it would post a
  // second reversal of the same sale. Every credit door refuses it
  // (creditNoteRefusal, lib/invoices/credit-invoice.ts).
  it('returns 400 INVOICE_CREDIT_NOT_INVOICE for a credit note', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'sent', credited_invoice_id: VALID_UUID_2 })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NOT_INVOICE')
  })

  // accounted#58: imported at a system change, a credit note often has no
  // credited_invoice_id and, from older imports, status 'paid'.
  it('returns 400 INVOICE_CREDIT_NOT_INVOICE for an imported credit note with no link to its original', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'paid', subtotal: -1000, vat_amount: -250, total: -1250, credited_invoice_id: null })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NOT_INVOICE')
  })

  // Documents a KNOWN GAP, not a rule. ML (2023:200) 17 kap 22-23 SS permits an
  // aendringsfaktura against a part-paid invoice; the app refuses it because
  // issueCreditNote() cannot flip a 'partially_paid' original to 'credited' and
  // would strand a posted reversing verifikat (see the comment on the guard in
  // lib/invoices/credit-invoice.ts and the DECISIONS.md entry). This test exists so lifting the gap
  // fails here and forces the coordinated change rather than passing silently.
  it('refuses a partially paid invoice (known gap: needs issue-credit-note.ts too)', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'partially_paid' })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NOT_SENT')
  })

  it('creates a credit note draft without booking or crediting the original', async () => {
    const items = [
      {
        id: 'item-1',
        invoice_id: 'inv-1',
        sort_order: 0,
        description: 'Consulting',
        quantity: 10,
        unit: 'tim',
        unit_price: 1000,
        line_total: 10000,
        vat_rate: 25,
        vat_amount: 2500,
        created_at: '2024-06-15T14:30:00Z',
      },
    ]
    const original = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      items,
    })
    const creditNote = makeInvoice({
      id: 'cn-1',
      credited_invoice_id: VALID_UUID,
      subtotal: -10000,
      vat_amount: -2500,
      total: -12500,
      status: 'draft',
    })

    // Fetch original invoice
    enqueue({ data: original, error: null })
    // No existing credit-note draft
    enqueue({ data: null, error: null })
    // Insert credit note
    enqueue({ data: creditNote, error: null })
    // Insert credit note items
    enqueue({ data: null, error: null })
    // Mark creation complete
    enqueue({ data: null, error: null })
    // Fetch complete credit note
    enqueue({ data: { ...creditNote, items: [] }, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('draft')
    expect(emitSpy).not.toHaveBeenCalled()
    expect(mockSupabase.from).toHaveBeenCalledTimes(6)
  })

  // Regression: crediting a ROT/RUT invoice used to negate deduction_total and
  // deduction_amount like the other amounts, which the DB refuses (both columns
  // carry CHECK >= 0), so no deduction-carrying invoice could be credited. The
  // stored deduction fields are positive magnitudes on credit notes too.
  it('keeps deduction fields positive when crediting a ROT invoice', async () => {
    const original = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      subtotal: 60000,
      vat_amount: 15000,
      total: 75000,
      deduction_total: 22500,
      items: [
        {
          id: 'item-1',
          invoice_id: VALID_UUID,
          sort_order: 0,
          description: 'Snickeri',
          quantity: 30,
          unit: 'tim',
          unit_price: 2000,
          line_total: 60000,
          vat_rate: 25,
          vat_amount: 15000,
          deduction_type: 'rot',
          deduction_amount: 22500,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    })
    const creditNote = makeInvoice({
      id: 'cn-rot',
      credited_invoice_id: VALID_UUID,
      status: 'draft',
    })

    // Fetch original invoice
    enqueue({ data: original, error: null })
    // No existing credit-note draft
    enqueue({ data: null, error: null })
    // Insert credit note
    enqueue({ data: creditNote, error: null })
    // Insert credit note items
    enqueue({ data: null, error: null })
    // Mark creation complete
    enqueue({ data: null, error: null })
    // Fetch complete credit note
    enqueue({ data: { ...creditNote, items: [] }, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const [invoiceInsert] = findCall('invoices', 'insert') ?? []
    expect(invoiceInsert).toMatchObject({
      total: -75000,
      subtotal: -60000,
      vat_amount: -15000,
      deduction_total: 22500,
    })
    const [itemsInsert] = findCall('invoice_items', 'insert') ?? []
    expect(itemsInsert).toMatchObject([
      {
        line_total: -60000,
        vat_amount: -15000,
        deduction_type: 'rot',
        deduction_amount: 22500,
      },
    ])
  })

  // Regression for issue #1820: a self-billed original has invoice_number
  // null by design (its number lives in external_invoice_number), and the
  // credit note used to be numbered the literal string 'KR-null' with notes
  // saying 'Krediterar faktura null'.
  it('numbers the credit note from the external number for a self-billed original', async () => {
    const original = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      invoice_number: null as unknown as string,
      external_invoice_number: 'SB-2026-17',
      is_self_billed: true,
      items: [
        {
          id: 'item-1',
          invoice_id: VALID_UUID,
          sort_order: 0,
          description: 'Provision',
          quantity: 1,
          unit: 'st',
          unit_price: 10000,
          line_total: 10000,
          vat_rate: 25,
          vat_amount: 2500,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    })
    const creditNote = makeInvoice({
      id: 'cn-sb',
      credited_invoice_id: VALID_UUID,
      status: 'draft',
    })

    // Fetch original invoice
    enqueue({ data: original, error: null })
    // No existing credit-note draft
    enqueue({ data: null, error: null })
    // Insert credit note
    enqueue({ data: creditNote, error: null })
    // Insert credit note items
    enqueue({ data: null, error: null })
    // Mark creation complete
    enqueue({ data: null, error: null })
    // Fetch complete credit note
    enqueue({ data: { ...creditNote, items: [] }, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const [invoiceInsert] = findCall('invoices', 'insert') ?? []
    expect(invoiceInsert).toMatchObject({
      invoice_number: 'KR-SB-2026-17',
      notes: 'Krediterar faktura SB-2026-17',
    })
    expect((invoiceInsert as { invoice_number: string }).invoice_number).not.toContain('null')
    expect((invoiceInsert as { notes: string }).notes).not.toContain('null')
  })

  // Defensive path: both numbers null cannot happen for an issued invoice
  // (DB constraint), but a garbage 'KR-null' must never be minted.
  it('returns a typed 400 when the original carries no number at all', async () => {
    const original = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      invoice_number: null as unknown as string,
    })
    enqueue({ data: original, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREDIT_NO_NUMBER')
  })

  it('returns an existing credit-note draft instead of creating a duplicate', async () => {
    const original = makeInvoice({ id: VALID_UUID, status: 'sent' })
    const existing = makeInvoice({
      id: 'credit-existing',
      invoice_number: 'KR-F-2024001',
      status: 'draft',
      credited_invoice_id: VALID_UUID,
    })
    enqueue({ data: original, error: null })
    enqueue({ data: existing, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('credit-existing')
    expect(mockSupabase.from).toHaveBeenCalledTimes(2)
  })

  it('rolls back credit note when items insertion fails', async () => {
    const original = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      items: [
        {
          id: 'item-1',
          invoice_id: 'inv-1',
          sort_order: 0,
          description: 'Test',
          quantity: 1,
          unit: 'st',
          unit_price: 1000,
          line_total: 1000,
          vat_rate: 25,
          vat_amount: 250,
          created_at: '2024-06-15T14:30:00Z',
        },
      ],
    })
    const creditNote = makeInvoice({ id: 'cn-1' })

    enqueue({ data: original, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: creditNote, error: null })
    // Items fail
    enqueue({ data: null, error: { message: 'Items insert failed' } })
    // Rollback delete
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_CREATE_ITEMS_FAILED')
  })

  it('numbers a quote from the OF-series at insert and never touches the F-series or the event bus', async () => {
    const customer = makeCustomer({ id: VALID_UUID })
    const createdQuote = makeInvoice({
      id: 'q-1',
      invoice_number: 'OF-001',
      document_type: 'quote',
      valid_until: '2024-07-15',
      quote_status: 'open',
    })

    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '10',
      reverseChargeText: null,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    // Fetch customer
    enqueue({ data: customer, error: null })
    // company_settings.vat_registered gate
    enqueue({ data: { vat_registered: true }, error: null })
    // generate_quote_number RPC (numbered BEFORE insert, like delivery notes)
    enqueue({ data: 'OF-001', error: null })
    // Insert quote
    enqueue({ data: createdQuote, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch complete quote (no generate_invoice_number call in between)
    enqueue({ data: { ...createdQuote, customer, items: [] }, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        valid_until: '2024-07-15',
        document_type: 'quote',
        currency: 'SEK',
        items: [{ description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000 }],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { invoice_number: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.invoice_number).toBe('OF-001')
    expect(mockSupabase.rpc).toHaveBeenCalledWith('generate_quote_number', { p_company_id: 'company-1' })
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
    const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.invoice_number).toBe('OF-001')
    expect(inserted.document_type).toBe('quote')
    expect(inserted.valid_until).toBe('2024-07-15')
    // The decision column is set by the DB trigger, never by a writer.
    expect(inserted).not.toHaveProperty('quote_status')
    expect(inserted.remaining_amount).toBe(0)
    expect(emitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.created' }))
  })

  it('rejects a quote without valid_until', async () => {
    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: {
        customer_id: VALID_UUID,
        invoice_date: '2024-06-15',
        due_date: '2024-07-15',
        document_type: 'quote',
        currency: 'SEK',
        items: [{ description: 'Consulting', quantity: 1, unit: 'st', unit_price: 100 }],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ errors: Array<{ field: string }> }>(response)

    expect(status).toBe(400)
    expect(body.errors.map((e) => e.field)).toContain('valid_until')
  })
})
