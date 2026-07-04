import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

describe('GET /api/transactions', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const originalFrom = mockSupabase.from

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.from = originalFrom
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns transactions for the active company with has_more=false when below the cap', async () => {
    const txs = [
      makeTransaction({ id: 'tx-1', amount: -100 }),
      makeTransaction({ id: 'tx-2', amount: 250 }),
    ]
    enqueue({ data: txs, error: null })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof txs
      has_more: boolean
      limit: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('tx-1')
    expect(body.has_more).toBe(false)
    expect(body.limit).toBe(500)
  })

  it('signals has_more=true and truncates to the cap when more rows exist', async () => {
    // Server requests MAX_ROWS+1 = 501 rows; if the DB returns 501 we know there's more.
    const txs = Array.from({ length: 501 }, (_, i) =>
      makeTransaction({ id: `tx-${i}`, amount: i }),
    )
    enqueue({ data: txs, error: null })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof txs
      has_more: boolean
      limit: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(500)
    expect(body.has_more).toBe(true)
    expect(body.limit).toBe(500)
  })

  it('filters by unmatched=true', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest('/api/transactions?unmatched=true')
    await GET(request)

    expect(fromSpy).toHaveBeenCalledWith('transactions')
    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const isCall = chain.__calls.find((c) => c.method === 'is')
    expect(isCall).toEqual({ method: 'is', args: ['journal_entry_id', null] })
  })

  it('filters by reconciled=true', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest('/api/transactions?reconciled=true')
    await GET(request)

    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const notCall = chain.__calls.find((c) => c.method === 'not')
    expect(notCall).toEqual({ method: 'not', args: ['journal_entry_id', 'is', null] })
    // unmatched and reconciled are mutually exclusive: when reconciled is set, no .is() filter
    const isCall = chain.__calls.find((c) => c.method === 'is')
    expect(isCall).toBeUndefined()
  })

  it('applies currency, date_from, and date_to filters', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest(
      '/api/transactions?currency=SEK&date_from=2024-01-01&date_to=2024-12-31'
    )
    await GET(request)

    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const eqCalls = chain.__calls.filter((c) => c.method === 'eq')
    // company_id and currency
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['company_id', 'company-1'] },
        { method: 'eq', args: ['currency', 'SEK'] },
      ])
    )
    expect(chain.__calls).toEqual(
      expect.arrayContaining([
        { method: 'gte', args: ['date', '2024-01-01'] },
        { method: 'lte', args: ['date', '2024-12-31'] },
      ])
    )
  })

  it('returns 500 when the query errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('boom')
  })
})
