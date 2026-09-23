import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  makeJournalEntry,
} from '@/tests/helpers'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

function buildMockSupabase({
  user = { id: 'user-1', email: 'test@test.se' },
  singleResult = null as ReturnType<typeof makeJournalEntry> | null,
  singleError = null as { message: string } | null,
  referencingIds = [] as { id: string }[],
  chainEntries = [] as ReturnType<typeof makeJournalEntry>[],
} = {}) {
  const fromCalls: string[] = []

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    fromCalls.push(table)
    const callIndex = fromCalls.length

    const builder: Record<string, ReturnType<typeof vi.fn>> = {}
    const chainFn = (name: string) => {
      builder[name] = vi.fn().mockReturnValue(builder)
      return builder[name]
    }

    chainFn('select')
    chainFn('eq')
    chainFn('or')
    chainFn('in')
    chainFn('order')
    chainFn('limit')

    // First call: single entry fetch (the main entry)
    if (callIndex === 1) {
      builder.single = vi.fn().mockResolvedValue({
        data: singleResult,
        error: singleError,
      })
    }

    // Second call: reverse lookup for referencing entries
    if (callIndex === 2) {
      const orResult = { data: referencingIds }
      builder.or = vi.fn().mockResolvedValue(orResult)
    }

    // Third+ calls: chain entries fetch or is_last_in_series check
    if (callIndex >= 3) {
      builder.order = vi.fn().mockReturnValue(builder)
      builder.single = vi.fn().mockResolvedValue({
        data: singleResult ? { voucher_number: singleResult.voucher_number } : null,
      })
      // Also handle when .order resolves directly (chain entries fetch)
      const orderResult = { data: chainEntries }
      builder.order = vi.fn().mockImplementation(() => {
        const obj = { ...builder, ...orderResult }
        obj.then = (fn: (v: unknown) => void) => Promise.resolve(fn(orderResult))
        // Support both .limit().single() and direct resolution
        obj.limit = vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: singleResult ? { voucher_number: singleResult.voucher_number } : null,
          }),
        })
        return obj
      })
    }

    return builder
  })

  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: mockFrom,
  }
}

describe('GET /api/bookkeeping/journal-entries/[id]/chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    })

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/chain')
    const response = await GET(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when entry not found', async () => {
    mockCreateClient.mockResolvedValue(
      buildMockSupabase({ singleError: { message: 'not found' } })
    )

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/chain')
    const response = await GET(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Entry not found' })
  })

  it('returns entry with empty chain for standalone entry', async () => {
    const entry = makeJournalEntry({ id: 'entry-1', status: 'posted' })
    mockCreateClient.mockResolvedValue(
      buildMockSupabase({ singleResult: entry, referencingIds: [] })
    )

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/chain')
    const response = await GET(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: { entry: unknown; chain: unknown[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.entry).toEqual(entry)
    expect(body.data.chain).toEqual([])
  })

  it('returns entry with chain for corrected entry', async () => {
    const original = makeJournalEntry({
      id: 'entry-1',
      status: 'reversed',
      reversed_by_id: 'storno-1',
    })
    const storno = makeJournalEntry({
      id: 'storno-1',
      source_type: 'storno',
      reverses_id: 'entry-1',
    })
    const correction = makeJournalEntry({
      id: 'correction-1',
      source_type: 'correction',
      correction_of_id: 'entry-1',
    })

    mockCreateClient.mockResolvedValue(
      buildMockSupabase({
        singleResult: original,
        referencingIds: [{ id: 'storno-1' }, { id: 'correction-1' }],
        chainEntries: [storno, correction],
      })
    )

    const request = createMockRequest('/api/bookkeeping/journal-entries/entry-1/chain')
    const response = await GET(request, createMockRouteParams({ id: 'entry-1' }))
    const { status, body } = await parseJsonResponse<{ data: { entry: unknown; chain: unknown[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.entry).toEqual(original)
    expect(body.data.chain).toHaveLength(2)
  })
})
