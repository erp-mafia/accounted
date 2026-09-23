import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase
const mockFrom = vi.fn()
const mockRpc = vi.fn()
const mockAuth = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { getUser: () => mockAuth() },
  }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'

function mockChain(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'insert', 'update', 'upsert', 'order', 'limit', 'single', 'maybeSingle']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  // Make the chain thenable so await resolves to result
  chain.then = (resolve: (v: unknown) => void) => resolve(result)
  return chain
}

function makeRequest(url: string, options?: RequestInit) {
  return new Request(url, options)
}

async function parseJson(response: Response) {
  return response.json()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/bookkeeping/voucher-gaps', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps?fiscal_period_id=fp-1')
    const response = await GET(request)
    const body = await parseJson(response)

    expect(response.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 when fiscal_period_id is missing', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps')
    const response = await GET(request)

    expect(response.status).toBe(400)
  })

  it('returns empty result when no voucher sequences exist', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mockFrom.mockReturnValue(mockChain({ data: [], error: null }))

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps?fiscal_period_id=f47ac10b-58cc-4372-a567-0e02b2c3d479')
    const response = await GET(request)
    const body = await parseJson(response)

    expect(response.status).toBe(200)
    expect(body.data.gaps).toEqual([])
    expect(body.data.totalGaps).toBe(0)
    expect(body.data.unexplainedGaps).toBe(0)
  })

  it('returns gaps with explanations', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    let fromCallCount = 0
    mockFrom.mockImplementation(() => {
      fromCallCount++
      if (fromCallCount === 1) {
        // voucher_sequences query
        return mockChain({ data: [{ voucher_series: 'A' }], error: null })
      }
      if (fromCallCount === 2) {
        // gap_explanations query
        return mockChain({
          data: [{ id: 'exp-1', voucher_series: 'A', gap_start: 3, gap_end: 3, explanation: 'Transient error', user_id: 'user-1', created_at: '2026-01-01' }],
          error: null,
        })
      }
      return mockChain({ data: null, error: null })
    })

    mockRpc.mockResolvedValue({
      data: [{ gap_start: 3, gap_end: 3 }],
      error: null,
    })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps?fiscal_period_id=f47ac10b-58cc-4372-a567-0e02b2c3d479')
    const response = await GET(request)
    const body = await parseJson(response)

    expect(response.status).toBe(200)
    expect(body.data.totalGaps).toBe(1)
    expect(body.data.unexplainedGaps).toBe(0)
    expect(body.data.gaps[0].explanation).toBeTruthy()
    expect(body.data.gaps[0].explanation.explanation).toBe('Transient error')
  })

  it('returns unexplained gaps', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    let fromCallCount = 0
    mockFrom.mockImplementation(() => {
      fromCallCount++
      if (fromCallCount === 1) {
        return mockChain({ data: [{ voucher_series: 'A' }], error: null })
      }
      if (fromCallCount === 2) {
        return mockChain({ data: [], error: null })
      }
      return mockChain({ data: null, error: null })
    })

    mockRpc.mockResolvedValue({
      data: [{ gap_start: 5, gap_end: 7 }],
      error: null,
    })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps?fiscal_period_id=f47ac10b-58cc-4372-a567-0e02b2c3d479')
    const response = await GET(request)
    const body = await parseJson(response)

    expect(response.status).toBe(200)
    expect(body.data.totalGaps).toBe(1)
    expect(body.data.unexplainedGaps).toBe(1)
    expect(body.data.gaps[0].explanation).toBeNull()
  })
})

describe('POST /api/bookkeeping/voucher-gaps', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_period_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gap_start: 5,
        gap_end: 7,
        explanation: 'Transient DB error during commit',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request)

    expect(response.status).toBe(401)
  })

  it('returns 400 when explanation is empty', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_period_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gap_start: 5,
        gap_end: 7,
        explanation: '',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request)

    expect(response.status).toBe(400)
  })

  it('saves gap explanation successfully', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const savedRow = {
      id: 'exp-1',
      company_id: 'company-1',
      user_id: 'user-1',
      fiscal_period_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      voucher_series: 'A',
      gap_start: 5,
      gap_end: 7,
      explanation: 'Failed commit during bank sync',
      created_at: '2026-04-01',
      updated_at: '2026-04-01',
    }

    mockFrom.mockReturnValue(mockChain({ data: savedRow, error: null }))

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_period_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gap_start: 5,
        gap_end: 7,
        explanation: 'Failed commit during bank sync',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request)
    const body = await parseJson(response)

    expect(response.status).toBe(200)
    expect(body.data.explanation).toBe('Failed commit during bank sync')
  })

  it('returns 403 when user lacks permission', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockReturnValue(mockChain({ data: null, error: { code: '42501', message: 'permission denied' } }))

    const request = makeRequest('http://localhost/api/bookkeeping/voucher-gaps', {
      method: 'POST',
      body: JSON.stringify({
        fiscal_period_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        gap_start: 5,
        gap_end: 7,
        explanation: 'Test explanation',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request)
    const body = await parseJson(response)

    expect(response.status).toBe(403)
    expect(body.error).toContain('owners and admins')
  })
})
