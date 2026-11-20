import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() }),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const serviceClient = { marker: 'service' }
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient,
}))

const listMock = vi.fn()
vi.mock('@/lib/company/deleted-company-export', () => ({
  listDeletedCompanyExports: (...args: unknown[]) => listMock(...args),
}))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
})

describe('GET /api/account/deleted-companies', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await GET())
    expect(status).toBe(401)
    expect(listMock).not.toHaveBeenCalled()
  })

  it("lists the signed-in person's deleted companies with the service client", async () => {
    const companies = [
      { id: 'c-1', name: 'Acme AB', archivedAt: '2026-11-02T10:00:00Z', exportUntil: '2028-05-02' },
    ]
    listMock.mockResolvedValue(companies)

    const response = await GET()
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(companies)
    expect(listMock).toHaveBeenCalledWith(serviceClient, 'user-1')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns 500 when the list cannot be read', async () => {
    listMock.mockRejectedValue(new Error('database unavailable'))
    const { status } = await parseJsonResponse(await GET())
    expect(status).toBe(500)
  })
})
