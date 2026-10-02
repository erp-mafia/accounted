/**
 * The dimension value filter on the v1 reports (?dim_no=6&dim_code=P001).
 *
 * The web routes accept it on the P&L-safe reports through
 * lib/reports/dimension-filter.ts. Over v1 the income statement refused it
 * with 400 while the general ledger and the monthly breakdown silently
 * dropped it, answering the company's full report to a caller who believed
 * it filtered. Now the three P&L-safe v1 reports take the same parser and
 * disclose the partial view in the body (dimension_filter + partial_view);
 * the trial balance, like every statutory report, refuses the pair.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const mocks = vi.hoisted(() => ({
  generateIncomeStatement: vi.fn(),
  generateGeneralLedger: vi.fn(),
  generateMonthlyBreakdown: vi.fn(),
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/reports/income-statement', () => ({ generateIncomeStatement: mocks.generateIncomeStatement }))
vi.mock('@/lib/reports/general-ledger', () => ({ generateGeneralLedger: mocks.generateGeneralLedger }))
vi.mock('@/lib/reports/monthly-breakdown', () => ({ generateMonthlyBreakdown: mocks.generateMonthlyBreakdown }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: mocks.generateTrialBalance }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as incomeStatement } from '../income-statement/route'
import { GET as generalLedger } from '../general-ledger/route'
import { GET as monthlyBreakdown } from '../monthly-breakdown/route'
import { GET as trialBalance } from '../trial-balance/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ROW = {
  id: PERIOD_ID,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

/** company_members answers the owner; fiscal_periods answers `period`. */
function makeSupabase(period: unknown = PERIOD_ROW) {
  const build = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
          if (prop === 'maybeSingle' || prop === 'single') {
            const row =
              table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'fiscal_periods'
                  ? period
                  : null
            return () => Promise.resolve({ data: row, error: null })
          }
          return () => build(table)
        },
      },
    )
  return { from: vi.fn((table: string) => build(table)) }
}

type Handler = (req: Request, ctx: { params: Promise<{ companyId: string }> }) => Promise<Response>

function call(handler: Handler, report: string, query: string, { auth = true } = {}) {
  return handler(
    new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/${report}?${query}`, {
      headers: auth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )
}

const FILTER = `period_id=${PERIOD_ID}&dim_no=6&dim_code=P001`
const DISCLOSURE = 'Filtrerad (dimension 6: P001), ej fullständig rapport'

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase())
  mocks.generateIncomeStatement.mockResolvedValue({ revenue_sections: [], net_result: 1200, period: { start: '', end: '' } })
  mocks.generateGeneralLedger.mockResolvedValue({ accounts: [{ account_number: '3010', opening_balance: 0, lines: [] }], period: { start: '2026-01-01', end: '2026-12-31' } })
  mocks.generateMonthlyBreakdown.mockResolvedValue({ months: [{ month: '2026-01', net: 1200 }] })
})

describe.each([
  ['income-statement', incomeStatement as Handler, mocks.generateIncomeStatement],
  ['general-ledger', generalLedger as Handler, mocks.generateGeneralLedger],
  ['monthly-breakdown', monthlyBreakdown as Handler, mocks.generateMonthlyBreakdown],
] as const)('GET /reports/%s with dim_no + dim_code', (report, handler, generator) => {
  it('401 without an API key', async () => {
    expect((await call(handler, report, FILTER, { auth: false })).status).toBe(401)
    expect(generator).not.toHaveBeenCalled()
  })

  it('400 when only one half of the pair is sent', async () => {
    const res = await call(handler, report, `period_id=${PERIOD_ID}&dim_no=6`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.fields).toEqual(['dim_no', 'dim_code'])
    expect(generator).not.toHaveBeenCalled()
  })

  it('400 for a code the dimension bag schema refuses', async () => {
    const res = await call(handler, report, `period_id=${PERIOD_ID}&dim_no=6&dim_code=${encodeURIComponent('P"1')}`)
    expect(res.status).toBe(400)
    expect(generator).not.toHaveBeenCalled()
  })

  it('404 for a period outside the company', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))
    expect((await call(handler, report, FILTER)).status).toBe(404)
    expect(generator).not.toHaveBeenCalled()
  })

  it('filters the report and discloses the partial view', async () => {
    const res = await call(handler, report, FILTER)
    expect(res.status).toBe(200)
    const body = await res.json()

    const options = generator.mock.calls[0]!.at(-1) as { dimensions?: Record<string, string> }
    expect(options.dimensions).toEqual({ '6': 'P001' })
    expect(body.data.dimension_filter).toEqual({ '6': 'P001' })
    expect(body.data.partial_view).toMatchObject({ complete: false, disclosure: DISCLOSURE })
  })

  it('an unfiltered report carries no disclosure and passes no filter', async () => {
    const res = await call(handler, report, `period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).not.toHaveProperty('dimension_filter')
    expect(body.data).not.toHaveProperty('partial_view')
    const options = generator.mock.calls[0]!.at(-1) as { dimensions?: unknown } | undefined
    expect(options?.dimensions).toBeUndefined()
  })
})

describe('GET /reports/general-ledger: how the filter scopes the report', () => {
  it('says opening balances are scoped to the filter (the tagged IB lines, #3313)', async () => {
    const body = await (await call(generalLedger as Handler, 'general-ledger', FILTER)).json()
    expect(body.data.partial_view).toEqual({
      complete: false,
      disclosure: DISCLOSURE,
      opening_balances: 'dimension_scoped',
      // The pre-#3313 key stays, now true, so a reader testing it is not misled.
      opening_balances_included: true,
    })
    expect(mocks.generateGeneralLedger).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, undefined, undefined, {
      dimensions: { '6': 'P001' },
    })
  })

  it('does not apply a parameter it does not document (from_date), and says so in X-Ignored-Query-Params', async () => {
    const res = await call(generalLedger as Handler, 'general-ledger', `period_id=${PERIOD_ID}&from_date=2026-07-01`)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Ignored-Query-Params')).toBe('from_date')
    // The whole period, no filter: the parameter really was not applied.
    expect(mocks.generateGeneralLedger).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, undefined, undefined, undefined)
  })

  it('refuses another spelling of a dimension filter rather than ignoring it (project)', async () => {
    const res = await call(generalLedger as Handler, 'general-ledger', `period_id=${PERIOD_ID}&project=P001`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.unknown_params).toEqual(['project'])
    expect(mocks.generateGeneralLedger).not.toHaveBeenCalled()
  })
})

describe('GET /reports/trial-balance refuses the dimension filter', () => {
  it('answers 400 naming the pair, and never builds the saldobalans', async () => {
    const res = await call(trialBalance as Handler, 'trial-balance', FILTER)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['dim_no', 'dim_code'])
    expect(mocks.generateTrialBalance).not.toHaveBeenCalled()
  })
})
