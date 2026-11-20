import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
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

import { POST } from '../route'

const quoteRow = {
  id: 'q-1',
  company_id: 'company-1',
  document_type: 'quote',
  status: 'sent',
  invoice_number: null,
}

function post() {
  return POST(
    createMockRequest('/api/invoices/q-1/cancel', { method: 'POST' }),
    createMockRouteParams({ id: 'q-1' }),
  )
}

describe('POST /api/invoices/[id]/cancel', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const cancelled = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    eventBus.on('invoice.cancelled', cancelled)
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(401)
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  it('returns 404 when the document does not exist in the company', async () => {
    enqueue({ data: null, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
    expect(findCall('invoices', 'eq')).toEqual(['id', 'q-1'])
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it.each(['invoice', 'credit_note'])('returns 400 for a %s and writes nothing', async (documentType) => {
    enqueue({ data: { ...quoteRow, document_type: documentType, status: 'draft' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA')
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it.each(['quote', 'proforma'])('cancels a %s and records who did it', async (documentType) => {
    const row = { ...quoteRow, document_type: documentType }
    enqueue({ data: row, error: null })
    enqueue({ data: { ...row, status: 'cancelled' }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(await post())

    expect(status).toBe(200)
    expect(body.data.status).toBe('cancelled')
    expect(findCall('invoices', 'update')?.[0]).toMatchObject({ status: 'cancelled' })
    // Compare-and-set on the status that was read.
    expect(findCalls('invoices', 'eq')).toContainEqual(['status', 'sent'])
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'q-1', status: 'cancelled' },
    })
  })

  it('answers an already cancelled document unchanged, with no second event', async () => {
    enqueue({ data: { ...quoteRow, status: 'cancelled' }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(await post())

    expect(status).toBe(200)
    expect(body.data.status).toBe('cancelled')
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('returns 409 when the status changed between the read and the write', async () => {
    enqueue({ data: quoteRow, error: null })
    enqueue({ data: null, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
    expect(cancelled).not.toHaveBeenCalled()
  })
})
