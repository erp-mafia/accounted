import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeSupplierInvoice,
  parseJsonResponse,
} from '@/tests/helpers'

const {
  supabase: mockSupabase,
  enqueue,
  enqueueMany,
  findCall,
  reset,
} = createQueuedMockSupabase()

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

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const createCreditEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierCreditNoteEntry: (...args: unknown[]) => createCreditEntryMock(...args),
}))

const cancelSchedulesMock = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: (...args: unknown[]) => cancelSchedulesMock(...args),
}))

import { eventBus } from '@/lib/events'
import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/credit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const legacyItem = {
    id: 'item-1',
    supplier_invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Kontorsmaterial',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    account_number: '5410',
    vat_code: null,
    vat_rate: 25,
    vat_amount: 250,
    reverse_charge_rate: null,
    dimensions: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const original = {
    ...makeSupplierInvoice({ id: 'invoice-1', status: 'registered' }),
    supplier: { name: 'Leverantör AB', supplier_type: 'swedish_business' },
    items: [legacyItem],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({
      user: mockUser,
      supabase: mockSupabase,
      error: null,
    })
    cancelSchedulesMock.mockResolvedValue({ failedReversals: 0 })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/supplier-invoices/invoice-1/credit', { method: 'POST' }),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 404 when the supplier invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest('/api/supplier-invoices/missing/credit', { method: 'POST' }),
      createMockRouteParams({ id: 'missing' }),
    )

    expect(response.status).toBe(404)
  })

  it('returns 409 when the supplier invoice is already credited', async () => {
    enqueue({ data: { ...original, status: 'credited' }, error: null })

    const response = await POST(
      createMockRequest('/api/supplier-invoices/invoice-1/credit', { method: 'POST' }),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(409)
  })

  it('normalizes copied item storage but keeps original items for reversal', async () => {
    const creditNote = makeSupplierInvoice({
      id: 'credit-1',
      is_credit_note: true,
      credited_invoice_id: 'invoice-1',
    })
    enqueueMany([
      { data: original, error: null },
      { data: 2, error: null },
      { data: creditNote, error: null },
      { data: null, error: null },
      { data: { accounting_method: 'accrual' }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ])
    createCreditEntryMock.mockResolvedValue({ id: 'journal-1' })

    const response = await POST(
      createMockRequest('/api/supplier-invoices/invoice-1/credit', { method: 'POST' }),
      createMockRouteParams({ id: 'invoice-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const insertArgs = findCall('supplier_invoice_items', 'insert')
    const insertedItems = insertArgs?.[0] as Array<{ vat_rate: number }>
    expect(insertedItems[0]?.vat_rate).toBe(0.25)
    expect(createCreditEntryMock).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      creditNote,
      original.items,
      'swedish_business',
      'Leverantör AB',
    )
  })
})
