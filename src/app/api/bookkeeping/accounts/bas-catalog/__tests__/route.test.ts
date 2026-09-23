import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: vi.fn(),
    auth: { getUser: () => mockAuth() },
  }),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

function mkReq() {
  return new Request('http://localhost/api/bookkeeping/accounts/bas-catalog')
}
function mkParams() {
  return { params: Promise.resolve({}) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/bookkeeping/accounts/bas-catalog', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })
    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(401)
  })

  it('returns the full BAS catalogue with the projected fields', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const res = await GET(mkReq(), mkParams())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    // The real BAS 2026 chart is ~1,276 accounts.
    expect(body.data.length).toBeGreaterThan(1000)

    const it = body.data.find((a: { account_number: string }) => a.account_number === '6540')
    expect(it).toMatchObject({
      account_number: '6540',
      account_name: 'IT-tjänster',
      account_class: 6,
      account_group: '65',
    })
    expect(typeof it.description).toBe('string')
  })

  it('sets a client cache header (static reference data)', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    const res = await GET(mkReq(), mkParams())
    expect(res.headers.get('Cache-Control')).toContain('max-age=')
  })
})
