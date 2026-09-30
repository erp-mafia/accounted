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

vi.mock('@/lib/salary/ytd', () => ({
  refreshRunYtd: vi.fn().mockResolvedValue({ ok: true, updated: 0 }),
}))

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

// The rows -> engine-input mapper stays real (the call args are the contract
// under test); only the posting is mocked.
vi.mock('@/lib/salary/salary-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/salary-entries')>()),
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
import { refreshRunYtd } from '@/lib/salary/ytd'
import { POST as markPaid } from '../mark-paid/route'
import { POST as book } from '../book/route'
import { SalaryRunPartiallyBookedError } from '@/lib/salary/salary-entries'
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
  // Every chained call in order, so a test can assert filters and payloads.
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
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
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  // The generate-agi route also hits supabase.auth.admin.getUserById; stub
  // that so the helper-mock path doesn't trip on auth.
  return {
    calls,
    // RPCs answer from the 'rpc:<name>' key, like a table.
    rpc: vi.fn((fn: string, args?: unknown) => {
      calls.push({ table: `rpc:${fn}`, method: 'rpc', args: [args] })
      return buildChain(`rpc:${fn}`)
    }),
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
// The token claim_salary_run_booking hands the call that may book the run.
const BOOKING_CLAIM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
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
    // Parity with the dashboard approve route: the payslip's Ackumulerat
    // snapshot is refreshed at the first status lönebesked can be sent from.
    expect(refreshRunYtd).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
    })
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

  it('returns SALARY_RUN_APPROVE_VALIDATION_FAILED naming an employee whose bank details name no payable account', async () => {
    // Invented number: 11 digits that do not repeat the clearing.
    const unpayableEmployee = {
      calculation_breakdown: { steps: [] },
      employee: {
        first_name: 'Lena',
        last_name: 'Lund',
        clearing_number: '5037',
        bank_account_number: '96123456789',
        email: 'lena@test',
      },
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'review' }, error: null },
        salary_run_employees: { data: [unpayableEmployee], error: null },
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
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.error.code).toBe('SALARY_RUN_APPROVE_VALIDATION_FAILED')
    expect(body.error.details.issues).toEqual([
      'Lena Lund: kontonumret är ogiltigt (5-10 siffror, utan clearingnummer). Rätta bankuppgifterna.',
    ])
    expect(text).not.toContain('96123456789')
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
    calculation_params: { slpRate: 0.2426 },
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
        'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
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
    expect(mocks.createSalaryRunEntries).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ calculation_params: { slpRate: 0.2426 } }),
    )
  })

  it('applies review overrides with book-run parity (tax/net reconciled, F-skatt avgifter override ignored)', async () => {
    // Overrides set during dashboard review must reach the ledger the same
    // way no matter which surface books the run: v1 previously ignored them,
    // so the booked 2710/2731 diverged from the AGI by the override delta.
    const overriddenRow = {
      ...employeeRow,
      tax_withheld_override: 9000,
      avgifter_amount_override: 10000,
      avgifter_basis: 35000,
      avgifter_category: 'standard',
    }
    const fSkattRow = {
      ...employeeRow,
      employee_id: 'emp_2',
      employee: { employment_type: 'employee', f_skatt_status: 'f_skatt' },
      gross_salary: 15000,
      tax_withheld: 0,
      net_salary: 15000,
      avgifter_amount: 0,
      // An avgifter override on an F-skatt row must be ignored (the AGI's
      // isFSkattRow invariant), and the underlag zeroed.
      avgifter_amount_override: 500,
      avgifter_basis: 15000,
      avgifter_category: 'standard',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: paidRun, error: null },
          {
            data: {
              id: RUN_ID, status: 'booked',
              booked_at: '2026-05-26T09:15:00Z', booked_by: USER_ID,
              salary_entry_id: 'je_salary', avgifter_entry_id: 'je_avg',
              vacation_entry_id: null, pension_entry_id: null,
            },
            error: null,
          },
        ],
        salary_run_employees: { data: [overriddenRow, fSkattRow], error: null },
        'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockResolvedValue({
      salaryEntry: { id: 'je_salary', voucher_number: 'L2026-0024' },
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
    const payload = mocks.createSalaryRunEntries.mock.calls[0][3] as {
      employees: Array<Record<string, unknown>>
    }
    const [regular, fSkatt] = payload.employees
    expect(regular).toMatchObject({
      tax_withheld: 9000,
      // net reconciles by the withheld difference: 25 500 + (9 500 - 9 000).
      net_salary: 26000,
      avgifter_amount: 10000,
      avgifter_amount_overridden: true,
      avgifter_basis: 35000,
    })
    expect(fSkatt).toMatchObject({
      avgifter_amount: 0,
      avgifter_amount_overridden: false,
      avgifter_basis: 0,
    })
  })

  it('books a run without arbetsgivaravgifter: no avgifter entry, avgifter_entry_id null', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: { ...paidRun, total_avgifter: 0 }, error: null },
          {
            data: {
              id: RUN_ID, status: 'booked',
              booked_at: '2026-05-26T09:15:00Z', booked_by: USER_ID,
              salary_entry_id: 'je_salary', avgifter_entry_id: null,
              vacation_entry_id: null, pension_entry_id: null,
            },
            error: null,
          },
        ],
        salary_run_employees: { data: [{ ...employeeRow, avgifter_amount: 0 }], error: null },
        'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockResolvedValue({
      salaryEntry: { id: 'je_salary', voucher_number: 'L2026-0025' },
      avgifterEntry: null,
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
    expect(body.data.avgifter_entry_id).toBeNull()
    expect(body.data.entry_ids).toEqual(['je_salary'])
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
        'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
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

  it('answers 409 SALARY_RUN_PARTIALLY_BOOKED with the vouchers to reverse when the run has posted vouchers that do not match', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: paidRun, error: null },
        salary_run_employees: { data: [employeeRow], error: null },
        'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockRejectedValue(
      new SalaryRunPartiallyBookedError([{ id: 'je_stale', voucher_series: 'L', voucher_number: 7 }]),
    )

    const res = await book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PARTIALLY_BOOKED')
    expect(body.error.details).toEqual({ voucher_numbers: ['L7'], entry_ids: ['je_stale'] })
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
// :book booking claim (accounted#3251)
// ────────────────────────────────────────────────────────────────────

describe('POST /salary-runs/:id/book: one booking per run at a time', () => {
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
    calculation_params: { slpRate: 0.2426 },
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
  const bookedRow = {
    id: RUN_ID, status: 'booked',
    booked_at: '2026-05-26T09:15:00Z', booked_by: USER_ID,
    salary_entry_id: 'je_salary', avgifter_entry_id: 'je_avg',
    vacation_entry_id: null, pension_entry_id: null,
  }
  type Call = { table: string; method: string; args: unknown[] }
  const post = () =>
    book(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/book`, { method: 'POST' }),
      detailParams(COMPANY_ID, RUN_ID),
    )
  /** The .eq filters that follow the salary_runs update whose payload matches. */
  const updateFilters = (calls: Call[], match: (payload: Record<string, unknown>) => boolean) => {
    const start = calls.findIndex(
      (c) => c.table === 'salary_runs' && c.method === 'update' && match(c.args[0] as Record<string, unknown>),
    )
    if (start === -1) return null
    const out: unknown[][] = []
    for (let i = start + 1; i < calls.length && calls[i].method === 'eq'; i++) out.push(calls[i].args)
    return out
  }

  beforeEach(() => {
    mocks.checkPeriodLock.mockResolvedValue({ locked: false })
    mocks.createSalaryRunEntries.mockResolvedValue({
      salaryEntry: { id: 'je_salary', voucher_number: 'L2026-0023' },
      avgifterEntry: { id: 'je_avg' },
      vacationEntry: null,
      pensionEntry: null,
    })
  })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    expect((await post()).status).toBe(401)
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('404 SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await post()

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('claims the run before posting and flips it only for the claim holder', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: [
        { data: paidRun, error: null },
        { data: bookedRow, error: null },
      ],
      salary_run_employees: { data: [employeeRow], error: null },
      'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await post()

    expect(res.status).toBe(200)
    expect(supabase.rpc).toHaveBeenCalledWith('claim_salary_run_booking', {
      p_company_id: COMPANY_ID,
      p_salary_run_id: RUN_ID,
    })
    const flip = updateFilters(supabase.calls, (payload) => payload.status === 'booked')
    expect(flip).toEqual(
      expect.arrayContaining([
        ['company_id', COMPANY_ID],
        ['id', RUN_ID],
        ['status', 'paid'],
        ['booking_claim_id', BOOKING_CLAIM],
      ]),
    )
    const flipPayload = supabase.calls.find(
      (c) => c.table === 'salary_runs' && c.method === 'update',
    )?.args[0] as Record<string, unknown>
    expect(flipPayload).toMatchObject({ booking_claim_id: null, booking_claimed_at: null })
    // Booked: the flip cleared the claim, so there is nothing to release.
    expect(supabase.calls.filter((c) => c.table === 'salary_runs' && c.method === 'update')).toHaveLength(1)
  })

  it('409 SALARY_RUN_BOOKING_IN_PROGRESS and posts nothing while another call holds the run', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      // precheck reads paid, the post-refusal re-read still reads paid
      salary_runs: { data: paidRun, error: null },
      salary_run_employees: { data: [employeeRow], error: null },
      'rpc:claim_salary_run_booking': { data: null, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await post()

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_BOOKING_IN_PROGRESS')
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'salary_runs' && c.method === 'update')).toBe(false)
  })

  it('answers SALARY_RUN_BOOK_NOT_PAID when a concurrent call booked the run after the precheck', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          { data: paidRun, error: null }, // precheck: still paid
          { data: { status: 'booked' }, error: null }, // re-read after the refused claim
        ],
        salary_run_employees: { data: [employeeRow], error: null },
        'rpc:claim_salary_run_booking': { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await post()

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_BOOK_NOT_PAID')
    expect(body.error.details).toEqual({ current_status: 'booked' })
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
  })

  it('releases the claim when the engine throws, so the caller can retry at once', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: { data: paidRun, error: null },
      salary_run_employees: { data: [employeeRow], error: null },
      'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    mocks.createSalaryRunEntries.mockRejectedValue(new Error('Insufficient BAS account'))

    const res = await post()

    expect(res.status).toBe(500)
    const release = updateFilters(
      supabase.calls,
      (payload) => payload.status === undefined && payload.booking_claim_id === null,
    )
    expect(release).toEqual([
      ['id', RUN_ID],
      ['company_id', COMPANY_ID],
      ['booking_claim_id', BOOKING_CLAIM],
    ])
  })

  it('releases the claim and reports the lost claim when the flip matches no row', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: [
        { data: paidRun, error: null },
        { data: null, error: null }, // flip: the claim is no longer ours
      ],
      salary_run_employees: { data: [employeeRow], error: null },
      'rpc:claim_salary_run_booking': { data: BOOKING_CLAIM, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await post()

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_BOOK_FAILED')
    expect(body.error.details).toEqual({ reason: 'booking_claim_lost', entry_ids: ['je_salary', 'je_avg'] })
    // The release is conditional on this call's token, so it never touches a
    // claim another call has taken since.
    const release = updateFilters(
      supabase.calls,
      (payload) => payload.status === undefined && payload.booking_claim_id === null,
    )
    expect(release).toEqual([
      ['id', RUN_ID],
      ['company_id', COMPANY_ID],
      ['booking_claim_id', BOOKING_CLAIM],
    ])
  })

  it('answers a database error and posts nothing when the claim itself fails', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: { data: paidRun, error: null },
      salary_run_employees: { data: [employeeRow], error: null },
      'rpc:claim_salary_run_booking': {
        data: null,
        error: { message: 'connection reset', code: '08006' },
      },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await post()

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(mocks.createSalaryRunEntries).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'salary_runs' && c.method === 'update')).toBe(false)
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
