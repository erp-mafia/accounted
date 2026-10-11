import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))

const resolveCompanyCounterparts = vi.fn()
vi.mock('@/lib/parties/resolver/run', () => ({
  resolveCompanyCounterparts: (...args: unknown[]) => resolveCompanyCounterparts(...args),
  resolverMode: () => (process.env.COUNTERPARTY_RESOLVER_MODE === 'off' ? 'off' : 'act'),
}))

const range = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ select: () => ({ gte: () => ({ order: () => ({ range }) }) }) }) }),
}))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'

describe('GET /api/parties/resolver/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.COUNTERPARTY_RESOLVER_MODE
  })

  it('rejects a caller without the cron secret', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(new Response('no', { status: 401 }) as never)
    const res = await GET(createMockRequest('http://localhost/api/parties/resolver/cron'))
    expect(res.status).toBe(401)
  })

  it('skips when the mode is off', async () => {
    process.env.COUNTERPARTY_RESOLVER_MODE = 'off'
    const { status, body } = await parseJsonResponse<{ skipped: boolean }>(await GET(createMockRequest('http://localhost/api/parties/resolver/cron')))
    expect(status).toBe(200)
    expect(body.skipped).toBe(true)
    expect(resolveCompanyCounterparts).not.toHaveBeenCalled()
  })

  it('runs once per company with recent transactions and sums the results', async () => {
    range.mockResolvedValueOnce({ data: [{ company_id: 'a' }, { company_id: 'a' }, { company_id: 'b' }], error: null })
    resolveCompanyCounterparts.mockImplementation(async (_s: unknown, companyId: string) => ({
      companyId, strings: 3, alreadyResolved: 1, planned: 2, byBand: { link: 1, tentative: 0, nil: 1 }, bySource: {}, modelLines: 1, verified: 0, promoted: 0, written: 2,
    }))
    const { status, body } = await parseJsonResponse<{ total: number; written: number; strings: number }>(await GET(createMockRequest('http://localhost/api/parties/resolver/cron')))
    expect(status).toBe(200)
    expect(resolveCompanyCounterparts).toHaveBeenCalledTimes(2)
    expect(body).toMatchObject({ total: 2, written: 4, strings: 6 })
  })

  it('pages past the 1000-row cap, so a company first seen on the second page still runs', async () => {
    range
      .mockResolvedValueOnce({ data: Array.from({ length: 1000 }, () => ({ company_id: 'a' })), error: null })
      .mockResolvedValueOnce({ data: [{ company_id: 'b' }], error: null })
    resolveCompanyCounterparts.mockImplementation(async (_s: unknown, companyId: string) => ({
      companyId, strings: 0, alreadyResolved: 0, planned: 0, byBand: { link: 0, tentative: 0, nil: 0 }, bySource: {}, modelLines: 0, verified: 0, promoted: 0, written: 0,
    }))
    const { body } = await parseJsonResponse<{ total: number }>(await GET(createMockRequest('http://localhost/api/parties/resolver/cron')))
    expect(range).toHaveBeenNthCalledWith(1, 0, 999)
    expect(range).toHaveBeenNthCalledWith(2, 1000, 1999)
    expect(resolveCompanyCounterparts.mock.calls.map((c) => c[1])).toEqual(['a', 'b'])
    expect(body.total).toBe(2)
  })

  it('reports a failed company listing without leaking the error text', async () => {
    range.mockResolvedValueOnce({ data: null, error: { message: 'relation missing' } })
    const { status, body } = await parseJsonResponse<{ failed: boolean }>(await GET(createMockRequest('http://localhost/api/parties/resolver/cron')))
    expect(status).toBe(500)
    expect(body.failed).toBe(true)
    expect(JSON.stringify(body)).not.toContain('relation missing')
  })
})
