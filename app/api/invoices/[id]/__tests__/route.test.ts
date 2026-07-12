import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
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
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { DELETE } from '../route'

describe('DELETE /api/invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('rejects cancellation of a non-draft invoice with INVOICE_DELETE_NOT_DRAFT', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'sent', invoice_number: 'F-2026099', user_id: 'user-1' },
      error: null,
    })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_DELETE_NOT_DRAFT')
  })

  it('cancels a numbered draft, retaining the F-series number', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{
      data: { cancelled: boolean; invoice_number: string | null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.cancelled).toBe(true)
    expect(body.data.invoice_number).toBe('F-2026001')
  })

  it('hard deletes an un-numbered draft (saved via "Spara som utkast") and emits an audit event', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, user_id: 'user-1' },
      error: null,
    })
    // delete().select('id') returns the removed row
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
    // The hard delete leaves no journal trace, so an audit event must record it.
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'invoice.draft_deleted',
      payload: { invoiceId: 'inv-1', companyId: 'company-1', userId: 'user-1' },
    })
  })

  it('returns 409 INVOICE_CANCEL_RACE when an un-numbered draft is finalized concurrently', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, user_id: 'user-1' },
      error: null,
    })
    // delete matched 0 rows: the draft was finalized (numbered) in the meantime.
    enqueue({ data: [], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('returns 409 INVOICE_CANCEL_RACE when status flipped between fetch and update', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    // Update succeeds with no error but matches 0 rows because the .eq('status','draft')
    // guard rejected the row (concurrent send/cancel flipped status in the meantime).
    enqueue({ data: [], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('returns 500 when the cancel update fails', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    enqueue({ data: null, error: { message: 'cancel update failed' } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })
})
