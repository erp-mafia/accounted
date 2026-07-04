import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
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

import { PATCH } from '../route'

const VALID_BODY = {
  customer_id: '11111111-1111-4111-8111-111111111111',
  invoice_date: '2026-06-15',
  due_date: '2026-07-15',
  currency: 'SEK',
  items: [{ description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
}

function patch(id: string, body: unknown = VALID_BODY) {
  return PATCH(
    createMockRequest(`/api/invoices/${id}`, { method: 'PATCH', body }),
    createMockRouteParams({ id }),
  )
}

describe('PATCH /api/invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockGetVatRules.mockReturnValue({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
      reverseChargeText: undefined,
    })
    mockGetAvailableVatRates.mockReturnValue([
      { rate: 25, label: '25%', treatment: 'standard_25' },
      { rate: 0, label: '0%', treatment: 'exempt' },
    ])
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await patch('inv-1'))
    expect(status).toBe(401)
  })

  it('returns 400 on an invalid body', async () => {
    const { status } = await parseJsonResponse(await patch('inv-1', { currency: 'SEK' }))
    expect(status).toBe(400)
  })

  it('returns 404 INVOICE_NOT_FOUND when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('returns 409 INVOICE_UPDATE_NOT_DRAFT for a sent invoice', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'sent', invoice_number: 'F-1', journal_entry_id: null, is_self_billed: false },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('refuses to edit a draft that already carries a journal entry', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-1', journal_entry_id: 'je-1', is_self_billed: false },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('refuses to edit a received self-billing invoice', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, journal_entry_id: null, is_self_billed: true },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('returns 404 INVOICE_CUSTOMER_NOT_FOUND when the customer is missing', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, journal_entry_id: null, is_self_billed: false },
      error: null,
    })
    enqueue({ data: null, error: { message: 'no customer' } }) // customer lookup

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('updates a draft (header + items) and returns the refreshed invoice without emitting invoice.created', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emit')

    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-1', journal_entry_id: null, is_self_billed: false },
      error: null,
    }) // existing
    enqueue({ data: makeCustomer({ id: 'customer-1', customer_type: 'swedish_business' }), error: null }) // customer
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings.vat_registered
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // update ... select('id')
    enqueue({ data: [], error: null }) // delete invoice_items
    enqueue({ data: null, error: null }) // insert invoice_items
    enqueue({
      data: makeInvoice({ id: 'inv-1', status: 'draft', invoice_number: 'F-1', total: 12500 }),
      error: null,
    }) // re-select complete invoice

    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string; invoice_number: string } }>(
      await patch('inv-1'),
    )

    expect(status).toBe(200)
    expect(body.data.id).toBe('inv-1')
    // Editing a draft never re-issues it: status + number are unchanged and no
    // invoice.created event is emitted.
    expect(body.data.status).toBe('draft')
    expect(body.data.invoice_number).toBe('F-1')
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('returns 409 when the draft is sent/finalized concurrently (0-row update)', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, journal_entry_id: null, is_self_billed: false },
      error: null,
    }) // existing
    enqueue({ data: makeCustomer({ id: 'customer-1', customer_type: 'swedish_business' }), error: null }) // customer
    enqueue({ data: { vat_registered: true }, error: null }) // settings
    enqueue({ data: [], error: null }) // update matched 0 rows (status flipped)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('passes through a VAT-rule violation from the shared builder', async () => {
    mockGetAvailableVatRates.mockReturnValue([{ rate: 0, label: '0%', treatment: 'reverse_charge' }])

    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, journal_entry_id: null, is_self_billed: false },
      error: null,
    }) // existing
    enqueue({ data: makeCustomer({ id: 'customer-1', customer_type: 'eu_business', vat_number_validated: true }), error: null }) // customer
    enqueue({ data: { vat_registered: true }, error: null }) // settings

    const { body } = await parseJsonResponse<{ error: { code: string } }>(await patch('inv-1'))
    expect(body.error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
  })
})
