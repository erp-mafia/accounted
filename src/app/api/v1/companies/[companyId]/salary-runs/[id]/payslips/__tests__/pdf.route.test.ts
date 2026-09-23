/**
 * Tests for GET /api/v1/companies/{companyId}/salary-runs/{id}/payslips/{employeeId}/pdf
 * (payroll gap-closure 1.1).
 *
 * renderToBuffer is mocked (the invoice-pdf test pattern): these tests assert
 * routing, auth, 404 paths, and the binary response headers, not PDF pixels.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `payslip pdf route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 test')),
  // The payslip template imports these primitives at module scope.
  Document: () => null,
  Page: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: (s: unknown) => s },
  Font: { register: () => undefined },
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { renderToBuffer } from '@react-pdf/renderer'
import { GET as getPayslipPdf } from '../[employeeId]/pdf/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockRender = renderToBuffer as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
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
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

const SAMPLE_PERSONNUMMER = '190001010000'

const SAMPLE_RUN = {
  id: RUN_ID,
  period_year: 2026,
  period_month: 5,
  payment_date: '2026-05-25',
  status: 'booked',
}

const SAMPLE_SRE = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  gross_salary: 35000,
  tax_withheld: 8200,
  tax_withheld_override: null,
  avgifter_rate: 0.3142,
  avgifter_amount: 10997,
  avgifter_basis_override: null,
  avgifter_amount_override: null,
  override_reason: null,
  net_salary: 26800,
  vacation_accrual: 4200,
  vacation_accrual_avgifter: 1319.64,
  ytd_gross: 70000,
  ytd_tax: 16400,
  ytd_net: 53600,
  calculation_breakdown: null,
  employee: {
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
    personnummer_last4: '0000',
    employment_type: 'employee',
    tax_table_number: 33,
    tax_column: 1,
    clearing_number: '6000',
    bank_account_number: '12345678',
  },
  line_items: [
    {
      description: 'Grundlön',
      quantity: null,
      unit_price: null,
      amount: 35000,
      sort_order: 0,
    },
  ],
}

function makeRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function pdfParams(companyId: string, id: string, employeeId: string) {
  return { params: Promise.resolve({ companyId, id, employeeId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.7 test'))
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/salary-runs/:id/payslips/:employeeId/pdf', () => {
  it('returns the rendered PDF with attachment disposition (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
        salary_run_employees: { data: SAMPLE_SRE, error: null },
        companies: { data: { name: 'Testbolaget AB', org_number: '5560000000' }, error: null },
        company_settings: { data: { company_name: 'Testbolaget AB' }, error: null },
      }),
    )

    const res = await getPayslipPdf(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain('lonespec_Andersson_Anna_2026-05.pdf')
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.toString()).toContain('%PDF')
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when the run is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
      }),
    )
    const res = await getPayslipPdf(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 404 NOT_FOUND when the employee is not in the run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
        salary_run_employees: { data: null, error: null },
      }),
    )
    const res = await getPayslipPdf(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects keys without payroll:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'wrong scope',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await getPayslipPdf(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await getPayslipPdf(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })

  it('maps a render failure to 500 INTERNAL_ERROR rather than crashing', async () => {
    mockRender.mockRejectedValue(new Error('font missing'))
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
        salary_run_employees: { data: SAMPLE_SRE, error: null },
        companies: { data: { name: 'Testbolaget AB', org_number: '5560000000' }, error: null },
        company_settings: { data: { company_name: 'Testbolaget AB' }, error: null },
      }),
    )

    const res = await getPayslipPdf(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf`,
      ),
      pdfParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })
})
