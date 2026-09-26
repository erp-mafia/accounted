import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createTableMockSupabase,
  makeSupplierInvoice,
  makeSupplier,
} from '@/tests/helpers'

// Per-table answers (not one global FIFO queue): each test pins what a table
// returns, so reordering unrelated reads in the service cannot break it.
const { supabase: mockSupabase, setTable, reset, findCall, findCalls } = createTableMockSupabase()
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
// reverseEntry: the rollback of a failed registration stornoes a posted
// registration entry instead of deleting the invoice.
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

const mockCreateSupplierInvoiceRegistrationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  // The privately-paid line builder is pure: keep the real one so the tests
  // pin the kontering the route hands to the claims writer.
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries',
  )
  return {
    ...actual,
    createSupplierInvoiceRegistrationEntry: (...args: unknown[]) =>
      mockCreateSupplierInvoiceRegistrationEntry(...args),
  }
})

// A privately paid invoice is an utlägg: the route hands it to the same
// claims writer as the Underlag pane instead of posting its own verifikat.
const mockRegisterExpenseClaim = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  registerExpenseClaim: (...args: unknown[]) => mockRegisterExpenseClaim(...args),
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

import { GET as routeGET, POST as routePOST } from '../route'

// The wrapped handlers take (request, routeParams); this static route has no
// params, so the wrappers fill them in and every call stays one argument.
type RouteParams = Parameters<typeof routePOST>[1]
const NO_PARAMS = { params: Promise.resolve({}) } as RouteParams
const GET = (request: Request, params: RouteParams = NO_PARAMS) => routeGET(request, params)
const POST = (request: Request, params: RouteParams = NO_PARAMS) => routePOST(request, params)

const mockUser = { id: 'user-1', email: 'test@test.se' }

function resetAll() {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
}

describe('GET /api/supplier-invoices', () => {
  beforeEach(resetAll)

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
    setTable('supplier_invoices', { data: invoices })

    const request = createMockRequest('/api/supplier-invoices')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
  })

  it('applies status filter', async () => {
    setTable('supplier_invoices', { data: [] })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'registered' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('supplier_invoices')
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['status', 'registered'])
  })

  it('handles to_pay virtual status', async () => {
    setTable('supplier_invoices', { data: [] })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'to_pay' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCall('supplier_invoices', 'in')).toEqual(['status', ['approved', 'overdue']])
  })

  it('applies supplier_id filter', async () => {
    const invoices = [makeSupplierInvoice({ supplier_id: 'supplier-1' })]
    setTable('supplier_invoices', { data: invoices })

    const request = createMockRequest('/api/supplier-invoices', {
      searchParams: { status: 'all', supplier_id: 'supplier-1' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(invoices)
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['supplier_id', 'supplier-1'])
  })

  it('returns 500 on database error', async () => {
    setTable('supplier_invoices', { data: null, error: { message: 'DB error' } })

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

/**
 * The tables a registration reads and writes, with the happy-path answers.
 * `supplier_invoices` is a constant: the insert and any later update both
 * resolve to the created row.
 */
function stubRegistration(opts: {
  settings?: Record<string, unknown>
  supplier?: object
  invoice?: object
  arrival?: number
} = {}) {
  setTable('suppliers', { data: opts.supplier ?? makeSupplier({ id: VALID_UUID }) })
  setTable('company_settings', { data: { vat_registered: true, accounting_method: 'accrual', ...opts.settings } })
  setTable('rpc:get_next_arrival_number', { data: opts.arrival ?? 5 })
  setTable('supplier_invoices', { data: opts.invoice ?? makeSupplierInvoice({ id: 'si-1' }) })
  setTable('supplier_invoice_items', { data: [] })
}

const DUPLICATE_ERROR = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
}

describe('POST /api/supplier-invoices', () => {
  beforeEach(resetAll)

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
    setTable('suppliers', { data: null, error: { message: 'Not found' } })

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

  // The dashboard gained the v1 guard: the picker hides archived suppliers,
  // and the shared service now refuses them on this door too.
  it('returns 404 SUPPLIER_NOT_FOUND for an archived supplier', async () => {
    stubRegistration({ supplier: { ...makeSupplier({ id: VALID_UUID }), archived_at: '2024-01-01T00:00:00Z' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-ARCH',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        items: [{ description: 'Material', quantity: 1, unit_price: 8000, account_number: '4010' }],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('creates supplier invoice with items and arrival number', async () => {
    stubRegistration({ arrival: 5 })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })

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
    const [invoiceRow] = findCall('supplier_invoices', 'insert') as [Record<string, unknown>]
    expect(invoiceRow.arrival_number).toBe(5)
    expect(findCall('supplier_invoices', 'update')?.[0]).toEqual({ registration_journal_entry_id: 'je-1' })
  })

  // Issue #2553: an omitted vat_rate follows the invoice's vat_treatment, so
  // an exempt purchase stores 0 instead of the old blanket 25 % that booked
  // input VAT the supplier never charged.
  it('derives vat_rate 0 from vat_treatment exempt when the line omits it', async () => {
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-exempt' }), arrival: 6 })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-exempt' })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: {
        supplier_id: VALID_UUID,
        supplier_invoice_number: 'LF-EXEMPT',
        invoice_date: '2024-06-01',
        due_date: '2024-07-01',
        vat_treatment: 'exempt',
        items: [
          { description: 'Bankavgift', quantity: 1, unit_price: 1000, account_number: '6570' },
        ],
      },
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const [invoiceRow] = findCall('supplier_invoices', 'insert') as [Record<string, unknown>]
    expect(invoiceRow.vat_treatment).toBe('exempt')
    expect(invoiceRow.vat_amount).toBe(0)
    expect(invoiceRow.total).toBe(1000)
    const [itemRows] = findCall('supplier_invoice_items', 'insert') as [Array<Record<string, unknown>>]
    expect(itemRows[0].vat_rate).toBe(0)
    expect(itemRows[0].vat_amount).toBe(0)
  })

  it('registers WITHOUT booking when defer_invoice_booking is on (#967)', async () => {
    stubRegistration({
      invoice: makeSupplierInvoice({ id: 'si-deferred' }),
      settings: { accounting_method: 'accrual', defer_invoice_booking: true },
    })

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
    const createdInvoice = makeSupplierInvoice({ id: 'si-with-document', document_id: DOCUMENT_UUID })
    stubRegistration({ invoice: createdInvoice, arrival: 6 })
    setTable('document_attachments', { data: { id: DOCUMENT_UUID, journal_entry_id: null } })
    // First read: no supplier invoice uses the document yet; then the insert.
    setTable('supplier_invoices', [{ data: null }, { data: createdInvoice }])
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-document' })
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
    expect((findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>).document_id).toBe(DOCUMENT_UUID)
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      DOCUMENT_UUID,
      'je-document',
    )
  })

  it('rejects a document that is missing or outside the active company', async () => {
    // document_attachments answers nothing: missing or another company's.
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
    stubRegistration()
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })

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
    stubRegistration({ settings: { accounting_method: 'cash' }, arrival: 6 })

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
    stubRegistration({ arrival: 7 })
    setTable('supplier_invoice_items', { data: null, error: { message: 'Items insert failed' } })

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
    // Nothing was booked, so the parent row is removed, not left as an orphan.
    expect(findCall('supplier_invoices', 'delete')).toBeDefined()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rolls back and returns SI_CREATE_NO_FISCAL_PERIOD when invoice_date is outside every fiscal period', async () => {
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-1', invoice_date: '2099-06-01' }), arrival: 9 })
    // Engine returns null because no fiscal period covers 2099-06-01
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue(null)

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
    // The orphan must be rolled back.
    expect(findCall('supplier_invoices', 'delete')).toBeDefined()
  })

  it('returns 409 with credit chain on duplicate supplier_invoice_number for credited original', async () => {
    stubRegistration({ arrival: 8 })
    setTable('supplier_invoices', [
      { data: null, error: DUPLICATE_ERROR }, // insert: unique-index violation
      { data: { id: 'existing-1', supplier_invoice_number: 'LF-DUP', status: 'credited' } }, // existing row
      { data: { id: 'credit-1' } }, // its credit note
    ])

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
      error: {
        code: string
        details: {
          supplier_id: string
          supplier_invoice_number: string
          existing: { id: string; supplier_invoice_number: string; status: string; credit_note_id: string }
        }
      }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details.existing).toEqual({
      id: 'existing-1',
      supplier_invoice_number: 'LF-DUP',
      status: 'credited',
      credit_note_id: 'credit-1',
    })
    // Details are snake_case on both doors since the service unification.
    expect(body.error.details.supplier_id).toBe(VALID_UUID)
    expect(body.error.details.supplier_invoice_number).toBe('LF-DUP')
  })

  it('returns 409 without credit_note_id when existing invoice is not credited', async () => {
    stubRegistration({ arrival: 9 })
    setTable('supplier_invoices', [
      { data: null, error: DUPLICATE_ERROR },
      { data: { id: 'existing-2', supplier_invoice_number: 'LF-DUP-2', status: 'approved' } },
    ])

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
    stubRegistration({ arrival: 10 })
    setTable('supplier_invoices', [
      { data: null, error: DUPLICATE_ERROR },
      // Lookup returns null: the row was deleted between the failing insert and our fetch
      { data: null },
    ])

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
    stubRegistration({ arrival: 11 })
    setTable('supplier_invoices', { data: null, error: { code: '23502', message: 'NOT NULL violation' } })

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

  // ── Privately paid = utlägg ──────────────────────────────────────────────
  // A person paid the supplier invoice: the route hands the invoice to the
  // claims writer with the invoice's kontering as the lines, so the verifikat
  // and the expense_claims row come from the same code as the Underlag pane
  // and the person shows up under "Betala ut utlägg" on Hem.

  const EMPLOYEE_UUID = '550e8400-e29b-41d4-a716-446655440003'
  const INBOX_UUID = '550e8400-e29b-41d4-a716-446655440004'

  function claimOk(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      claim: {
        id: 'claim-1',
        journal_entry_id: 'je-priv-1',
        claimant_name: 'Ägare',
        liability_account: '2893',
        ...overrides,
      },
    }
  }

  function privatelyPaidBody(overrides: Record<string, unknown> = {}) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'KVITTO-001',
      invoice_date: '2024-06-01',
      due_date: '2024-06-01',
      paid_with_private_funds: true,
      items: [
        { description: 'Kontorsmaterial', quantity: 1, unit_price: 400, account_number: '6110', vat_rate: 0.25 },
      ],
      ...overrides,
    }
  }

  type ClaimInput = {
    description: string
    claimant_name?: string
    employee_id?: string
    document_id?: string
    inbox_item_id?: string
    lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
  }

  function claimInput(): ClaimInput {
    expect(mockRegisterExpenseClaim).toHaveBeenCalledTimes(1)
    return mockRegisterExpenseClaim.mock.calls[0][3] as ClaimInput
  }

  function linesByAccount(input: ClaimInput) {
    return Object.fromEntries(input.lines.map((l) => [l.account_number, l]))
  }

  it("books a privately paid invoice as the owner's utlägg through the claims writer (AB: 2893)", async () => {
    stubRegistration({
      supplier: makeSupplier({ id: VALID_UUID, name: 'Pressbyrån' }),
      invoice: makeSupplierInvoice({
        id: 'si-priv-1',
        status: 'paid',
        arrival_number: 12,
        supplier_invoice_number: 'KVITTO-001',
      }),
      arrival: 12,
    })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    mockRegisterExpenseClaim.mockResolvedValue(claimOk())

    const request = createMockRequest('/api/supplier-invoices', { method: 'POST', body: privatelyPaidBody() })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{
      data: {
        payment_journal_entry_id: string
        registration_journal_entry_id: null
        expense_claim: { id: string; claimant_name: string; liability_account: string }
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.payment_journal_entry_id).toBe('je-priv-1')
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(body.data.expense_claim).toEqual({ id: 'claim-1', claimant_name: 'Ägare', liability_account: '2893' })
    // The classic registration path must NOT be touched.
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()

    const [, companyArg, userArg] = mockRegisterExpenseClaim.mock.calls[0]
    expect(companyArg).toBe('company-1')
    expect(userArg).toBe('user-1')
    const input = claimInput()
    expect(input).toMatchObject({
      expense_date: '2024-06-01',
      amount: 500,
      vat_amount: 100,
      currency: 'SEK',
      expense_account: '6110',
      // No name given: the shared owner label, so Hem groups the owner as one person.
      claimant_name: 'Ägare',
    })
    expect(input.employee_id).toBeUndefined()
    expect(input.document_id).toBeUndefined()
    expect(input.description).toContain('KVITTO-001')
    expect(input.description).toContain('ankomstnr 12')
    // The invoice's full kontering rides as the claim's lines: no 2440.
    const byAccount = linesByAccount(input)
    expect(byAccount['6110'].debit_amount).toBe(400)
    expect(byAccount['2641'].debit_amount).toBe(100)
    expect(byAccount['2893'].credit_amount).toBe(500)
    expect(byAccount['2440']).toBeUndefined()

    // The invoice row says paid from the start and mirrors the payment.
    const insert = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(insert).toMatchObject({ status: 'paid', paid_with_private_funds: true, remaining_amount: 0 })
    const payment = findCall('supplier_invoice_payments', 'insert')?.[0] as Record<string, unknown>
    expect(payment).toMatchObject({ supplier_invoice_id: 'si-priv-1', journal_entry_id: 'je-priv-1', amount: 500 })
    // The claims writer links the document on this path, never the route.
    expect(mockLinkToJournalEntry).not.toHaveBeenCalled()
  })

  it('enskild firma owner: the claim is an egen insättning on 2018 and the typed name travels', async () => {
    stubRegistration({
      invoice: makeSupplierInvoice({ id: 'si-priv-2', status: 'paid' }),
      settings: { accounting_method: 'cash' },
      arrival: 13,
    })
    setTable('companies', { data: { entity_type: 'enskild_firma' } })
    mockRegisterExpenseClaim.mockResolvedValue(claimOk({ liability_account: '2018', claimant_name: 'Anna Ek' }))

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({
        supplier_invoice_number: 'KVITTO-002',
        claimant_name: '  Anna Ek  ',
        items: [{ description: 'Lunch klient', quantity: 1, unit_price: 200, account_number: '5810', vat_rate: 0.12 }],
      }),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { expense_claim: { liability_account: string } } }>(response)

    expect(status).toBe(200)
    expect(body.data.expense_claim.liability_account).toBe('2018')
    const input = claimInput()
    expect(input.claimant_name).toBe('Anna Ek')
    const byAccount = linesByAccount(input)
    expect(byAccount['2018'].credit_amount).toBe(224)
    expect(byAccount['2893']).toBeUndefined()
  })

  it('an employee paid: verified before the arrival number is drawn, claim on 2820 with employee_id', async () => {
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-priv-3', status: 'paid' }), arrival: 14 })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    setTable('employees', { data: { id: EMPLOYEE_UUID } }) // employee belongs to the company
    mockRegisterExpenseClaim.mockResolvedValue(claimOk({ liability_account: '2820', claimant_name: 'Erik Berg' }))

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({ employee_id: EMPLOYEE_UUID, claimant_name: 'never used for an employee' }),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: { expense_claim: { claimant_name: string } } }>(response)

    expect(status).toBe(200)
    expect(body.data.expense_claim.claimant_name).toBe('Erik Berg')
    expect(findCall('employees', 'eq')).toEqual(['id', EMPLOYEE_UUID])
    const input = claimInput()
    expect(input.employee_id).toBe(EMPLOYEE_UUID)
    expect(input.claimant_name).toBeUndefined()
    const byAccount = linesByAccount(input)
    expect(byAccount['2820'].credit_amount).toBe(500)
    expect(byAccount['2893']).toBeUndefined()
  })

  it("returns 404 when the employee is not the company's, before any arrival number is drawn", async () => {
    stubRegistration()
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    // employees answers nothing: no such employee here

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({ employee_id: EMPLOYEE_UUID }),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
  })

  it("privately paid inbox document: the item's document is the underlag and the item is stamped with the invoice", async () => {
    const createdInvoice = makeSupplierInvoice({ id: 'si-priv-4', status: 'paid', document_id: DOCUMENT_UUID })
    stubRegistration({ invoice: createdInvoice, arrival: 15 })
    setTable('invoice_inbox_items', {
      data: { id: INBOX_UUID, document_id: DOCUMENT_UUID, created_supplier_invoice_id: null, created_journal_entry_id: null },
    })
    setTable('document_attachments', { data: { id: DOCUMENT_UUID, journal_entry_id: null } }) // its document, unlinked
    // No supplier invoice uses the document yet; then the insert.
    setTable('supplier_invoices', [{ data: null }, { data: createdInvoice }])
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    mockRegisterExpenseClaim.mockResolvedValue(claimOk())

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({ inbox_item_id: INBOX_UUID }),
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const input = claimInput()
    expect(input.document_id).toBe(DOCUMENT_UUID)
    expect(input.inbox_item_id).toBe(INBOX_UUID)
    const insert = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(insert.document_id).toBe(DOCUMENT_UUID)
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ created_supplier_invoice_id: 'si-priv-4' })
    expect(mockLinkToJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses inbox_item_id unless a person paid: the convert endpoint owns the other answers', async () => {
    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({ paid_with_private_funds: false, inbox_item_id: INBOX_UUID }),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
  })

  it('refuses an inbox item that is already booked', async () => {
    setTable('invoice_inbox_items', {
      data: { id: INBOX_UUID, document_id: DOCUMENT_UUID, created_supplier_invoice_id: 'si-old', created_journal_entry_id: null },
    })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: privatelyPaidBody({ inbox_item_id: INBOX_UUID }),
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_INVALID_INPUT')
    expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
  })

  it('a claims-writer refusal rolls the invoice back and maps the code', async () => {
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-priv-5', status: 'paid' }), arrival: 16 })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    mockRegisterExpenseClaim.mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })

    const request = createMockRequest('/api/supplier-invoices', { method: 'POST', body: privatelyPaidBody() })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREATE_NO_FISCAL_PERIOD')
    expect(findCall('supplier_invoices', 'delete')).toBeDefined()
  })

  it('a posted-but-unlinked claim is never rolled back: the verifikat is immutable', async () => {
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-priv-6', status: 'paid' }), arrival: 17 })
    setTable('companies', { data: { entity_type: 'aktiebolag' } })
    mockRegisterExpenseClaim.mockResolvedValue({ ok: false, code: 'LINK_WRITE_FAILED', detail: 'claim x posted as entry y' })

    const request = createMockRequest('/api/supplier-invoices', { method: 'POST', body: privatelyPaidBody() })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('SI_CREATE_FAILED')
    expect(findCall('supplier_invoices', 'delete')).toBeUndefined()
  })

  it('persists manual vat_amount override on items and forwards it to the engine', async () => {
    // Bilförmån-fallet: leverantören tar 25% moms men endast 50% är
    // avdragsgill. Användaren skriver 1 250 kr i momsrutan i stället för
    // den beräknade 2 500 kr.
    stubRegistration({ arrival: 7 })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })

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
    const [itemRows] = findCall('supplier_invoice_items', 'insert') as [Array<Record<string, unknown>>]
    expect(itemRows[0].vat_amount).toBe(1250)
  })

  it('falls back to line_total × rate when vat_amount is omitted', async () => {
    stubRegistration({ arrival: 8 })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-1' })

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
    // The supplier is now read before this guard (its type decides the
    // reverse_charge default), so the lookup has to find one.
    setTable('suppliers', { data: makeSupplier({ id: VALID_UUID }) })

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
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
  })

  it('rejects paid_with_private_funds combined with reverse_charge', async () => {
    // The supplier is now read before this guard (see above).
    setTable('suppliers', { data: makeSupplier({ id: VALID_UUID }) })

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
    expect(mockRegisterExpenseClaim).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })
})

// ── Guards the dashboard gained from the shared service ────────────────────

describe('POST /api/supplier-invoices: unified registration guards', () => {
  beforeEach(resetAll)

  function body(overrides: Record<string, unknown> = {}) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'LF-GUARD',
      invoice_date: '2024-06-01',
      due_date: '2024-07-01',
      items: [{ description: 'Konsulttjänst', amount: 10000, account_number: '6540' }],
      ...overrides,
    }
  }

  it('an EU supplier with reverse_charge omitted registers as reverse charge', async () => {
    stubRegistration({
      supplier: makeSupplier({ id: VALID_UUID, supplier_type: 'eu_business' }),
      settings: { accounting_method: 'cash' },
    })

    const response = await POST(createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const invoiceRow = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(invoiceRow.reverse_charge).toBe(true)
    expect(invoiceRow.vat_treatment).toBe('reverse_charge')
    // The supplier invoices no VAT: the payable total is the net.
    expect(invoiceRow.total).toBe(10000)
    const [itemRows] = findCall('supplier_invoice_items', 'insert') as [Array<Record<string, unknown>>]
    expect(itemRows[0].vat_rate).toBe(0)
  })

  it('a reverse-charge line carrying a vat_rate is a VALIDATION_ERROR', async () => {
    stubRegistration({ supplier: makeSupplier({ id: VALID_UUID, supplier_type: 'eu_business' }) })

    const response = await POST(
      createMockRequest('/api/supplier-invoices', {
        method: 'POST',
        body: body({ items: [{ description: 'X', amount: 1000, account_number: '6540', vat_rate: 0.25 }] }),
      }),
    )
    const { status, body: responseBody } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(responseBody.error.code).toBe('VALIDATION_ERROR')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns PERIOD_LOCKED under faktureringsmetoden when the lock date covers invoice_date', async () => {
    stubRegistration({ settings: { accounting_method: 'accrual', bookkeeping_locked_through: '2024-12-31' } })

    const response = await POST(createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }))
    const { status, body: responseBody } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(responseBody.error.code).toBe('PERIOD_LOCKED')
    // Refused before an ankomstnummer is drawn or anything is written.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('does not check the lock under kontantmetoden: registration posts no verifikat', async () => {
    stubRegistration({ settings: { accounting_method: 'cash', bookkeeping_locked_through: '2024-12-31' } })

    const response = await POST(createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCall('supplier_invoices', 'insert')).toBeDefined()
    // company_settings is read once (the booking settings), never for the lock.
    expect(findCalls('company_settings', 'select')).toHaveLength(1)
    expect(findCall('fiscal_periods', 'select')).toBeUndefined()
  })

  it('a failed registration with no posted verifikat hard-deletes the invoice', async () => {
    stubRegistration()
    mockCreateSupplierInvoiceRegistrationEntry.mockRejectedValue(new Error('engine boom'))
    // journal_entries answers nothing: the books hold no registration entry.

    const response = await POST(createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }))
    const { status, body: responseBody } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(responseBody.error.code).toBe('SI_CREATE_FAILED')
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['source_type', 'supplier_invoice_registered'])
    expect(findCall('supplier_invoice_items', 'delete')).toBeDefined()
    expect(findCall('supplier_invoices', 'delete')).toBeDefined()
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('a failed registration whose verifikat was posted is stornoed and the invoice marked reversed', async () => {
    stubRegistration()
    mockCreateSupplierInvoiceRegistrationEntry.mockRejectedValue(new Error('engine boom after commit'))
    setTable('journal_entries', { data: { id: 'je-posted' } })
    mockReverseEntry.mockResolvedValue({ id: 'je-storno' })

    const response = await POST(createMockRequest('/api/supplier-invoices', { method: 'POST', body: body() }))
    const { status, body: responseBody } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(responseBody.error.code).toBe('SI_CREATE_FAILED')
    expect(mockReverseEntry).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1', 'je-posted', '2024-06-01')
    const updates = findCalls('supplier_invoices', 'update').map((args) => args[0] as Record<string, unknown>)
    expect(updates.some((u) => u.status === 'reversed')).toBe(true)
    // A posted verifikat must never lose its invoice (BFL 5 kap 5 §).
    expect(findCall('supplier_invoices', 'delete')).toBeUndefined()
  })
})

// ── Exchange rate + SEK amounts ─────────────────────────────────────────────
// The route echoes back the fixture row, not its own payload, so the insert
// payload is read from the mock's recorded calls.

describe('POST /api/supplier-invoices: exchange rate + SEK amounts', () => {
  const supplierInvoiceInsert = () =>
    findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown> | undefined

  function stubHappyPath() {
    stubRegistration({
      invoice: makeSupplierInvoice({ id: 'si-fx' }),
      settings: { accounting_method: 'cash' },
      arrival: 7,
    })
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
    resetAll()
    mockFetchExchangeRate.mockReset()
  })

  it('populates total_sek for an ordinary SEK invoice and never asks for a rate', async () => {
    stubHappyPath()

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
    stubHappyPath()

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
    stubHappyPath()
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
    stubHappyPath()
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
    stubHappyPath()

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
  function slpBody(items: Record<string, unknown>[]) {
    return {
      supplier_id: VALID_UUID,
      supplier_invoice_number: 'LF-SLP',
      invoice_date: '2024-06-01',
      due_date: '2024-07-01',
      items,
    }
  }

  beforeEach(resetAll)

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
    stubRegistration({ invoice: makeSupplierInvoice({ id: 'si-slp' }), arrival: 9 })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-slp' })

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
    stubRegistration({
      invoice: makeSupplierInvoice({ id: 'si-noslp' }),
      settings: { accounting_method: 'cash' },
      arrival: 10,
    })

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

  beforeEach(resetAll)

  it('rejects a line carrying moms with SI_CREATE_INVALID_INPUT', async () => {
    // company_settings is now read once, after the supplier lookup, so the
    // supplier has to exist for the guard to be reached.
    stubRegistration({ settings: { vat_registered: false } })

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
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(mockCreateSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('lets reverse charge pass the guard (self-assessment is separate from deduction)', async () => {
    // The old proof (a supplier miss reached AFTER the guard) no longer
    // works: the supplier is now read first. Prove it by registering instead.
    stubRegistration({ settings: { vat_registered: false, accounting_method: 'cash' } })

    const request = createMockRequest('/api/supplier-invoices', {
      method: 'POST',
      body: vrBody(
        [{ description: 'EU-tjänst', amount: 1000, account_number: '4531', vat_rate: 0 }],
        { reverse_charge: true },
      ),
    })
    const response = await POST(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const invoiceRow = findCall('supplier_invoices', 'insert')?.[0] as Record<string, unknown>
    expect(invoiceRow.reverse_charge).toBe(true)
  })

  it('defaults an omitted vat_rate to 0 instead of 25 %', async () => {
    stubRegistration({
      invoice: makeSupplierInvoice({ id: 'si-vr' }),
      settings: { vat_registered: false, accounting_method: 'accrual' },
    })
    mockCreateSupplierInvoiceRegistrationEntry.mockResolvedValue({ id: 'je-vr' })

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
