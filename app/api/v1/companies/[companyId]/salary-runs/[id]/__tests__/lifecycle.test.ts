/**
 * Integration tests for the v1 salary-run lifecycle verbs (Phase 5 PR-2).
 *
 * Covers :calculate, :approve, :mark-paid, :book, :generate-agi. Each suite
 * focuses on the verb's contract: auth/scope, state-machine enforcement,
 * strict-mode (engine throws abort before state flip), period-lock pre-
 * check, audit block on :book, AGI gate, etc. The underlying lib helpers
 * (`runSalaryCalculation`, `createSalaryRunEntries`, `generateAgiDeclaration`)
 * are stubbed via vi.mock so we exercise the route logic, not the engine.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary-run lifecycle tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// The lifecycle verbs delegate to lib helpers; stub those so the tests
// exercise route logic, not engine behavior.
const mocks = vi.hoisted(() => ({
  runSalaryCalculation: vi.fn(),
  createSalaryRunEntries: vi.fn(),
  checkPeriodLock: vi.fn(),
  generateAgiDeclaration: vi.fn(),
}))

vi.mock('@/lib/salary/run-calculation', () => ({
  runSalaryCalculation: mocks.runSalaryCalculation,
}))

vi.mock('@/lib/salary/salary-entries', () => ({
  createSalaryRunEntries: mocks.createSalaryRunEntries,
}))

vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: mocks.checkPeriodLock,
}))

vi.mock('@/lib/salary/agi/generate-declaration', () => ({
  generateAgiDeclaration: mocks.generateAgiDeclaration,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as calculate } from '../calculate/route'
import { POST as approve } from '../approve/route'
import { POST as markPaid } from '../mark-paid/route'
import { POST as book } from '../book/route'
import { POST as generateAgi } from '../generate-agi/route'

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
  // The generate-agi route also hits supabase.auth.admin.getUserById; stub
  // that so the helper-mock path doesn't trip on auth.
  return {
    from: vi.fn((table: string) => buildChain(table)),
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'caller@test' } } }),
      },
    },
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
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

// ────────────────────────────────────────────────────────────────────
// :calculate
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/calculate', () => {
  it('runs the helper and advances draft → review on success', async () => {
    const draftRun = { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 5, payment_date: '2026-05-25' }
    const advancedRun = {
      id: RUN_ID, status: 'review',
      period_year: 2026, period_month: 5,
      total_gross: 105000, total_tax: 28500, total_net: 76500,
      total_avgifter: 32991, total_employer_cost: 137991,
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: draftRun, error: null }, // pre-flight read
          { data: advancedRun, error: null }, // status flip
        ],
        salary_run_employees: { data: [], error: null }, // for F-skatt scan
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.runSalaryCalculation.mockResolvedValue({
      ok: true,
      run: { id: RUN_ID, status: 'draft' },
      warnings: [],
    })

    const res = await calculate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/calculate`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('review')
    expect(mocks.runSalaryCalculation).toHaveBeenCalledOnce()
  })

  it('refuses to calculate a non-draft run (state-machine enforcement)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await calculate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/calculate`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_CALCULATE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('review')
    expect(mocks.runSalaryCalculation).not.toHaveBeenCalled()
  })

  it('strict-mode: helper failure aborts before the status flip', async () => {
    const draftRun = { id: RUN_ID, status: 'draft', period_year: 2026, period_month: 5, payment_date: '2026-05-25' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: draftRun, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.runSalaryCalculation.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_TAX_TABLE_MISSING',
      details: { reason: 'Skatteverket API unreachable' },
      status: 503,
    })

    const res = await calculate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/calculate`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_TAX_TABLE_MISSING')
  })

  it('returns a dry-run preview without invoking the helper', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await calculate(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/calculate?dry_run=true`,
        { method: 'POST' },
      ),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(mocks.runSalaryCalculation).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.data.preview.would_advance_status_to).toBe('review')
  })
})

// ────────────────────────────────────────────────────────────────────
// :approve
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/approve', () => {
  it('approves a run with valid bank details + calculation_breakdown', async () => {
    const validEmployee = {
      calculation_breakdown: { steps: [] },
      employee: {
        first_name: 'Anna',
        last_name: 'Andersson',
        clearing_number: '6000',
        bank_account_number: '12345678',
        email: 'anna@test',
      },
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: { id: RUN_ID, status: 'review' }, error: null },
          { data: { id: RUN_ID, status: 'approved', approved_at: '2026-05-14T12:00:00Z', approved_by: USER_ID }, error: null },
        ],
        salary_run_employees: { data: [validEmployee], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await approve(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('approved')
  })

  it('returns SALARY_RUN_APPROVE_VALIDATION_FAILED for missing bank details', async () => {
    const noBankEmployee = {
      calculation_breakdown: { steps: [] },
      employee: {
        first_name: 'Bo',
        last_name: 'Berg',
        clearing_number: null,
        bank_account_number: null,
        email: 'bo@test',
      },
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        salary_run_employees: { data: [noBankEmployee], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await approve(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_APPROVE_VALIDATION_FAILED')
    expect(body.error.details.issues.length).toBeGreaterThan(0)
  })

  it('refuses to approve a non-review run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'draft' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await approve(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/approve`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_APPROVE_NOT_REVIEW')
  })
})

// ────────────────────────────────────────────────────────────────────
// :mark-paid
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/mark-paid', () => {
  it('advances approved → paid', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: { id: RUN_ID, status: 'approved' }, error: null },
          { data: { id: RUN_ID, status: 'paid', paid_at: '2026-05-25T08:00:00Z' }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('paid')
  })

  it('refuses to mark a non-approved run as paid', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await markPaid(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/mark-paid`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_MARK_PAID_NOT_APPROVED')
  })
})

// ────────────────────────────────────────────────────────────────────
// :book (engine-touching, period-lock)
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/book', () => {
  const paidRun = {
    id: RUN_ID,
    status: 'paid',
    period_year: 2026,
    period_month: 5,
    payment_date: '2026-05-25',
    voucher_series: 'L',
    total_gross: 35000,
    total_tax: 9500,
    total_net: 25500,
    total_avgifter: 10997,
    total_vacation_accrual: 0,
  }

  const employeeRow = {
    employee_id: 'emp_1',
    employee: { employment_type: 'employee' },
    gross_salary: 35000,
    tax_withheld: 9500,
    net_salary: 25500,
    avgifter_amount: 10997,
    avgifter_rate: 0.3142,
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    line_items: [],
  }

  it('books a paid run and surfaces the audit block', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: paidRun, error: null }, // status precheck
          {
            data: {
              id: RUN_ID, status: 'booked',
              booked_at: '2026-05-26T09:15:00Z', booked_by: USER_ID,
              salary_entry_id: 'je_salary', avgifter_entry_id: 'je_avg',
              vacation_entry_id: null, pension_entry_id: null,
            },
            error: null,
          }, // status flip
        ],
        salary_run_employees: { data: [employeeRow], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockResolvedValue({
      salaryEntry: { id: 'je_salary', voucher_number: 'L2026-0023' },
      avgifterEntry: { id: 'je_avg' },
      vacationEntry: null,
      pensionEntry: null,
    })

    const res = await book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('booked')
    expect(body.data.salary_entry_id).toBe('je_salary')
    expect(body.data.entry_ids).toEqual(['je_salary', 'je_avg'])
    expect(body.meta.audit.voucher_number).toBe('L2026-0023')
    expect(body.meta.audit.voucher_url).toContain('je_salary')
  })

  it('returns PERIOD_LOCKED before invoking the engine when payment_date is locked', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: paidRun, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({
      locked: true,
      reason: 'company_lock_date_covers',
    })

    const res = await book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details.reason).toBe('company_lock_date_covers')
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('strict-mode: engine throw aborts before any state mutation', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: paidRun, error: null },
        salary_run_employees: { data: [employeeRow], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockRejectedValue(new Error('Insufficient BAS account'))

    const res = await book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_BOOK_FAILED')
  })

  it('refuses to book a non-paid run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { ...paidRun, status: 'approved' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_BOOK_NOT_PAID')
    expect(mocks.checkPeriodLock).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────
// :generate-agi
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/generate-agi', () => {
  it('returns the XML embedded in the v1 envelope', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.generateAgiDeclaration.mockResolvedValue({
      ok: true,
      xml: '<?xml version="1.0"?><Skatteverket/>',
      agiDeclarationId: 'agi_a8f1',
      periodYear: 2026,
      periodMonth: 5,
      employeeCount: 3,
      isCorrection: false,
      totals: {
        totalTax: 28500,
        totalAvgifterBasis: 105000,
        totalAvgifterAmount: 32991,
        totalSjuklonekostnad: 0,
        avgifterByCategory: {},
      },
      orgNumber: '5566778899',
    })

    const res = await generateAgi(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/generate-agi`,
        { method: 'POST' },
      ),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.xml).toContain('<Skatteverket')
    expect(body.data.is_correction).toBe(false)
    expect(body.data.xml_filename).toBe('AGI_5566778899_202605.xml')
  })

  it('surfaces AGI_GENERATE_NOT_BOOKABLE when the run is in draft', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.generateAgiDeclaration.mockResolvedValue({
      ok: false,
      code: 'AGI_GENERATE_NOT_BOOKABLE',
      details: { current_status: 'draft' },
    })

    const res = await generateAgi(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/generate-agi`,
        { method: 'POST' },
      ),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('AGI_GENERATE_NOT_BOOKABLE')
    expect(body.error.details.current_status).toBe('draft')
  })

  it('surfaces AGI_INCOMPLETE_DATA with missing_fields when company contact info is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.generateAgiDeclaration.mockResolvedValue({
      ok: false,
      code: 'AGI_INCOMPLETE_DATA',
      details: {
        missing_fields: ['contactPhone'],
        message: 'AGI requires a contact phone number on company_settings.',
      },
    })

    const res = await generateAgi(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/generate-agi`,
        { method: 'POST' },
      ),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('AGI_INCOMPLETE_DATA')
    expect(body.error.details.missing_fields).toContain('contactPhone')
  })
})
