import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const user = { id: 'user-1', email: 'owner@example.test' }

describe('GET /api/invoices/[id]/peppol/deliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    delete process.env.PEPPOL_TRANSPORT_PROVIDER
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid invoice id', async () => {
    const response = await GET(
      createMockRequest('/api/invoices/not-a-uuid/peppol/deliveries'),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 for an invoice outside the active company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('returns minimized delivery status and a truthful transport gate', async () => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    enqueue({
      data: [{
        id: '22222222-2222-4222-8222-222222222222',
        status: 'transport_succeeded',
        provider: 'storecove',
        xml_sha256: 'a'.repeat(64),
      }],
      error: null,
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/peppol/deliveries`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data).toEqual([
      expect.objectContaining({ status: 'transport_succeeded', provider: 'storecove' }),
    ])
    expect(body.transport).toEqual({
      available: false,
      provider: null,
      reason: 'provider_selection_required',
    })
  })
})
