import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
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

const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

const mockCreateSupplierInvoiceRegistrationEntry = vi.fn()
const mockCreateSupplierInvoicePrivatelyPaidEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoiceRegistrationEntry(...args),
  createSupplierInvoicePrivatelyPaidEntry: (...args: unknown[]) =>
    mockCreateSupplierInvoicePrivatelyPaidEntry(...args),
}))

const mockLinkToJournalEntry = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => mockLinkToJournalEntry(...args),
}))

// Riksbanken is the only external dependency of the new server-side rate
// lookup. Spread the real module so anything else importing from it (e.g.
// convertToSEK) keeps working.
const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args) }
})

import { eventBus } from '@/lib/events'

import { GET, POST } from '../route'

describe('GET /api/supplier-invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns supplier invoices list', async () => {
    const invoices = [makeSupplierInvoice(), makeSupplierInvoice()]
    enqueue({ data: invoices, error: null })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
  })

  it('applies status filter', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'registered' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('supplier_invoices')
  })

  it('handles to_pay virtual status', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'to_pay' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
  })

  it('applies supplier_id filter', async () => {
    const invoices = [makeSupplierInvoice({ supplier_id: 'supplier-1' })]
    enqueue({ data: invoices, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'all', supplier_id: 'supplier-1' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INTERNAL_ERROR')
  })
})

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'
const DOCUMENT_UUID = '550e8400-e29b-41d4-a716-446655440002'

describe('POST /api/supplier-invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: { supplier_id: VALID_UUID, items: [] },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when vat_rate is percent-shaped (25 instead of 0.25, issue #310)', async () => {
    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-PERCENT',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          // Percent-integer shape: used to be accepted and silently booked
          // 2500 % VAT (line_total * 25).
          { description: 'Material', quantity: 1, unit_price: 1000, account_number: '4010', vat_rate: 25 },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      type: string
      errors: Array<{ field: string; message: string }>
    }>(response)

    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(body.errors.some((e) => e.field === 'items.0.vat_rate')).toBe(true)
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('returns 404 when supplier not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID_2,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Material', quantity: 1, unit_price: 8000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('creates supplier invoice with items and arrival number', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    // Fetch supplier
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 5 })
    // Insert invoice
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    // Update invoice with registration_journal_entry_id
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          {
            description: 'Material',
            quantity: 10,
            unit_price: 800,
            account_number: '4010',
            vat_rate: 0.25,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    expect(body.data.registration_journal_entry_id).toBe('je-1')
    expect(mockCreateSupplierInvoiceRegistrationEntry).toHaveBeenCalled()
  })

  it('registers WITHOUT booking when defer_invoice_booking is on (#967)', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-deferred' })

    // Fetch supplier
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 5 })
    // Insert invoice
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch company settings: accrual + deferred booking
    enqueue({ data: { accounting_method: 'accrual', defer_invoice_booking: true }, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-002',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          {
            description: 'Material',
            quantity: 10,
            unit_price: 800,
            account_number: '4010',
            vat_rate: 0.25,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: string | null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toBeTruthy()
    // No registration verifikat: booking is a separate explicit step.
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(body.data.registration_journal_entry_id ?? null).toBeNull()
  })

  it('stores an uploaded document and links it to the registration entry', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-with-document', document_id: DOCUMENT_UUID })

    enqueue({ data: { id: DOCUMENT_UUID, journal_entry_id: null }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 6 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-document' })
    enqueue({ data: null, error: null })
    mockLinkToJournalEntry.mockResolvedValue({ id: DOCUMENT_UUID })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        document_id: DOCUMENT_UUID,
        supplier_invoice_number: 'LF-DOCUMENT',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          { description: 'Service', quantity: 1, unit_price: 1000, account_number: '6200' },
        ],
      },
    })

    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { document_id: string; registration_journal_entry_id: string }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.document_id).toBe(DOCUMENT_UUID)
    expect(body.data.registration_journal_entry_id).toBe('je-document')
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      DOCUMENT_UUID,
      'je-document',
    )
  })

  it('rejects a document that is missing or outside the active company', async () => {
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        document_id: DOCUMENT_UUID,
        supplier_invoice_number: 'LF-INVALID-DOCUMENT',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          { description: 'Service', quantity: 1, unit_price: 1000, account_number: '6200' },
        ],
      },
    })

    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(mockLinkToJournalEntry).not.toHaveBeenCalled()
  })

  it('emits supplier_invoice.registered event', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 5 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          { description: 'Material', quantity: 10, unit_price: 800, account_number: '4010', vat_rate: 0.25 },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.registered',
        payload: expect.objectContaining({ userId: 'user-1' }),
      })
    )
  })

  it('skips registration entry for cash method', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 6 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-002',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Service', quantity: 1, unit_price: 5000, account_number: '6200' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rolls back on items insertion failure', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 7 })
    enqueue({ data: createdInvoice, error: null })
    // Items fail
    enqueue({ data: null, error: { message: 'Items insert failed' } })
    // Rollback delete
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-003',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_CREATE_FAILED')
  })

  it('rolls back and returns SI_CREATE_NO_FISCAL_PERIOD when invoice_date is outside every fiscal period', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1', invoice_date: '2099-06-01' })

    // Fetch supplier
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 9 })
    // Insert invoice
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch company settings → accrual, so a registration JE is attempted
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    // Engine returns null because no fiscal period covers 2099-06-01
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue(null)
    // Rollback: delete the orphan invoice (items cascade)
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-NOFY',
        invoice_date: '2099-06-01',
        due_date: '2099-07-01',
        items: [{ description: 'Material', quantity: 1, unit_price: 8000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_NO_FISCAL_PERIOD')
    expect(mockCreateSupplierInvoiceRegistrationEntry).toHaveBeenCalled()
    // The orphan must be rolled back: the delete is the 6th queued call.
    expect(mockSupabase.from).toHaveBeenCalledWith('supplier_invoices')
  })

  it('returns 409 with credit chain on duplicate supplier_invoice_number for credited original', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    // Fetch supplier
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 8 })
    // Insert invoice → unique-index violation
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    // Lookup existing row
    enqueue({
      data: {
        id: 'existing-1',
        supplier_invoice_number: 'LF-DUP',
        status: 'credited',
      },
      error: null,
    })
    // Lookup credit note for the credited original
    enqueue({ data: { id: 'credit-1' }, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-DUP',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { existing: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details.existing).toEqual({
      id: 'existing-1',
      supplier_invoice_number: 'LF-DUP',
      status: 'credited',
      credit_note_id: 'credit-1',
    })
  })

  it('returns 409 without credit_note_id when existing invoice is not credited', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 9 })
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    enqueue({
      data: {
        id: 'existing-2',
        supplier_invoice_number: 'LF-DUP-2',
        status: 'approved',
      },
      error: null,
    })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-DUP-2',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { existing: { id: string; status: string; credit_note_id: string | null } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details.existing.status).toBe('approved')
    expect(body.error.details.existing.credit_note_id).toBeNull()
  })

  it('returns generic 409 when existing row lookup races to nothing', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 10 })
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    // Lookup returns null: the row was deleted between the failing insert and our fetch
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-RACE',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { existing?: unknown } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details?.existing).toBeNull()
  })

  it('falls through to 500 for non-23505 insert errors', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 11 })
    enqueue({ data: null, error: { code: '23502', message: 'NOT NULL violation' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-OTHER',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Test', quantity: 1, unit_price: 1000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('SI_CREATE_FAILED')
  })

  it('books privately-paid invoice via 2893 path for aktiebolag', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-priv-1', status: 'paid' })

    // Fetch supplier
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    // Fetch company.entity_type (paidPrivately branch)
    enqueue({ data: { entity_type: 'aktiebolag' }, error: null })
    // RPC get_next_arrival_number
    enqueue({ data: 12 })
    // Insert invoice
    enqueue({ data: createdInvoice, error: null })
    // Insert items
    enqueue({ data: null, error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    mockCreateSupplierInvoicePrivatelyPaidEntry.mockResolvedValue({ id: 'je-priv-1' })
    // Update invoice with payment_journal_entry_id
    enqueue({ data: null, error: null })
    // Insert supplier_invoice_payments row
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'KVITTO-001',
        invoice_date: '2024-06-01',
        due_date: '2024-06-01',
        paid_with_private_funds: true,
        items: [
          {
            description: 'Kontorsmaterial',
            quantity: 1,
            unit_price: 400,
            account_number: '6110',
            vat_rate: 0.25,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: { payment_journal_entry_id: string; registration_journal_entry_id: null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.payment_journal_entry_id).toBe('je-priv-1')
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(mockCreateSupplierInvoicePrivatelyPaidEntry).toHaveBeenCalled()
    // The classic registration path must NOT be touched.
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    const call = mockCreateSupplierInvoicePrivatelyPaidEntry.mock.calls[0]
    expect(call[5]).toBe('aktiebolag')
  })

  it('passes entity_type=enskild_firma so engine credits 2018', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-priv-2', status: 'paid' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: { entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: 13 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    mockCreateSupplierInvoicePrivatelyPaidEntry.mockResolvedValue({ id: 'je-priv-2' })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'KVITTO-002',
        invoice_date: '2024-06-01',
        due_date: '2024-06-01',
        paid_with_private_funds: true,
        items: [
          {
            description: 'Lunch klient',
            quantity: 1,
            unit_price: 200,
            account_number: '5810',
            vat_rate: 0.12,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const call = mockCreateSupplierInvoicePrivatelyPaidEntry.mock.calls[0]
    expect(call[5]).toBe('enskild_firma')
  })

  it('persists manual vat_amount override on items and forwards it to the engine', async () => {
    // Bilförmån-fallet: leverantören tar 25% moms men endast 50% är
    // avdragsgill. Användaren skriver 1 250 kr i momsrutan i stället för
    // den beräknade 2 500 kr.
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 7 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LEAS-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          {
            description: 'Leasing personbil',
            amount: 10000,
            account_number: '5615',
            vat_rate: 0.25,
            vat_amount: 1250,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateSupplierInvoiceRegistrationEntry).toHaveBeenCalled()
    const items = mockCreateSupplierInvoiceRegistrationEntry.mock.calls[0][4] as Array<{
      vat_amount: number
      vat_rate: number
      line_total: number
    }>
    expect(items).toHaveLength(1)
    expect(items[0].vat_amount).toBe(1250)
    expect(items[0].vat_rate).toBe(0.25)
    expect(items[0].line_total).toBe(10000)
  })

  it('falls back to line_total × rate when vat_amount is omitted', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: supplier, error: null })
    enqueue({ data: 8 })
    enqueue({ data: createdInvoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-001',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [
          {
            description: 'Material',
            amount: 10000,
            account_number: '4010',
            vat_rate: 0.25,
          },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const items = mockCreateSupplierInvoiceRegistrationEntry.mock.calls[0][4] as Array<{
      vat_amount: number
    }>
    expect(items[0].vat_amount).toBe(2500)
  })

  it('rejects periodisering combined with reverse_charge', async () => {
    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-RC-ACC',
        invoice_date: '2026-01-01',
        due_date: '2026-02-01',
        reverse_charge: true,
        items: [
          {
            description: 'Licens 12 mån',
            amount: 12000,
            account_number: '6540',
            vat_rate: 0,
            accrual_period_start: '2026-01-01',
            accrual_period_end: '2026-12-31',
          },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_ACCRUAL_REVERSE_CHARGE')
    // The guard must fire before anything is persisted or booked.
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoicePrivatelyPaidEntry).not.toHaveBeenCalled()
  })

  it('rejects paid_with_private_funds combined with reverse_charge', async () => {
    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-RC',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        paid_with_private_funds: true,
        reverse_charge: true,
        items: [{ description: 'Service', quantity: 1, unit_price: 5000, account_number: '6540', vat_rate: 0.25 }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_INVALID_INPUT')
    // Make sure we never touched the engine paths.
    expect(mockCreateSupplierInvoicePrivatelyPaidEntry).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })
})

// ── Exchange rate + SEK amounts ─────────────────────────────────────────────
// The queued Supabase mock is a bare Proxy, so the only way to assert what was
// actually written is to record the argument handed to `.insert()`. The route
// echoes back the enqueued fixture row, not its own payload.

type InsertRecord = { table: string; payload: Record<string, unknown> }

function wrapCapturing(chain: unknown, table: string, sink: InsertRecord[]): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const inner = (chain as Record<string | symbol, unknown>)[prop as string]
        if (prop === 'then') return inner
        return (...args: unknown[]) => {
          if (
            prop === 'insert' &&
            args[0] &&
            typeof args[0] === 'object' &&
            !Array.isArray(args[0])
          ) {
            sink.push({ table, payload: args[0] as Record<string, unknown> })
          }
          return wrapCapturing((inner as (...a: unknown[]) => unknown)(...args), table, sink)
        }
      },
    },
  )
}

describe('POST /api/supplier-invoices: exchange rate + SEK amounts', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const captured: InsertRecord[] = []
  let baseFrom: (...args: unknown[]) => unknown

  const supplierInvoiceInsert = () =>
    captured.find((c) => c.table === 'supplier_invoices')?.payload

  function enqueueHappyPath() {
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: makeSupplier({ id: VALID_UUID }), error: null }) // supplier lookup
    enqueue({ data: 7 }) // get_next_arrival_number
    enqueue({ data: makeSupplierInvoice({ id: 'si-fx' }), error: null }) // insert invoice
    enqueue({ data: [], error: null }) // insert items
    enqueue({ data: { accounting_method: 'cash' }, error: null }) // company_settings
  }

  function body(overrides: Record<string, unknown> = {}) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'LF-FX',
      invoice_date: '2024-06-01',
      due_date: '2024-07-01',
      items: [
        { description: 'Molntjänst', amount: 10000, account_number: '6540', vat_rate: 0.25 },
      ],
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    captured.length = 0
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchExchangeRate.mockReset()
    baseFrom = mockSupabase.from.getMockImplementation() as (...args: unknown[]) => unknown
    mockSupabase.from.mockImplementation((table: string) =>
      wrapCapturing(baseFrom(table), table, captured),
    )
  })

  afterEach(() => {
    mockSupabase.from.mockImplementation(baseFrom)
  })

  it('populates total_sek for an ordinary SEK invoice and never asks for a rate', async () => {
    enqueueHappyPath()

    const response = await POST(
      createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const payload = supplierInvoiceInsert()
    expect(payload).toBeDefined()
    // total_sek used to be NULL for every SEK invoice because the writer gated
    // it on an exchange rate existing. A SEK invoice has none by definition.
    expect(payload!.subtotal_sek).toBe(10000)
    expect(payload!.vat_amount_sek).toBe(2500)
    expect(payload!.total_sek).toBe(12500)
    expect(payload!.total_sek).toBe(payload!.total)
    expect(payload!.exchange_rate).toBeNull()
    expect(payload!.exchange_rate_date).toBeNull()
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('uses a caller-supplied rate for a foreign invoice without fetching', async () => {
    enqueueHappyPath()

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'EUR', exchange_rate: 11.5 }),
      }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const payload = supplierInvoiceInsert()
    expect(payload!.currency).toBe('EUR')
    expect(payload!.exchange_rate).toBe(11.5)
    expect(payload!.subtotal_sek).toBe(115000)
    expect(payload!.vat_amount_sek).toBe(28750)
    expect(payload!.total_sek).toBe(143750)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('fetches the invoice-date rate server-side when the caller omits one', async () => {
    enqueueHappyPath()
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.2, date: '2024-05-31' })

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'EUR' }),
      }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currencyArg, dateArg, clientArg] = mockFetchExchangeRate.mock.calls[0]
    expect(currencyArg).toBe('EUR')
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2024-06-01')
    // The supabase client must be passed through: that is what makes the
    // shared exchange_rates cache a read-through cache instead of dead weight.
    expect(clientArg).toBe(mockSupabase)

    const payload = supplierInvoiceInsert()
    expect(payload!.exchange_rate).toBe(11.2)
    // Observation date, not the requested date: Riksbanken publishes no rate
    // on weekends and the lookback picks the previous banking day.
    expect(payload!.exchange_rate_date).toBe('2024-05-31')
    expect(payload!.total_sek).toBe(140000)
  })

  it('refuses the create with SI_FX_RATE_MISSING when no rate can be resolved', async () => {
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: makeSupplier({ id: VALID_UUID }), error: null })
    mockFetchExchangeRate.mockResolvedValue(null)

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'USD' }),
      }),
    )
    const { status, body: responseBody } = await parseJsonResponse<{
      error: { code: string; details?: { currency?: string; invoice_date?: string } }
    }>(response)

    expect(status).toBe(400)
    expect(responseBody.error.code).toBe('SI_FX_RATE_MISSING')
    expect(responseBody.error.details?.currency).toBe('USD')
    // Nothing may be persisted, no ankomstnummer burned, no verifikat posted:
    // an unconverted row would only fail again inside the booking path.
    expect(supplierInvoiceInsert()).toBeUndefined()
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  // supplier_invoices_exchange_rate_check is `> 0 AND < 100000`. The schema
  // used to have no ceiling, so 250000 sailed past validation, reached the
  // constraint and came back to the user as an unexplained 500.
  it('rejects an out-of-range exchange rate as a 400, not a constraint-violation 500', async () => {
    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'EUR', exchange_rate: 250000 }),
      }),
    )
    const { status, body: responseBody } = await parseJsonResponse<{
      error: string
      type: string
      errors: Array<{ field: string; message: string }>
    }>(response)

    expect(status).toBe(400)
    expect(responseBody.type).toBe('validation_error')
    const issue = responseBody.errors.find((e) => e.field === 'exchange_rate')
    // Actionable, and Swedish: getErrorMessage passes a 'Valideringsfel:'
    // summary through verbatim, so this is what the user actually reads.
    expect(issue?.message).toContain('100 000')
    expect(responseBody.error).toContain('Valideringsfel')
    expect(supplierInvoiceInsert()).toBeUndefined()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rejects exactly 100000: the CHECK bound is exclusive, so the mirror is too', async () => {
    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'EUR', exchange_rate: 100000 }),
      }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(supplierInvoiceInsert()).toBeUndefined()
  })

  it('accepts 99999.99, the largest rate the CHECK allows', async () => {
    enqueueHappyPath()

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ currency: 'EUR', exchange_rate: 99999.99 }),
      }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(supplierInvoiceInsert()!.exchange_rate).toBe(99999.99)
  })
})

// ── Särskild löneskatt (SLP, apply_slp) ─────────────────────────────────────

describe('POST /api/supplier-invoices: särskild löneskatt (apply_slp)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function slpBody(items: Record<string, unknown>[]) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'LF-SLP',
      invoice_date: '2024-06-01',
      due_date: '2024-07-01',
      items,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('rejects apply_slp on a non-741x account with SI_CREATE_SLP_INVALID_ACCOUNT', async () => {
    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: slpBody([
          { description: 'Konsult', amount: 10000, account_number: '6200', vat_rate: 0.25, apply_slp: true },
        ]),
      }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_SLP_INVALID_ACCOUNT')
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rejects apply_slp combined with periodisering on the same item', async () => {
    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: slpBody([
          {
            description: 'Tjänstepension',
            amount: 10000,
            account_number: '7412',
            vat_rate: 0,
            apply_slp: true,
            accrual_period_start: '2024-06-01',
            accrual_period_end: '2024-12-31',
          },
        ]),
      }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_SLP_ACCRUAL')
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('happy path: apply_slp on a 7412 line is stored on the item and reaches the generator', async () => {
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: makeSupplier({ id: VALID_UUID }), error: null }) // supplier lookup
    enqueue({ data: 9 }) // get_next_arrival_number
    enqueue({ data: makeSupplierInvoice({ id: 'si-slp' }), error: null }) // insert invoice
    enqueue({ data: [], error: null }) // insert items
    enqueue({ data: { accounting_method: 'accrual' }, error: null }) // settings
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-slp' })
    enqueue({ data: null, error: null }) // update registration_journal_entry_id

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: slpBody([
          { description: 'Avanza tjänstepension', amount: 10000, account_number: '7412', vat_rate: 0, apply_slp: true },
        ]),
      }),
    )
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(200)

    // The DB insert carries the flag...
    const itemsInsert = findCall('supplier_invoice_items', 'insert')
    expect(itemsInsert).toBeDefined()
    const rows = itemsInsert![0] as Array<Record<string, unknown>>
    expect(rows[0].apply_slp).toBe(true)
    expect(rows[0].account_number).toBe('7412')

    // ...and the same items array reaches the registration generator, which
    // injects the 7533/2514 pair from it.
    const generatorItems = mockCreateSupplierInvoiceRegistrationEntry.mock
      .calls[0][4] as Array<Record<string, unknown>>
    expect(generatorItems[0].apply_slp).toBe(true)
  })

  it('defaults apply_slp to false when omitted', async () => {
    enqueue({ data: { vat_registered: true }, error: null }) // vat_registered guard
    enqueue({ data: makeSupplier({ id: VALID_UUID }), error: null })
    enqueue({ data: 10 })
    enqueue({ data: makeSupplierInvoice({ id: 'si-noslp' }), error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: slpBody([
          { description: 'Pensionspremie utan SLP-flagga', amount: 5000, account_number: '7412', vat_rate: 0 },
        ]),
      }),
    )
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(200)

    const itemsInsert = findCall('supplier_invoice_items', 'insert')
    const rows = itemsInsert![0] as Array<Record<string, unknown>>
    expect(rows[0].apply_slp).toBe(false)
  })
})

describe('POST /api/supplier-invoices: icke momsregistrerad (vat_registered=false)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function vrBody(items: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'LF-VR',
      invoice_date: '2024-06-01',
      due_date: '2024-07-01',
      items,
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('rejects a line carrying moms with SI_CREATE_INVALID_INPUT', async () => {
    enqueue({ data: { vat_registered: false }, error: null }) // vat_registered guard

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: vrBody([
        { description: 'Material', amount: 1000, account_number: '4010', vat_rate: 0.25 },
      ]),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('lets reverse charge pass the guard (self-assessment is separate from deduction)', async () => {
    enqueue({ data: { vat_registered: false }, error: null }) // vat_registered guard
    enqueue({ data: null, error: { message: 'Not found' } }) // supplier lookup fails

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: vrBody(
        [{ description: 'EU-tjänst', amount: 1000, account_number: '4531', vat_rate: 0 }],
        { reverse_charge: true },
      ),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    // Reaching SUPPLIER_NOT_FOUND proves the moms guard did not fire.
    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('defaults an omitted vat_rate to 0 instead of 25 %', async () => {
    enqueue({ data: { vat_registered: false }, error: null }) // vat_registered guard
    enqueue({ data: makeSupplier({ id: VALID_UUID }), error: null }) // supplier lookup
    enqueue({ data: 5 }) // get_next_arrival_number
    enqueue({ data: makeSupplierInvoice({ id: 'si-vr' }), error: null }) // insert invoice
    enqueue({ data: [], error: null }) // insert items
    enqueue({ data: { accounting_method: 'accrual' }, error: null }) // company settings
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-vr' })
    enqueue({ data: null, error: null }) // update registration_journal_entry_id

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: vrBody([{ description: 'Material', amount: 1000, account_number: '4010' }]),
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const itemsInsert = findCall('supplier_invoice_items', 'insert')
    const rows = itemsInsert![0] as Array<Record<string, unknown>>
    expect(rows[0].vat_rate).toBe(0)
    expect(rows[0].vat_amount).toBe(0)
  })
})
