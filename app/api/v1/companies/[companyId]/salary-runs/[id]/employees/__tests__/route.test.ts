/**
 * Tests for the v1 per-employee payslip reads (payroll gap-closure 1.1).
 *
 * GET /salary-runs/{id}/employees          : list per-employee results
 * GET /salary-runs/{id}/employees/{empId}  : payslip detail (line items + breakdown)
 *
 * Mirrors the employees-route test pattern: Proxy-backed Supabase mock with
 * per-table response queues.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary-run employees route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listRunEmployees, POST as attachEmployee } from '../route'
import { GET as getPayslip, DELETE as removeEmployee, PATCH as setRunSalary } from '../[employeeId]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

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
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'user-1'

// Synthetic fixture personnummer (year 1900, zero suffix): must not look
// like production-format PII.
const SAMPLE_PERSONNUMMER = '190001010000'

function makeRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function listParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

function detailParams(companyId: string, id: string, employeeId: string) {
  return { params: Promise.resolve({ companyId, id, employeeId }) }
}

const SAMPLE_SRE = {
  id: SRE_ID,
  salary_run_id: RUN_ID,
  employee_id: EMPLOYEE_ID,
  salary_type: 'monthly',
  employment_degree: 100,
  monthly_salary: 35000,
  hours_worked: null,
  gross_salary: 35000,
  gross_deductions: 0,
  benefit_values: 0,
  taxable_income: 35000,
  tax_withheld: 8200,
  tax_withheld_override: null,
  net_deductions: 0,
  net_salary: 26800,
  avgifter_rate: 0.3142,
  avgifter_basis: 35000,
  avgifter_amount: 10997,
  avgifter_basis_override: null,
  avgifter_amount_override: null,
  avgifter_category: 'standard',
  override_reason: null,
  vacation_accrual: 4200,
  vacation_accrual_avgifter: 1319.64,
  tax_table_number: 33,
  tax_column: 1,
  tax_table_year: 2026,
  sick_days: 0,
  vab_days: 0,
  parental_days: 0,
  vacation_days_taken: 0,
  ytd_gross: 70000,
  ytd_tax: 16400,
  ytd_net: 53600,
  calculation_breakdown: { steps: [{ label: 'Grundlön', formula: '35000 x 100%', output: 35000 }] },
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
  employee: {
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
  },
  line_items: [
    {
      id: LINE_ID,
      item_type: 'monthly_salary',
      description: 'Grundlön',
      quantity: null,
      unit_price: null,
      amount: 35000,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      is_gross_deduction: false,
      is_net_deduction: false,
      account_number: '7210',
      sort_order: 0,
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/salary-runs/:id/employees', () => {
  it('returns per-employee rows with masked personnummer and qualified ids', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID }, error: null },
        salary_run_employees: { data: [SAMPLE_SRE], error: null },
      }),
    )

    const res = await listRunEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`),
      listParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].salary_run_employee_id).toBe(SRE_ID)
    expect(body.data[0].employee_id).toBe(EMPLOYEE_ID)
    expect(body.data[0].gross_salary).toBe(35000)
    expect(body.data[0].net_salary).toBe(26800)
    // GDPR Art.5(1)(c): payslip-shaped responses always mask.
    expect(body.data[0].personnummer_masked).toBe('19000101XXXX')
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
    // The list omits line items: the detail endpoint carries them.
    expect(body.data[0].line_items).toBeUndefined()
    // paginated() omits next_cursor from meta on the final page.
    expect(body.meta.next_cursor ?? null).toBeNull()
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when the run is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
      }),
    )
    const res = await listRunEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`),
      listParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('rejects a non-UUID run id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listRunEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/not-a-uuid/employees`),
      listParams(COMPANY_ID, 'not-a-uuid'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
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

    const res = await listRunEmployees(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`),
      listParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listRunEmployees(
      new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`),
      listParams(COMPANY_ID, RUN_ID),
    )
    expect(res.status).toBe(401)
  })

  it('emits a next_cursor when the page is full', async () => {
    // limit=1 with 2 rows returned (limit + 1 fetch convention).
    const second = {
      ...SAMPLE_SRE,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      employee_id: '99999999-9999-4999-8999-999999999999',
      created_at: '2026-05-01T09:00:00Z',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID }, error: null },
        salary_run_employees: { data: [SAMPLE_SRE, second], error: null },
      }),
    )

    const res = await listRunEmployees(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees?limit=1`,
      ),
      listParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.meta.next_cursor).toBeTruthy()
  })
})

describe('GET /api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId', () => {
  it('returns the payslip detail with line items and calculation breakdown', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_run_employees: { data: SAMPLE_SRE, error: null },
      }),
    )

    const res = await getPayslip(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_run_employee_id).toBe(SRE_ID)
    expect(body.data.employee_id).toBe(EMPLOYEE_ID)
    expect(body.data.personnummer_masked).toBe('19000101XXXX')
    expect(body.data.line_items).toHaveLength(1)
    expect(body.data.line_items[0].salary_line_item_id).toBe(LINE_ID)
    expect(body.data.line_items[0].item_type).toBe('monthly_salary')
    expect(body.data.calculation_breakdown.steps).toHaveLength(1)
    // Raw personnummer never leaks; the raw line id is re-keyed to the
    // qualified name (no bare `id` fields in the payload).
    expect(JSON.stringify(body)).not.toContain(SAMPLE_PERSONNUMMER)
    expect(body.data.line_items[0].id).toBeUndefined()
    expect(body.data.id).toBeUndefined()
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when the run itself is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_run_employees: { data: null, error: null },
        salary_runs: { data: null, error: null },
      }),
    )
    const res = await getPayslip(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 404 NOT_FOUND when the run exists but the employee is not in it', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_run_employees: { data: null, error: null },
        salary_runs: { data: { id: RUN_ID }, error: null },
      }),
    )
    const res = await getPayslip(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details.resource).toBe('salary_run_employee')
  })

  it('rejects a non-UUID employee id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await getPayslip(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/nope`,
      ),
      detailParams(COMPANY_ID, RUN_ID, 'nope'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('POST /api/v1/companies/:companyId/salary-runs/:id/employees', () => {
  const withIdempotency = (url: string, body: unknown): Request =>
    new Request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      body: JSON.stringify(body),
    })

  const SAMPLE_EMPLOYEE_MASTER = {
    id: EMPLOYEE_ID,
    employment_degree: 100,
    monthly_salary: 35000,
    hourly_rate: null,
    salary_type: 'monthly',
    employment_type: 'employee',
    tax_table_number: 33,
    tax_column: 1,
  }

  it('attaches an employee to a draft run (happy path, 201)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE_MASTER, error: null },
        salary_run_employees: [
          { data: null, error: null }, // duplicate check
          {
            data: {
              id: SRE_ID,
              salary_run_id: RUN_ID,
              employee_id: EMPLOYEE_ID,
              company_id: COMPANY_ID,
              employment_degree: 100,
              monthly_salary: 35000,
              salary_type: 'monthly',
              hours_worked: null,
              tax_table_number: 33,
              tax_column: 1,
              created_at: '2026-05-01T08:00:00Z',
              updated_at: '2026-05-01T08:00:00Z',
            },
            error: null,
          },
        ],
        salary_line_items: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await attachEmployee(
      withIdempotency(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`,
        { employee_id: EMPLOYEE_ID },
      ),
      listParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.salary_run_employee_id).toBe(SRE_ID)
    expect(body.data.employee_id).toBe(EMPLOYEE_ID)
    expect(body.data.id).toBeUndefined()
  })

  it('returns 409 SALARY_RUN_EMPLOYEE_DUPLICATE when already attached', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        employees: { data: SAMPLE_EMPLOYEE_MASTER, error: null },
        salary_run_employees: { data: { id: SRE_ID }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await attachEmployee(
      withIdempotency(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`,
        { employee_id: EMPLOYEE_ID },
      ),
      listParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEE_DUPLICATE')
  })

  it('returns 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run advanced', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await attachEmployee(
      withIdempotency(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees`,
        { employee_id: EMPLOYEE_ID },
      ),
      listParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEES_NOT_DRAFT')
  })
})

describe('PATCH /api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId', () => {
  const patchRequest = (url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request =>
    new Request(url, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': 'b3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })

  const SRE_SALARY_ROW = {
    id: SRE_ID,
    employee_id: EMPLOYEE_ID,
    salary_type: 'monthly',
    employment_degree: 100,
    monthly_salary: 30000,
  }

  it('sets this run\'s salary on a draft (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: [
          { data: SRE_SALARY_ROW, error: null }, // select
          { data: null, error: null }, // update
        ],
        salary_line_items: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
        { monthly_salary: 45000 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.salary_run_employee_id).toBe(SRE_ID)
    expect(body.data.previous_monthly_salary).toBe(30000)
    expect(body.data.monthly_salary).toBe(45000)
  })

  it('returns 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run advanced', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
        { monthly_salary: 45000 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEES_NOT_DRAFT')
  })

  it('returns 404 SALARY_RUN_EMPLOYEE_NOT_FOUND when the employee is not on the run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
        { monthly_salary: 45000 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
  })

  it('rejects a negative salary with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
        { monthly_salary: -1 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects keys without payroll:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read only',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
        { monthly_salary: 45000 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('dry-run previews without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
      salary_run_employees: { data: SRE_SALARY_ROW, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await setRunSalary(
      patchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}?dry_run=true`,
        { monthly_salary: 45000 },
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.monthly_salary).toBe(45000)
    // No write tables touched.
    const tables = (supabaseMock.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('salary_line_items')
  })
})

describe('DELETE /api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId', () => {
  const deleteRequest = (url: string): Request =>
    new Request(url, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': 'b2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    })

  it('removes an attached employee (204)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: [
          { data: { id: SRE_ID }, error: null },
          { data: null, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await removeEmployee(
      deleteRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(204)
  })

  it('returns 404 SALARY_RUN_EMPLOYEE_NOT_FOUND when not attached', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        salary_run_employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await removeEmployee(
      deleteRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/employees/${EMPLOYEE_ID}`,
      ),
      detailParams(COMPANY_ID, RUN_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_EMPLOYEE_NOT_FOUND')
  })
})
