import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { createClient } from '@/lib/supabase/server'
import { PATCH } from '../route'

// Refusals answer the canonical { error: { code, message, details } } envelope
// since the rules moved to lib/core/bookkeeping/fiscal-year-service.ts (they
// used to be bare Swedish strings in { error }): the Swedish sentence is now
// error.message.

function patchRequest(body: unknown): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/period-1', {
    method: 'PATCH',
    body,
  })
}

/**
 * Mocks the chain of supabase calls the PATCH route makes:
 *   1. from('fiscal_periods').select('*').eq.eq.single()        → existing period (null = 404)
 *   2. from('fiscal_periods').select(count, head).eq.neq.lt()   → earlier-period count
 *   3. from('companies').select('entity_type').eq.single()      → entity type
 *   4. from('fiscal_periods').select('id, name').eq.neq.lte.gte.limit() → overlap
 *   5. rpc('redate_fiscal_period', …)                           → the guarded re-date
 *   6. from('fiscal_periods').update().eq.eq.select.single()    → renamed row (name only)
 */
type MockPeriod = { id: string; period_start: string; period_end: string; locked_at: string | null; is_closed: boolean; name?: string }

function buildMockSupabase(options: {
  user?: { id: string } | null
  period?: MockPeriod | null
  entityType?: 'aktiebolag' | 'enskild_firma'
  earlierPeriodCount?: number
  overlapping?: Array<{ id: string; name: string }>
  /** The company's other years, for the contiguity check on re-dating. */
  neighbours?: Array<{ id: string; period_start: string; period_end: string }>
  /** What redate_fiscal_period answers; defaults to a successful move. */
  rpcResult?: { data: unknown; error: unknown }
}) {
  const {
    user = { id: 'user-1' },
    period = { id: 'p1', period_start: '2020-01-01', period_end: '2020-12-31', locked_at: null, is_closed: false },
    entityType = 'enskild_firma',
    earlierPeriodCount = 0,
    overlapping = [],
    neighbours = [],
    rpcResult = { data: { ok: true, changed: true, period }, error: null },
  } = options

  let fiscalPeriodsCall = 0

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) },
    },
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn().mockImplementation((table: string) => {
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
                  order: vi.fn().mockResolvedValue({ data: neighbours, error: null }),
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
      expect(body.error.code).toBe('FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR')
      expect(body.error.message).toMatch(/31 december/)
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
      expect(body.error.code).toBe('FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR')
      expect(body.error.message).toMatch(/kalenderår/)
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
      expect(body.error.code).toBe('FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR')
      expect(body.error.message).toMatch(/31 december/)
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
      expect(body.error.code).toBe('FISCAL_PERIOD_TOO_LONG')
      expect(body.error.details.months).toBe(24)
    })
  })

  describe('contiguity (BFNAR 2013:2)', () => {
    const LATEST = { id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false }
    const PREVIOUS = { id: 'p1', period_start: '2025-01-01', period_end: '2025-12-31' }

    it('refuses re-dating that opens a gap after the preceding year', async () => {
      buildMockSupabase({ period: LATEST, entityType: 'aktiebolag', earlierPeriodCount: 1, neighbours: [PREVIOUS] })
      const res = await PATCH(
        patchRequest({ period_start: '2026-02-01', period_end: '2026-12-31' }),
        createMockRouteParams({ id: 'p2' }),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('FISCAL_PERIOD_NOT_CONTIGUOUS')
      expect(body.error.details.expected_start).toBe('2026-01-01')
    })

    it('lets the latest year move its end date', async () => {
      buildMockSupabase({ period: LATEST, entityType: 'aktiebolag', earlierPeriodCount: 1, neighbours: [PREVIOUS] })
      const res = await PATCH(
        patchRequest({ period_start: '2026-01-01', period_end: '2027-06-30' }),
        createMockRouteParams({ id: 'p2' }),
      )
      expect(res.status).toBe(200)
    })

    it('refuses moving an end date away from the following year', async () => {
      buildMockSupabase({
        period: { id: 'p1', period_start: '2025-01-01', period_end: '2025-12-31', locked_at: null, is_closed: false },
        entityType: 'aktiebolag',
        neighbours: [{ id: 'p2', period_start: '2026-01-01', period_end: '2026-12-31' }],
      })
      const res = await PATCH(
        patchRequest({ period_start: '2025-01-01', period_end: '2025-11-30' }),
        createMockRouteParams({ id: 'p1' }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error.details.expected_end).toBe('2025-12-31')
    })
  })

  // crm#1010: a first year recorded from 2025-04-24 while Bolagsverket
  // registered the company on 2025-04-23, with verifikat already posted.
  // What the year holds is decided by redate_fiscal_period (pg-real tests in
  // tests/pg/redate-fiscal-period.pg.test.ts); the route maps its verdict.
  describe('a year that holds verifikat (crm#1010)', () => {
    const FIRST_YEAR: MockPeriod = {
      id: 'p1',
      period_start: '2025-04-24',
      period_end: '2026-08-31',
      locked_at: null,
      is_closed: false,
      name: 'Räkenskapsår 2025/2026',
    }

    it('moves the start one day earlier through redate_fiscal_period', async () => {
      const moved = { ...FIRST_YEAR, period_start: '2025-04-23' }
      const supabase = buildMockSupabase({
        period: FIRST_YEAR,
        entityType: 'aktiebolag',
        rpcResult: { data: { ok: true, changed: true, period: moved }, error: null },
      })

      const res = await PATCH(patchRequest({ period_start: '2025-04-23' }), createMockRouteParams({ id: 'p1' }))

      expect(res.status).toBe(200)
      expect((await res.json()).data.period_start).toBe('2025-04-23')
      expect(supabase.rpc).toHaveBeenCalledWith('redate_fiscal_period', {
        p_company_id: 'company-1',
        p_period_id: 'p1',
        p_period_start: '2025-04-23',
        p_period_end: '2026-08-31',
        p_name: null,
        p_dry_run: false,
        p_user_id: 'user-1',
      })
    })

    it('answers 409 FISCAL_PERIOD_DATES_BLOCKED, naming every blocker in Swedish', async () => {
      buildMockSupabase({
        period: FIRST_YEAR,
        entityType: 'aktiebolag',
        rpcResult: {
          data: {
            ok: false,
            code: 'FISCAL_PERIOD_DATES_BLOCKED',
            blockers: [
              {
                code: 'entries_outside',
                message_sv: 'En bokförd verifikation ligger utanför de nya datumen: A1 (2025-04-24).',
                count: 1,
              },
              {
                code: 'company_lock_date',
                message_sv:
                  'Bokföringen är låst t.o.m. 2025-06-30 och ändringen rör dagar i den låsta delen. Flytta låsdatumet först.',
              },
            ],
          },
          error: null,
        },
      })

      const res = await PATCH(patchRequest({ period_start: '2025-05-01' }), createMockRouteParams({ id: 'p1' }))

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error.code).toBe('FISCAL_PERIOD_DATES_BLOCKED')
      expect(body.error.message).toBe(
        'Datumen kan inte ändras. En bokförd verifikation ligger utanför de nya datumen: A1 (2025-04-24). ' +
          'Bokföringen är låst t.o.m. 2025-06-30 och ändringen rör dagar i den låsta delen. Flytta låsdatumet först.',
      )
      expect(body.error.details.blockers.map((b: { code: string }) => b.code)).toEqual([
        'entries_outside',
        'company_lock_date',
      ])
    })

    it('answers 403 when the RPC does not recognise the caller as a writing member', async () => {
      buildMockSupabase({
        period: FIRST_YEAR,
        entityType: 'aktiebolag',
        rpcResult: { data: { ok: false, code: 'FORBIDDEN' }, error: null },
      })

      const res = await PATCH(patchRequest({ period_start: '2025-04-23' }), createMockRouteParams({ id: 'p1' }))

      expect(res.status).toBe(403)
      expect((await res.json()).error.code).toBe('FORBIDDEN')
    })

    it('answers 500 FISCAL_PERIOD_UPDATE_FAILED when the RPC itself fails', async () => {
      buildMockSupabase({
        period: FIRST_YEAR,
        entityType: 'aktiebolag',
        rpcResult: { data: null, error: { message: 'connection reset' } },
      })

      const res = await PATCH(patchRequest({ period_start: '2025-04-23' }), createMockRouteParams({ id: 'p1' }))

      expect(res.status).toBe(500)
      expect((await res.json()).error.code).toBe('FISCAL_PERIOD_UPDATE_FAILED')
    })

    it('a rename that sends the unchanged dates never runs the re-date', async () => {
      const supabase = buildMockSupabase({ period: FIRST_YEAR, entityType: 'aktiebolag' })

      const res = await PATCH(
        patchRequest({ name: 'Första räkenskapsåret', period_start: '2025-04-24', period_end: '2026-08-31' }),
        createMockRouteParams({ id: 'p1' }),
      )

      expect(res.status).toBe(200)
      expect(supabase.rpc).not.toHaveBeenCalled()
    })
  })
})
