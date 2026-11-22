/**
 * The Resultatrapport and the Balansrapport (JSON and xlsx doors) read the
 * fiscal period scoped to the active company. A period_id that is not that
 * company's (a page still holding the previous company's year right after a
 * company switch) used to fall through to the generator, whose 'Fiscal period
 * not found' became an unlogged 500. It is a stale request, not a failure: a
 * structured 404 PERIOD_NOT_FOUND, logged at warn, and no report is generated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))
vi.mock('@/lib/reports/resultatrapport', () => ({ generateResultatrapport: vi.fn() }))
vi.mock('@/lib/reports/balansrapport', () => ({ generateBalansrapport: vi.fn() }))

// Every line the route logs, with its level: the test environment prints
// errors only, and the level is the point here.
const logged = vi.hoisted(() => [] as { level: 'info' | 'warn' | 'error'; text: string }[])
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  type Logger = ReturnType<typeof actual.createLogger>
  const text = (msg: string, args: unknown[]) =>
    [msg, ...args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a)))].join(' ')
  const wrap = (inner: Logger): Logger => ({
    info: (msg, ...args) => {
      logged.push({ level: 'info', text: text(msg, args) })
      inner.info(msg, ...args)
    },
    warn: (msg, ...args) => {
      logged.push({ level: 'warn', text: text(msg, args) })
      inner.warn(msg, ...args)
    },
    error: (msg, ...args) => {
      logged.push({ level: 'error', text: text(msg, args) })
    },
    child: (extra) => wrap(inner.child(extra)),
  })
  return { ...actual, createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => wrap(actual.createLogger(module, base)) }
})

import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { GET as resultatJson } from '../resultatrapport/route'
import { GET as resultatXlsx } from '../resultatrapport/xlsx/route'
import { GET as balansJson } from '../balansrapport/route'
import { GET as balansXlsx } from '../balansrapport/xlsx/route'

const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
// The least each door renders: no rows, the period, nothing to disclose.
const RESULTAT = { groups: [], net_result_current: 0, net_result_prior: 0, period: { start: '2026-01-01', end: '2026-12-31' }, prior_period: null }
const BALANS = { groups: [], beraknat_resultat: 0, differens: 0, period: { start: '2026-01-01', end: '2026-12-31' } }

/**
 * Each door's reads before the generator, in call order; `period` is the
 * fiscal_periods row the company-scoped read returns.
 */
const DOORS = [
  {
    door: 'resultatrapport',
    report: RESULTAT,
    get: resultatJson,
    generator: vi.mocked(generateResultatrapport),
    reads: (period: unknown) => [{ data: period }],
  },
  {
    door: 'resultatrapport/xlsx',
    report: RESULTAT,
    get: resultatXlsx,
    generator: vi.mocked(generateResultatrapport),
    reads: (period: unknown) => [{ data: { company_name: 'Test AB' } }, { data: period }],
  },
  {
    door: 'balansrapport',
    report: BALANS,
    get: balansJson,
    generator: vi.mocked(generateBalansrapport),
    reads: (period: unknown) => [{ data: period }],
  },
  {
    door: 'balansrapport/xlsx',
    report: BALANS,
    get: balansXlsx,
    generator: vi.mocked(generateBalansrapport),
    reads: (period: unknown) => [{ data: { company_name: 'Test AB' } }, { data: period }],
  },
] as const

const call = (door: (typeof DOORS)[number], query: Record<string, string>) =>
  door.get(createMockRequest(`/api/reports/${door.door}`, { searchParams: query }), noParams)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  // The generators read the period scoped by company too, and throw this for
  // one that is not the company's (lib/reports/{resultat,balans}rapport.ts).
  vi.mocked(generateResultatrapport).mockRejectedValue(new Error('Fiscal period not found'))
  vi.mocked(generateBalansrapport).mockRejectedValue(new Error('Fiscal period not found'))
  logged.length = 0
})

const lines = (level: 'warn' | 'error') =>
  logged
    .filter((l) => l.level === level)
    .map((l) => l.text)
    .join('\n')

describe.each(DOORS)('GET /api/reports/$door', (door) => {
  it('401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await call(door, { period_id: 'p1' })
    expect(res.status).toBe(401)
    expect(door.generator).not.toHaveBeenCalled()
  })

  it('400 without a period_id', async () => {
    const res = await call(door, {})
    expect(res.status).toBe(400)
    expect(door.generator).not.toHaveBeenCalled()
  })

  it("404 PERIOD_NOT_FOUND for a period that is not the active company's, logged at warn", async () => {
    for (const read of door.reads(null)) enqueue(read)
    const res = await call(door, { period_id: 'period-of-the-previous-company' })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_NOT_FOUND')
    // No report is generated from a period the company does not own.
    expect(door.generator).not.toHaveBeenCalled()
    expect(lines('warn')).toContain('PERIOD_NOT_FOUND')
    expect(lines('error')).toBe('')
    // The read is the active company's: RLS on fiscal_periods admits every
    // company the user is a member of, so this filter is what keeps the
    // previous company's period out.
    expect(findCalls('fiscal_periods', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'period-of-the-previous-company'],
        ['company_id', 'company-1'],
      ]),
    )
  })

  it('a failed period read is a logged 5xx, never a 404', async () => {
    const reads = door.reads(null)
    for (const read of reads.slice(0, -1)) enqueue(read)
    enqueue({ data: null, error: new Error('fetch failed') })
    const res = await call(door, { period_id: 'p1' })
    // errorResponse's own mapping: a network failure is a transient 503.
    expect(res.status).toBe(503)
    expect(door.generator).not.toHaveBeenCalled()
    expect(lines('error')).toContain('fetch failed')
  })

  it("generates the report from the active company's own period", async () => {
    for (const read of door.reads(PERIOD)) enqueue(read)
    door.generator.mockResolvedValue(door.report as never)
    const res = await call(door, { period_id: 'p1', from_date: '2026-01-01', to_date: '2026-06-30' })
    expect(res.status).toBe(200)
    expect(door.generator).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'p1',
      expect.objectContaining({ fromDate: '2026-01-01', toDate: '2026-06-30' }),
    )
  })

  it('a generation failure on an owned period is still a 500, and logged at error', async () => {
    for (const read of door.reads(PERIOD)) enqueue(read)
    door.generator.mockRejectedValue(new Error('connection reset'))
    const res = await call(door, { period_id: 'p1' })
    expect(res.status).toBe(500)
    expect(lines('error')).toContain('connection reset')
  })
})
