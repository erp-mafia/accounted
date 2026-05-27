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
const mockCalculateVat = vi.fn()
const mockGetAvailableVatRates = vi.fn()
vi.mock('@/lib/invoices/vat-rules', () => ({
  getVatRules: (...args: unknown[]) => mockGetVatRules(...args),
  calculateVat: (...args: unknown[]) => mockCalculateVat(...args),
  getAvailableVatRates: (...args: unknown[]) => mockGetAvailableVatRates(...args),
  calculateTotal: vi.fn(),
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
  convertToSEK: vi.fn(),
}))

const mockCreateCreditNoteJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createCreditNoteJournalEntry: (...args: unknown[]) =>
    mockCreateCreditNoteJournalEntry(...args),
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

describe('POST /api/invoices (create invoice)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
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
    mockCalculateVat.mockReturnValue(2500)
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    // Fetch customer
    enqueue({ data: customer, error: null })
    // Fetch company_settings.vat_registered — feeds the helpers so the
    // allowed-rates set is correct for non-VAT-registered sellers.
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
    expect(emitSpy).toHaveBeenCalledWith(
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
    mockCalculateVat.mockReturnValue(2500)
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    enqueue({ data: customer, error: null })
    // Fetch company_settings.vat_registered
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
    mockCalculateVat.mockReturnValue(2500)
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 12, label: '12%', treatment: 'reduced_12' },
      { rate: 6, label: '6%', treatment: 'reduced_6' },
      { rate: 0, label: '0% (momsfri)', treatment: 'exempt' },
    ])

    enqueue({ data: customer, error: null })
    // Fetch company_settings.vat_registered
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

  it('creates credit note with negated amounts and emits event', async () => {
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
      status: 'sent',
    })

    // Fetch original invoice
    enqueue({ data: original, error: null })
    // Insert credit note
    enqueue({ data: creditNote, error: null })
    // Insert credit note items
    enqueue({ data: null, error: null })
    // Update original status to 'credited'
    enqueue({ data: null, error: null })
    // Fetch complete credit note
    enqueue({ data: { ...creditNote, items: [] }, error: null })
    // Fetch company settings for entity type
    enqueue({ data: { entity_type: 'enskild_firma' }, error: null })

    mockCreateCreditNoteJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Update credit note with journal_entry_id
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices', {
      method: 'POST',
      body: { credited_invoice_id: VALID_UUID },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'credit_note.created' })
    )
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
})
