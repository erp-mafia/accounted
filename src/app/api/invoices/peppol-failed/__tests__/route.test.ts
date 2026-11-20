import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'

const session = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const createServiceClientMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const user = { id: 'user-1', email: 'owner@example.test' }

function get() {
  return GET(createMockRequest('/api/invoices/peppol-failed'), { params: Promise.resolve({}) })
}

describe('GET /api/invoices/peppol-failed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.reset()
    requireAuthMock.mockResolvedValue({ user, supabase: session.supabase, error: null })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: session.supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await get()

    expect(response.status).toBe(401)
    expect(session.supabase.rpc).not.toHaveBeenCalled()
  })

  it("returns the ids of the active company's invoices whose latest delivery failed, read on the session client", async () => {
    session.enqueue({ data: ['invoice-1', 'invoice-2'] })

    const response = await get()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ data: ['invoice-1', 'invoice-2'] })
    // The membership-checked function on the user's own client, for the
    // session's company; never a service-role client in a request path.
    expect(session.supabase.rpc).toHaveBeenCalledWith('peppol_failed_invoice_ids', expect.objectContaining({ p_company_id: 'company-1' }))
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('answers the canonical error envelope when the read fails', async () => {
    session.enqueue({ error: { message: 'connection reset' } })

    const response = await get()

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect((await response.json()).error).toEqual(expect.objectContaining({ code: expect.any(String) }))
  })
})
