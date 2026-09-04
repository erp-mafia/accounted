import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

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

import { POST } from '../route'

const quoteRow = {
  id: 'q-1',
  document_type: 'quote',
  status: 'sent',
  quote_status: 'open',
  quote_decided_at: null,
}

function post(body: unknown) {
  return POST(
    createMockRequest('/api/invoices/q-1/quote-status', { method: 'POST', body }),
    createMockRouteParams({ id: 'q-1' }),
  )
}

describe('POST /api/invoices/[id]/quote-status', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await post({ status: 'accepted' }))

    expect(status).toBe(401)
  })

  it('returns 400 on an unknown status', async () => {
    const { status } = await parseJsonResponse(await post({ status: 'expired' }))

    expect(status).toBe(400)
  })

  it('returns 404 when the quote does not exist in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const { status } = await parseJsonResponse(await post({ status: 'accepted' }))

    expect(status).toBe(404)
  })

  it('returns 400 when the document is not a quote', async () => {
    enqueue({ data: { ...quoteRow, document_type: 'invoice', quote_status: null }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ status: 'accepted' }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_NOT_A_QUOTE')
  })

  it('returns 400 when the quote is cancelled', async () => {
    enqueue({ data: { ...quoteRow, status: 'cancelled' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ status: 'declined' }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_QUOTE_NOT_DECIDABLE')
  })

  it('returns 409 once an invoice exists for the quote', async () => {
    enqueue({ data: { ...quoteRow, quote_status: 'accepted' }, error: null })
    enqueue({ data: { id: 'inv-1', invoice_number: 'F-042' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ status: 'declined' }),
    )

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
  })

  it('records an acceptance with a decided_at timestamp', async () => {
    enqueue({ data: quoteRow, error: null })
    enqueue({ data: null, error: null })
    enqueue({
      data: { ...quoteRow, quote_status: 'accepted', quote_decided_at: '2026-06-01T10:00:00.000Z' },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ data: { quote_status: string } }>(
      await post({ status: 'accepted' }),
    )

    expect(status).toBe(200)
    expect(body.data.quote_status).toBe('accepted')
    const update = findCall('invoices', 'update')?.[0] as Record<string, unknown>
    expect(update.quote_status).toBe('accepted')
    expect(typeof update.quote_decided_at).toBe('string')
  })

  it('reopening clears decided_at', async () => {
    enqueue({ data: { ...quoteRow, quote_status: 'declined' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { ...quoteRow, quote_status: 'open' }, error: null })

    const { status } = await parseJsonResponse(await post({ status: 'open' }))

    expect(status).toBe(200)
    const update = findCall('invoices', 'update')?.[0] as Record<string, unknown>
    expect(update.quote_status).toBe('open')
    expect(update.quote_decided_at).toBeNull()
  })
})
