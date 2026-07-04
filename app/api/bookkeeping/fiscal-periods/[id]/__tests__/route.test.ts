import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

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
import { PATCH } from '../route'

function patchRequest(body: unknown): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/period-1', {
    method: 'PATCH',
    body,
  })
}

/**
 * Mocks the chain of supabase calls the PATCH route makes:
 *   1. from('fiscal_periods').select('*').eq.eq.single()        → existing period (null = 404)
 *   2. from('journal_entries').select(count, head).eq.eq.in()   → posted entry count
 *   3. from('fiscal_periods').select(count, head).eq.neq.lt()   → earlier-period count
 *   4. from('companies').select('entity_type').eq.single()      → entity type
 *   5. from('fiscal_periods').select('id, name').eq.neq.lte.gte.limit() → overlap
 *   6. from('fiscal_periods').update().eq.eq.select.single()    → updated row
 */
function buildMockSupabase(options: {
  user?: { id: string } | null
  period?: { id: string; period_start: string; period_end: string; locked_at: string | null; is_closed: boolean } | null
  entityType?: 'aktiebolag' | 'enskild_firma'
  postedEntryCount?: number
  earlierPeriodCount?: number
  overlapping?: Array<{ id: string; name: string }>
}) {
  const {
    user = { id: 'user-1' },
    period = { id: 'p1', period_start: '2020-01-01', period_end: '2020-12-31', locked_at: null, is_closed: false },
    entityType = 'enskild_firma',
    postedEntryCount = 0,
    earlierPeriodCount = 0,
    overlapping = [],
  } = options

  let fiscalPeriodsCall = 0

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'journal_entries') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ count: postedEntryCount, error: null }),
              }),
            }),
          }),
        }
      }

      if (table === 'companies') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { entity_type: entityType }, error: null }),
            }),
          }),
        }
      }

      if (table === 'fiscal_periods') {
        fiscalPeriodsCall++
        const callNum = fiscalPeriodsCall

        return {
          select: vi.fn().mockImplementation((_sel: string, opts?: { count?: string; head?: boolean }) => {
            if (callNum === 1) {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: period,
                      error: period ? null : { message: 'not found' },
                    }),
                  }),
                }),
              }
            }
            if (opts?.head) {
              return {
                eq: vi.fn().mockReturnValue({
                  neq: vi.fn().mockReturnValue({
                    lt: vi.fn().mockResolvedValue({ count: earlierPeriodCount, error: null }),
                  }),
                }),
              }
            }
            return {
              eq: vi.fn().mockReturnValue({
                neq: vi.fn().mockReturnValue({
                  lte: vi.fn().mockReturnValue({
                    gte: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({ data: overlapping, error: null }),
                    }),
                  }),
                }),
              }),
            }
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: period, error: null }),
                }),
              }),
            }),
          }),
        }
      }

      return {}
    }),
  }

  ;(createClient as ReturnType<typeof vi.fn>).mockResolvedValue(supabase)
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PATCH /api/bookkeeping/fiscal-periods/[id]', () => {
  describe('standard guards', () => {
    it('returns 401 when not authenticated', async () => {
      buildMockSupabase({ user: null })
      const res = await PATCH(patchRequest({ period_end: '2020-12-31' }), createMockRouteParams({ id: 'p1' }))
      expect(res.status).toBe(401)
    })

    it('returns 400 when body is malformed', async () => {
      buildMockSupabase({})
      const res = await PATCH(patchRequest({ period_start: 'not-a-date' }), createMockRouteParams({ id: 'p1' }))
      expect(res.status).toBe(400)
    })

    it('returns 404 when period does not exist', async () => {
      buildMockSupabase({ period: null })
      const res = await PATCH(patchRequest({ period_end: '2020-12-31' }), createMockRouteParams({ id: 'missing' }))
      expect(res.status).toBe(404)
    })
  })

  describe('enskild firma: BFL 3 kap.', () => {
    it('allows förlängt räkenskapsår (15 mån, 4 okt 2020 → 31 dec 2021) on the first period', async () => {
      buildMockSupabase({ earlierPeriodCount: 0 })
      const res = await PATCH(
        patchRequest({ period_start: '2020-10-04', period_end: '2021-12-31' }),
        createMockRouteParams({ id: 'p1' }),
      )
      expect(res.status).toBe(200)
    })

    it('rejects EF first period when slutdatum is not 31 december', async () => {
      buildMockSupabase({ earlierPeriodCount: 0 })
      const res = await PATCH(
        patchRequest({ period_start: '2020-10-04', period_end: '2021-11-30' }),
        createMockRouteParams({ id: 'p1' }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/31 december/)
    })

    it('rejects EF subsequent period when startdatum is not 1 januari', async () => {
      buildMockSupabase({
        period: { id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false },
        earlierPeriodCount: 1,
      })
      const res = await PATCH(
        patchRequest({ period_start: '2026-02-01', period_end: '2026-12-31' }),
        createMockRouteParams({ id: 'p2' }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/kalenderår/)
    })

    it('accepts EF subsequent period running 1 jan to 31 dec', async () => {
      buildMockSupabase({
        period: { id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false },
        earlierPeriodCount: 1,
      })
      const res = await PATCH(
        patchRequest({ period_start: '2026-01-01', period_end: '2026-12-31' }),
        createMockRouteParams({ id: 'p2' }),
      )
      expect(res.status).toBe(200)
    })

    // Locks in the implicit "EF subsequent period is always exactly 12 months"
    // rule. The start-must-be-1-jan + end-must-be-31-dec guards together force
    // a 12-month span; this test catches a future refactor that loosens either.
    it('rejects EF subsequent period when slutdatum is not 31 december', async () => {
      buildMockSupabase({
        period: { id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false },
        earlierPeriodCount: 1,
      })
      const res = await PATCH(
        patchRequest({ period_start: '2026-01-01', period_end: '2027-01-31' }),
        createMockRouteParams({ id: 'p2' }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/31 december/)
    })

    // Defense-in-depth: the EF end-date guard runs before validatePeriodDuration.
    // A 24-month first period (2020-01-01 → 2021-12-31) ends on 31 dec, so the EF
    // guard passes: duration validation must catch it as BFL 3 kap. caps the
    // first period at 18 months.
    it('rejects a 24-month first period via the duration cap', async () => {
      buildMockSupabase({ earlierPeriodCount: 0 })
      const res = await PATCH(
        patchRequest({ period_start: '2020-01-01', period_end: '2021-12-31' }),
        createMockRouteParams({ id: 'p1' }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/18 months/)
    })
  })
})
