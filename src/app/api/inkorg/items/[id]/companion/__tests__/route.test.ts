import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const followMock = vi.fn()
vi.mock('@/lib/operations/inbox-companion', () => ({
  followInvoiceWithReceipt: (...args: unknown[]) => followMock(...args),
}))

import { POST } from '../route'

const INVOICE_ID = '6f1c2a40-0000-4000-8000-0000000000a1'
const RECEIPT_ID = '6f1c2a40-0000-4000-8000-0000000000a2'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  followMock.mockResolvedValue({ ok: true, data: { status: 'completed', journal_entry_id: 'je-pay', transaction_id: 'tx-x' } })
})

const post = (body: unknown = { receipt_item_id: RECEIPT_ID }, id = INVOICE_ID) =>
  POST(createMockRequest(`/api/inkorg/items/${id}/companion`, { method: 'POST', body }), createMockRouteParams({ id }))

describe('POST /api/inkorg/items/:id/companion', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post()).status).toBe(401)
    expect(followMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post()).status).toBe(403)
    expect(followMock).not.toHaveBeenCalled()
  })

  it('returns 400 without a receipt id, or with one that is not a uuid', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ receipt_item_id: 'not-a-uuid' })).status).toBe(400)
    expect(followMock).not.toHaveBeenCalled()
  })

  it('returns 404 when either item is not the company\'s', async () => {
    followMock.mockResolvedValue({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('returns 409 when the two are not one purchase', async () => {
    followMock.mockResolvedValue({ ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_COMPANION_NOT_PAIRED')
    expect(body.error.message).toContain('Kvittot')
  })

  it('brings the receipt onto the invoice\'s booking, in the active company, as the signed-in person', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await post())
    expect(status).toBe(200)
    expect(body.data).toEqual({ status: 'completed', journal_entry_id: 'je-pay', transaction_id: 'tx-x' })
    expect(followMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      INVOICE_ID,
      RECEIPT_ID,
    )
  })

  it('answers what it waits for when the invoice is not booked yet', async () => {
    followMock.mockResolvedValue({ ok: true, data: { status: 'waiting', reason: 'invoice_unpaid' } })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await post())
    expect(status).toBe(200)
    expect(body.data).toEqual({ status: 'waiting', reason: 'invoice_unpaid' })
  })
})
