import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/invoices/digital-mailbox-send', () => ({ sendInvoiceToDigitalMailbox: sendMock }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const URL = '/api/invoices/inv-1/digital-mailbox/send'

function authed() {
  const { supabase } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
}

describe('POST /api/invoices/[id]/digital-mailbox/send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const response = await POST(createMockRequest(URL, { method: 'POST', body: { provider: 'kivra' } }), createMockRouteParams({ id: 'inv-1' }))
    expect(response.status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing or unknown provider', async () => {
    authed()
    const response = await POST(createMockRequest(URL, { method: 'POST', body: { provider: 'fax' } }), createMockRouteParams({ id: 'inv-1' }))
    expect(response.status).toBe(400)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an invoice outside the company', async () => {
    authed()
    sendMock.mockResolvedValue({ ok: false, code: 'INVOICE_NOT_FOUND' })
    const response = await POST(createMockRequest(URL, { method: 'POST', body: { provider: 'kivra' } }), createMockRouteParams({ id: 'inv-1' }))
    expect(response.status).toBe(404)
  })

  it('maps an unreachable recipient to its 422 envelope', async () => {
    authed()
    sendMock.mockResolvedValue({ ok: false, code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE', details: { recipient_kind: 'company' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(createMockRequest(URL, { method: 'POST', body: { provider: 'billo' } }), createMockRouteParams({ id: 'inv-1' })),
    )
    expect(status).toBe(422)
    expect(body.error.code).toBe('DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE')
  })

  it('sends and answers the dispatch', async () => {
    authed()
    const data = { dispatch_id: 'd-1', provider: 'kivra', provider_ref: 'c-1', recipient_kind: 'company', issued: true, journal_entry_id: 'je-1' }
    sendMock.mockResolvedValue({ ok: true, data })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await POST(createMockRequest(URL, { method: 'POST', body: { provider: 'kivra' } }), createMockRouteParams({ id: 'inv-1' })),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), 'inv-1', 'kivra')
  })
})
