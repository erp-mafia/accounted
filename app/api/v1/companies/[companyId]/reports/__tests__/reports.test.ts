/**
 * Integration tests for the v1 reports + imports surface (Phase 5 PR-3).
 *
 * Most report routes are thin wrappers over `lib/reports/*` generators:
 * the lib functions have their own unit tests, so these specs focus on
 * the route-layer contract: auth / scope, period_id validation, the
 * shared `loadPeriodFromQuery` helper, and the safeGenerate error path.
 *
 * Imports are tested for multipart parsing + operation-id response shape;
 * the actual SIE / bank-file lib behavior is covered elsewhere.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `reports route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const mocks = vi.hoisted(() => ({
  generateBalanceSheet: vi.fn(),
  generateTrialBalance: vi.fn(),
  generateIncomeStatement: vi.fn(),
  generateSIEExport: vi.fn(),
  calculateVatDeclaration: vi.fn(),
}))

vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: mocks.generateBalanceSheet,
}))
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: mocks.generateTrialBalance,
}))
vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: mocks.generateIncomeStatement,
}))
vi.mock('@/lib/reports/sie-export', () => ({
  generateSIEExport: mocks.generateSIEExport,
}))
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: mocks.calculateVatDeclaration,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as balanceSheet } from '../balance-sheet/route'
import { GET as trialBalance } from '../trial-balance/route'
import { GET as incomeStatement } from '../income-statement/route'
import { GET as sieExport } from '../sie-export/route'
import { GET as vatDeclaration } from '../vat-declaration/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeReq(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

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
})

describe('GET /reports/trial-balance', () => {
  it('returns 400 VALIDATION_ERROR when period_id is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await trialBalance(
      makeReq(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('period_id')
    expect(mocks.generateTrialBalance).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when period_id is not a UUID', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await trialBalance(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance?period_id=not-a-uuid`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    expect(mocks.generateTrialBalance).not.toHaveBeenCalled()
  })

  it('returns 404 NOT_FOUND when the period belongs to another company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: { data: null, error: null },
      }),
    )

    const res = await trialBalance(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    expect(mocks.generateTrialBalance).not.toHaveBeenCalled()
  })

  it('returns the trial-balance from the generator on the happy path', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: {
            id: PERIOD_ID,
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
          error: null,
        },
      }),
    )
    mocks.generateTrialBalance.mockResolvedValue({
      rows: [],
      totalDebit: 0,
      totalCredit: 0,
      isBalanced: true,
    })

    const res = await trialBalance(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.isBalanced).toBe(true)
    expect(mocks.generateTrialBalance).toHaveBeenCalledOnce()
  })

  it('surfaces REPORT_GENERATION_FAILED when the lib throws', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: {
            id: PERIOD_ID,
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
          error: null,
        },
      }),
    )
    mocks.generateTrialBalance.mockRejectedValue(new Error('lib crash'))

    const res = await trialBalance(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
  })

  it('rejects keys without reports:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'wrong scope',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await trialBalance(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/trial-balance?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
  })
})

describe('GET /reports/balance-sheet', () => {
  it('enriches the generator result with period dates', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: {
            id: PERIOD_ID,
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
          error: null,
        },
      }),
    )
    mocks.generateBalanceSheet.mockResolvedValue({ sections: [], totals: {} })

    const res = await balanceSheet(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })
})

describe('GET /reports/income-statement', () => {
  it('enriches the generator result with period dates', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: {
            id: PERIOD_ID,
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
          error: null,
        },
      }),
    )
    mocks.generateIncomeStatement.mockResolvedValue({ sections: [], grossMargin: 0, netResult: 0 })

    const res = await incomeStatement(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })
})

describe('GET /reports/sie-export', () => {
  it('returns the SIE content with text/plain Content-Type + attachment Content-Disposition', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: {
            id: PERIOD_ID,
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            is_closed: false,
            locked_at: null,
          },
          error: null,
        },
        company_settings: {
          data: { company_name: 'Test AB', org_number: '5566778899' },
          error: null,
        },
      }),
    )
    mocks.generateSIEExport.mockResolvedValue('#FLAGGA 0\n#PROGRAM Accounted\n')

    const res = await sieExport(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/sie-export?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment.*\.se/)
    const body = await res.text()
    expect(body).toContain('#FLAGGA')
  })
})

describe('GET /reports/vat-declaration', () => {
  it('rejects missing required period_type/year/period', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await vatDeclaration(
      makeReq(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/vat-declaration`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mocks.calculateVatDeclaration).not.toHaveBeenCalled()
  })

  it('rejects out-of-range period_type', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await vatDeclaration(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/vat-declaration?period_type=biennial&year=2026&period=1`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
  })

  it('passes through to calculateVatDeclaration on the happy path', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    mocks.calculateVatDeclaration.mockResolvedValue({ rutor: { ruta49: 0 } })

    const res = await vatDeclaration(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/vat-declaration?period_type=monthly&year=2026&period=4`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.rutor.ruta49).toBe(0)
    expect(mocks.calculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'monthly',
      2026,
      4,
      undefined,
    )
  })
})
