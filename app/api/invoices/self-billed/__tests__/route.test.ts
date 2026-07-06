import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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
vi.mock('@/lib/invoices/vat-rules', () => ({
  getVatRules: (...args: unknown[]) => mockGetVatRules(...args),
  getAvailableVatRates: (...args: unknown[]) => mockGetAvailableVatRates(...args),
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
  convertToSEK: vi.fn(),
}))

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) => mockCreateInvoiceJournalEntry(...args),
}))

import { POST } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const mockUser = { id: 'user-1', email: 'test@test.se' }

const validBody = {
  customer_id: VALID_UUID,
  external_invoice_number: 'KUND-55012',
  self_billing_agreement_ref: 'Avtal 2026-01',
  invoice_date: '2026-06-01',
  received_date: '2026-06-02',
  due_date: '2026-06-30',
  currency: 'SEK',
  items: [{ description: 'Konsulttjänst', quantity: 10, unit: 'tim', unit_price: 1000 }],
}

function mockDomesticVat() {
  mockGetVatRules.mockReturnValue({
    treatment: 'standard_25',
    rate: 25,
    momsRuta: '05',
    reverseChargeText: null,
  })
  mockGetAvailableVatRates.mockReturnValue([
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
    { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
  ])
}

describe('POST /api/invoices/self-billed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: validBody })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 400 when external_invoice_number is missing', async () => {
    const { external_invoice_number, ...rest } = validBody
    void external_invoice_number

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: rest })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ type: string }>(response)

    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
  })

  it('returns 404 when the customer (issuer) is not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: validBody })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('rejects an item VAT rate the customer is not allowed to use', async () => {
    mockGetVatRules.mockReturnValue({ treatment: 'standard_25', rate: 25, momsRuta: '05', reverseChargeText: null })
    // Domestic-only set: 0% is NOT allowed for this customer.
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
    ])
    enqueue({ data: makeCustomer({ id: VALID_UUID }), error: null })

    const request = createMockRequest('/api/invoices/self-billed', {
      method: 'POST',
      body: { ...validBody, items: [{ description: 'X', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 0 }] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
  })

  it('creates a self-billed sale, books it (accrual), skips own numbering, and emits invoice.created', async () => {
    mockDomesticVat()
    const customer = makeCustomer({ id: VALID_UUID, name: 'Stora Bolaget AB' })
    const created = makeInvoice({
      id: 'inv-1',
      invoice_number: null,
      is_self_billed: true,
      external_invoice_number: 'KUND-55012',
      total: 12500,
    })

    enqueue({ data: customer, error: null })                                   // fetch customer
    enqueue({ data: created, error: null })                                    // insert invoice
    enqueue({ data: null, error: null })                                       // insert items
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { ...created, customer, items: [] }, error: null })        // fetch complete
    enqueue({ data: null, error: null })                                       // update journal_entry_id
    enqueue({ data: { ...created, customer, items: [], journal_entry_id: 'je-1' }, error: null }) // fetch final

    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: validBody })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()

    // Booked as a sale with the self-billing label + the counterparty's number.
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledTimes(1)
    const opts = mockCreateInvoiceJournalEntry.mock.calls[0][6]
    expect(opts).toEqual({ descriptionPrefix: 'Självfaktura', numberOverride: 'KUND-55012' })

    // Never consumes our own invoice-number series.
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.created' }))
  })

  it('does NOT book at registration under kontantmetoden (cash), books at payment instead', async () => {
    mockDomesticVat()
    const customer = makeCustomer({ id: VALID_UUID })
    const created = makeInvoice({ id: 'inv-1', invoice_number: null, is_self_billed: true, external_invoice_number: 'KUND-55012' })

    enqueue({ data: customer, error: null })                                   // fetch customer
    enqueue({ data: created, error: null })                                    // insert invoice
    enqueue({ data: null, error: null })                                       // insert items
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null }) // settings
    enqueue({ data: { ...created, customer, items: [] }, error: null })        // fetch complete
    enqueue({ data: { ...created, customer, items: [] }, error: null })        // fetch final

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: validBody })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rolls back when there is no open fiscal period for the invoice date', async () => {
    mockDomesticVat()
    const customer = makeCustomer({ id: VALID_UUID })
    const created = makeInvoice({ id: 'inv-1', invoice_number: null, is_self_billed: true, external_invoice_number: 'KUND-55012' })

    enqueue({ data: customer, error: null })                                   // fetch customer
    enqueue({ data: created, error: null })                                    // insert invoice
    enqueue({ data: null, error: null })                                       // insert items
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null }) // settings
    enqueue({ data: { ...created, customer, items: [] }, error: null })        // fetch complete
    enqueue({ data: null, error: null })                                       // rollback delete

    mockCreateInvoiceJournalEntry.mockResolvedValue(null) // no fiscal period

    const request = createMockRequest('/api/invoices/self-billed', { method: 'POST', body: validBody })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockSupabase.from).toHaveBeenCalledWith('invoices')
  })

  it('rejects a foreign-currency self-billed invoice when no FX rate is available', async () => {
    mockDomesticVat()
    // fetchExchangeRate is mocked to resolve null (rate unavailable for the
    // invoice date). Booking would otherwise fall through to a silent 1:1 SEK
    // conversion, so the route must refuse up front, before any insert.
    enqueue({ data: makeCustomer({ id: VALID_UUID }), error: null }) // fetch customer

    const request = createMockRequest('/api/invoices/self-billed', {
      method: 'POST',
      body: { ...validBody, currency: 'EUR' },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ type: string; error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toMatch(/växelkurs/i)
    // Never books a wrong-magnitude verifikat and never inserts the invoice.
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })
})
