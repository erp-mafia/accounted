import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

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

  it('emits supplier_invoice.registered event', async () => {
    const supplier = makeSupplier({ id: VALID_UUID })
    const createdInvoice = makeSupplierInvoice({ id: 'si-1' })

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
