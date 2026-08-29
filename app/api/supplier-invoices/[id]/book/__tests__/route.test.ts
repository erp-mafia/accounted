import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCreateRegistrationEntry = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: (...args: unknown[]) => mockCreateRegistrationEntry(...args),
}))

const mockCreateSchedules = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForSupplierInvoice: (...args: unknown[]) => mockCreateSchedules(...args),
}))

const mockCancelOrphan = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...args: unknown[]) => mockCancelOrphan(...args),
}))

const mockAnchorDocument = vi.fn()
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: (...args: unknown[]) => mockAnchorDocument(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function bookRequest() {
  return POST(
    createMockRequest('/api/supplier-invoices/si-1/book', { method: 'POST' }),
    createMockRouteParams({ id: 'si-1' }),
  )
}

function makeUnbookedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ...makeSupplierInvoice({ id: 'si-1' }),
    registration_journal_entry_id: null,
    is_credit_note: false,
    items: [],
    supplier: { id: 'supplier-1', name: 'Leverantören AB', supplier_type: 'company' },
    ...overrides,
  }
}

describe('POST /api/supplier-invoices/[id]/book', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await bookRequest())
    expect(status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_NOT_FOUND')
  })

  it('rejects an already booked invoice', async () => {
    enqueue({ data: makeUnbookedInvoice({ registration_journal_entry_id: 'je-existing' }), error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BOOK_ALREADY_BOOKED')
    expect(mockCreateRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rejects paid invoices (payment flow already booked them)', async () => {
    enqueue({ data: makeUnbookedInvoice({ status: 'paid' }), error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BOOK_INVALID_STATUS')
  })

  it('fails closed when company settings cannot be read', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(500)
    expect(body.error.code).toBe('SI_BOOK_FAILED')
    expect(mockCreateRegistrationEntry).not.toHaveBeenCalled()
  })

  it('rejects booking under the cash method', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BOOK_CASH_METHOD')
    expect(mockCreateRegistrationEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when no fiscal period covers the invoice date', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateRegistrationEntry.mockResolvedValue(null)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BOOK_NO_FISCAL_PERIOD')
  })

  it('cancels the entry and returns 409 when another request booked first', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    // CAS-guarded link matches no row: someone else already claimed it.
    enqueue({ data: null, error: { message: 'no rows' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_BOOK_CONFLICT')
    expect(mockCancelOrphan).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
    expect(mockAnchorDocument).not.toHaveBeenCalled()
  })

  it('books the registration entry and links it', async () => {
    const invoice = makeUnbookedInvoice()
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, registration_journal_entry_id: 'je-1' }, error: null })

    const { status, body } = await parseJsonResponse<{
      data: { registration_journal_entry_id: string }
      journal_entry_id: string
    }>(await bookRequest())

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-1')
    expect(body.data.registration_journal_entry_id).toBe('je-1')
    expect(mockCreateRegistrationEntry).toHaveBeenCalled()
    // No accrual items on the fixture, so no schedule creation.
    expect(mockCreateSchedules).not.toHaveBeenCalled()
    // The invoice's retained source document is anchored to the fresh
    // registration verifikat (no-op inside the helper when there is none).
    expect(mockAnchorDocument).toHaveBeenCalledWith(mockSupabase, 'company-1', 'si-1')
  })

  it('creates accrual schedules and surfaces failures as warnings', async () => {
    const invoice = makeUnbookedInvoice({
      items: [
        {
          id: 'item-1',
          description: 'Hyra Q3',
          accrual_period_start: '2026-07-01',
          accrual_period_end: '2026-09-30',
        },
      ],
    })
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    mockCreateRegistrationEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, registration_journal_entry_id: 'je-1' }, error: null })
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 1 })

    const { status, body } = await parseJsonResponse<{
      warnings?: Array<{ code: string }>
    }>(await bookRequest())

    expect(status).toBe(200)
    expect(mockCreateSchedules).toHaveBeenCalled()
    expect(body.warnings?.[0]?.code).toBe('ACCRUAL_SCHEDULE_FAILED')
  })
})
