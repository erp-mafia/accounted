/**
 * Route-layer tests for the v1 report PDF endpoints (income-statement/pdf,
 * balance-sheet/pdf). Rendering is mocked: what is under test is the route
 * contract: strict query params, range validation, company-settings guard,
 * the balance gate, and the binary response headers.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `reports pdf route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
  generateIncomeStatement: vi.fn(),
  renderToBuffer: vi.fn(),
}))

vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: mocks.generateBalanceSheet,
}))
vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: mocks.generateIncomeStatement,
}))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: mocks.renderToBuffer,
}))
vi.mock('@/lib/reports/financial-statement-pdf-template', () => ({
  FinancialStatementPDF: vi.fn().mockReturnValue(null),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as incomeStatementPdf } from '../income-statement/pdf/route'
import { GET as balanceSheetPdf } from '../balance-sheet/pdf/route'

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

const PERIOD_ROW = {
  id: PERIOD_ID,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

const INCOME_STATEMENT_REPORT = {
  revenue_sections: [],
  total_revenue: 100,
  expense_sections: [],
  total_expenses: 40,
  financial_sections: [],
  total_financial: 0,
  net_result: 60,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

const BALANCED_BALANCE_SHEET = {
  asset_sections: [],
  total_assets: 500,
  equity_liability_sections: [],
  total_equity_liabilities: 500,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

function makeReq(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function mockClientWith(settings: TableResp = { data: { company_id: COMPANY_ID, company_name: 'Testbolaget AB' }, error: null }) {
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      fiscal_periods: { data: PERIOD_ROW, error: null },
      company_settings: settings,
    }),
  )
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
  mocks.renderToBuffer.mockResolvedValue(Buffer.from('%PDF-fixture'))
})

describe('GET /reports/income-statement/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    mockClientWith()

    const res = await incomeStatementPdf(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(401)
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })

  it('renders a PDF for a custom range with the range in the filename', async () => {
    mockClientWith()
    mocks.generateIncomeStatement.mockResolvedValue({ ...INCOME_STATEMENT_REPORT })

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}&from_date=2026-01-01&to_date=2026-07-31`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain(
      'resultatrakning-2026-01-01--2026-07-31-utkast.pdf',
    )
    expect(mocks.generateIncomeStatement).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      PERIOD_ID,
      { fromDate: '2026-01-01', toDate: '2026-07-31' },
    )
  })

  it('rejects unknown query parameters', async () => {
    mockClientWith()

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}&locale=sv`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['locale'])
    expect(mocks.generateIncomeStatement).not.toHaveBeenCalled()
  })

  it('returns 404 NOT_FOUND when company settings are missing', async () => {
    mockClientWith({ data: null, error: null })

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })
})

describe('GET /reports/balance-sheet/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    mockClientWith()

    const res = await balanceSheetPdf(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(401)
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })

  it('renders the balance position as of a custom date', async () => {
    mockClientWith()
    mocks.generateBalanceSheet.mockResolvedValue({ ...BALANCED_BALANCE_SHEET })

    const res = await balanceSheetPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}&as_of=2026-07-31`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain(
      'balansrakning-2026-01-01--2026-07-31-utkast.pdf',
    )
    expect(mocks.generateBalanceSheet).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      PERIOD_ID,
      { fromDate: undefined, toDate: '2026-07-31' },
    )
  })

  it('refuses to render an unbalanced balansräkning', async () => {
    mockClientWith()
    mocks.generateBalanceSheet.mockResolvedValue({
      ...BALANCED_BALANCE_SHEET,
      total_equity_liabilities: 400,
    })

    const res = await balanceSheetPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })
})
