import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { createClient } from '@/lib/supabase/server'
import { POST } from '../route'

function createMockRequest(body: unknown): Request {
  return new Request('http://localhost/api/bookkeeping/fiscal-periods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

type Period = { id: string; period_start: string; period_end: string; is_closed: boolean; name?: string }

/**
 * Build a mock supabase that tracks sequential from('fiscal_periods') calls
 * and returns the correct data based on the select() arguments.
 */
function buildMockSupabase(options: {
  user?: { id: string } | null
  allPeriods?: Period[]
  openPeriods?: Array<{ id?: string; name: string; period_start: string; period_end: string }>
  bookkeepingLockedThrough?: string | null
  overlapping?: Array<{ id: string; name: string }>
  insertResult?: { data: unknown; error: unknown }
}) {
  const {
    user = { id: 'user-1' },
    allPeriods = [],
    openPeriods = [],
    bookkeepingLockedThrough = null,
    overlapping = [],
    insertResult = { data: { id: 'new-period', name: 'FY 2025' }, error: null },
  } = options

  // Track from() calls to fiscal_periods
  let fpCallIndex = 0

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'company_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { bookkeeping_locked_through: bookkeepingLockedThrough },
                error: null,
              }),
            }),
          }),
        }
      }
      fpCallIndex++
      const callNum = fpCallIndex

      // Build a chainable object that resolves differently based on the call chain
      const chainable: Record<string, unknown> = {}

      // For the allPeriods query (call 1): .select('id, period_start, ...').eq(...).order(...)
      // For openPeriods query (call 2): .select('name, period_start, period_end').eq(...).eq(...).is(...).order(...)
      // For overlap query (call 3): .select('id, name').eq(...).lte(...).gte(...).limit(...)
      // For insert (call 4): .insert(...).select().single()
      // For update (call 5): .update(...).eq(...).eq(...)

      chainable.select = vi.fn().mockImplementation((sel: string) => {
        if (sel.includes('name') && sel.includes('period_start')) {
          // openPeriods query: .eq(company_id).eq(is_closed=false).is(locked_at, null).order(...)
          return {
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({ data: openPeriods, error: null }),
                }),
              }),
            }),
          }
        }

        if (callNum === 1) {
          // allPeriods query
          return {
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: allPeriods, error: null }),
            }),
          }
        }

        // overlap query or any other select
        return {
          eq: vi.fn().mockReturnValue({
            lte: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: overlapping, error: null }),
              }),
            }),
            order: vi.fn().mockResolvedValue({ data: allPeriods, error: null }),
          }),
        }
      })

      chainable.insert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(insertResult),
        }),
      })

      chainable.update = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      })

      return chainable
    }),
  }

  ;(createClient as ReturnType<typeof vi.fn>).mockResolvedValue(supabase)
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/bookkeeping/fiscal-periods', () => {
  it('returns 401 when not authenticated', async () => {
    buildMockSupabase({ user: null })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('creates first period successfully', async () => {
    buildMockSupabase({ allPeriods: [] })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeDefined()
  })

  it('rejects overlapping periods', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: true }],
      overlapping: [{ id: 'p1', name: 'FY 2024' }],
    })
    // Forward chain from 2024, start = 2025-01-01
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/Overlaps/)
  })

  it('rejects forward period with wrong start date', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true }],
    })
    const req = createMockRequest({ name: 'FY 2026', period_start: '2026-02-01', period_end: '2026-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/must start on 2026-01-01/)
  })

  it('rejects forward period when an unlocked open period exists and returns it as a blocking period', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false }],
      openPeriods: [{ id: 'p1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' }],
    })
    const req = createMockRequest({ name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const body = await res.json()
    // Canonical envelope with a machine code + the blocking periods so the
    // dialog can offer to lock them inline.
    expect(body.error.code).toBe('PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS')
    expect(body.error.message).toMatch(/låsa föregående räkenskapsår/)
    expect(body.error.details.blockingPeriods).toEqual([
      { id: 'p1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    ])
  })

  // Regression: BFL 6 kap allows löpande bokföring of the new year in parallel
  // with bokslut work on the prior year (6-month deadline for årsbokslut, 7
  // months for AB årsredovisning). A locked-but-not-yet-closed prior period is
  // the normal state during that window and must not block creation of the
  // next räkenskapsår. The .is('locked_at', null) filter excludes locked
  // periods from openPeriods, so the mock returns [] here.
  it('allows forward period creation when prior period is locked-but-not-closed', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false }],
      openPeriods: [],
      overlapping: [],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeDefined()
  })

  // Regression: a real user (Egon Johansson, 2026-04-27) set the company-wide
  // bookkeeping_locked_through to 2024-12-31 but never set locked_at on the
  // FY 2024 period. From their perspective and from the enforce_company_lock_date
  // trigger's perspective, the period is locked. The creation check must agree.
  it('allows forward period creation when prior period is covered by company-wide lock-through', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false }],
      openPeriods: [{ name: 'Räkenskapsår 2024', period_start: '2024-01-01', period_end: '2024-12-31' }],
      bookkeepingLockedThrough: '2024-12-31',
      overlapping: [],
    })
    const req = createMockRequest({ name: 'Räkenskapsår 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toBeDefined()
  })

  // Partial coverage: lock-through covers only part of the period — must still block.
  it('rejects forward period creation when company-wide lock only partially covers prior period', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false }],
      openPeriods: [{ id: 'p1', name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' }],
      bookkeepingLockedThrough: '2024-06-30',
      overlapping: [],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS')
    expect(body.error.details.blockingPeriods).toEqual([
      { id: 'p1', name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' },
    ])
  })

  it('allows backward period creation', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }],
      overlapping: [],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('rejects backward period with wrong end date', async () => {
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-11-30' })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/must end on 2025-12-31/)
  })

  it('backward chaining skips unclosed period constraint', async () => {
    // There's an unclosed period (2026), but backward creation should still work
    buildMockSupabase({
      allPeriods: [{ id: 'p1', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }],
      openPeriods: [{ name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' }],
      overlapping: [],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('rejects period that is neither forward nor backward', async () => {
    buildMockSupabase({
      allPeriods: [
        { id: 'p1', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: true },
        { id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false },
      ],
    })
    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/must chain before the earliest or after the latest/)
  })

  it('rejects invalid period duration (> 18 months)', async () => {
    buildMockSupabase({ allPeriods: [] })
    const req = createMockRequest({ name: 'Long period', period_start: '2025-01-01', period_end: '2026-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/18 months/)
  })

  it('rejects invalid body', async () => {
    buildMockSupabase({})
    const req = createMockRequest({ name: '', period_start: 'bad', period_end: '2025-12-31' })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('sets previous_period_id when chaining forward', async () => {
    // Build a mock that captures the insert payload.
    const insertSpy = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'new-period', name: 'FY 2026' },
          error: null,
        }),
      }),
    })

    let fpCallIndex = 0
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'company_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { bookkeeping_locked_through: null },
                  error: null,
                }),
              }),
            }),
          }
        }
        fpCallIndex++
        const callNum = fpCallIndex
        return {
          select: vi.fn().mockImplementation((sel: string) => {
            if (sel.includes('name') && sel.includes('period_start')) {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    is: vi.fn().mockReturnValue({
                      order: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                }),
              }
            }
            if (callNum === 1) {
              return {
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({
                    data: [{ id: 'prior-period-id', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, closing_entry_id: null }],
                    error: null,
                  }),
                }),
              }
            }
            return {
              eq: vi.fn().mockReturnValue({
                lte: vi.fn().mockReturnValue({
                  gte: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
                }),
              }),
            }
          }),
          insert: insertSpy,
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
        }
      }),
    }
    ;(createClient as ReturnType<typeof vi.fn>).mockResolvedValue(supabase)

    const req = createMockRequest({ name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const insertArg = insertSpy.mock.calls[0][0]
    expect(insertArg.previous_period_id).toBe('prior-period-id')
    expect(insertArg.period_start).toBe('2026-01-01')
  })

  it('does not set previous_period_id for the first period', async () => {
    const insertSpy = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'new-period', name: 'FY 2025' },
          error: null,
        }),
      }),
    })

    let fpCallIndex = 0
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'company_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { bookkeeping_locked_through: null },
                  error: null,
                }),
              }),
            }),
          }
        }
        fpCallIndex++
        const callNum = fpCallIndex
        return {
          select: vi.fn().mockImplementation((sel: string) => {
            if (sel.includes('name') && sel.includes('period_start')) {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    is: vi.fn().mockReturnValue({
                      order: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                }),
              }
            }
            if (callNum === 1) {
              return {
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }
            }
            return {
              eq: vi.fn().mockReturnValue({
                lte: vi.fn().mockReturnValue({
                  gte: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) }),
                }),
              }),
            }
          }),
          insert: insertSpy,
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
        }
      }),
    }
    ;(createClient as ReturnType<typeof vi.fn>).mockResolvedValue(supabase)

    const req = createMockRequest({ name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy.mock.calls[0][0].previous_period_id).toBeNull()
  })
})
