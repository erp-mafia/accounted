/**
 * Every payslip line type has a role, and every role is paid (crm#1331).
 *
 * An hourly_salary row on a monthly-paid payslip was accepted, stored and
 * printed, but no step of the calculation read it: the engine's lists left
 * the type out because they assumed every Grundlön/Timlön row is its own
 * display of Step 1. These tests pin the explicit role map against every
 * door that accepts a type (the TypeScript union by compilation, the API
 * schema and the database CHECK here), run each accepted type through the
 * engine to prove some step consumes it, and cover the base-salary pair end
 * to end: engine, run calculation and line commands.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { SalaryLineItemTypeSchema } from '@/lib/api/schemas'
import type { SalaryLineItemType } from '@/types'
import { calculateSalary, type CalculationLineItem, type SalaryCalculationInput } from '../calculation-engine'
import { TAX_FREE_REIMBURSEMENT_TYPES } from '../account-mapping'
import { BENEFIT_ITEM_TYPES } from '../benefit-payments'
import { PAYSLIP_LINE_ROLES, isBaseSalaryDisplayLine, lineTypesWithRole, type PayslipLineRole } from '../line-item-roles'
import {
  OWN_HOURLY_SALARY_LINE_MESSAGE,
  OWN_MONTHLY_SALARY_LINE_MESSAGE,
  createPayslipLine,
  updatePayslipLine,
} from '../payslip-lines'
import type { PayrollConfig } from '../payroll-config'
import { runSalaryCalculation } from '../run-calculation'
import { clearTaxTableCache } from '../tax-tables'
import { createPayrollFakeDb, type Row } from './payroll-fake-db'
import { PAYROLL_CONFIG_2026, draftRun, employee, line, rosterRow, skatteverketFetch } from './payroll-fixtures'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

vi.mock('../personnummer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../personnummer')>()
  return { ...actual, decryptPersonnummer: () => '199001011234' }
})

// ---------------------------------------------------------------------------
// Every type has a role
// ---------------------------------------------------------------------------

/** The item types of the newest salary_line_items_item_type_check in the migrations. */
function databaseItemTypes(): string[] {
  const dir = join(process.cwd(), 'supabase/migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  let latest: string | null = null
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8')
    const match = /ADD CONSTRAINT salary_line_items_item_type_check\s+CHECK \(item_type IN \(([\s\S]*?)\)\)/.exec(sql)
    if (match) latest = match[1]
  }
  if (!latest) throw new Error('no salary_line_items_item_type_check in the migrations')
  return [...latest.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

describe('PAYSLIP_LINE_ROLES', () => {
  it('names every type the database accepts, and nothing else', () => {
    expect(Object.keys(PAYSLIP_LINE_ROLES).sort()).toEqual(databaseItemTypes().sort())
  })

  it('names every type the API accepts', () => {
    for (const type of SalaryLineItemTypeSchema.options) {
      expect(PAYSLIP_LINE_ROLES[type as SalaryLineItemType], type).toBeDefined()
    }
  })

  it('agrees with the reimbursement and benefit lists the engine reads', () => {
    expect(lineTypesWithRole('reimbursement').sort()).toEqual([...TAX_FREE_REIMBURSEMENT_TYPES].sort())
    expect(lineTypesWithRole('benefit').sort()).toEqual([...BENEFIT_ITEM_TYPES].sort())
  })
})

// ---------------------------------------------------------------------------
// Every role is paid
// ---------------------------------------------------------------------------

const config2026 = {
  configYear: 2026,
  avgifterTotal: 0.3142,
  avgifterAlderspension: 0.1021,
  avgifterReduced65plus: 0.1021,
  avgifterYouthRate: 0.2081,
  avgifterYouthSalaryCap: 25000,
  avgifterVaxaStodCap: 35000,
  reducedAvgiftAge: 67,
} as unknown as PayrollConfig

function input(overrides: Partial<SalaryCalculationInput> = {}): SalaryCalculationInput {
  return {
    employmentType: 'employee',
    salaryType: 'monthly',
    monthlySalary: 30000,
    employmentDegree: 100,
    taxTableNumber: null,
    taxColumn: 1,
    isSidoinkomst: false,
    jamkningPercentage: null,
    jamkningValidFrom: null,
    jamkningValidTo: null,
    fSkattStatus: 'a_skatt',
    personnummer: 'encrypted',
    paymentDate: '2026-10-25',
    vacationRule: 'procentregeln',
    vacationDaysPerYear: 25,
    semestertillaggRate: 0.0043,
    vaxaStodEligible: false,
    vaxaStodStart: null,
    vaxaStodEnd: null,
    lineItems: [],
    ...overrides,
  }
}

const WAGE = { isTaxable: true, isAvgiftBasis: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false }

/** A line of the type with the flags and sign its role is entered with. */
function typicalLine(itemType: SalaryLineItemType, role: PayslipLineRole): CalculationLineItem {
  switch (role) {
    case 'gross_deduction':
      return { itemType, amount: -1000, ...WAGE, isVacationBasis: false, isGrossDeduction: true }
    case 'net_deduction':
      return { itemType, amount: -1000, ...WAGE, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false, isNetDeduction: true }
    case 'reimbursement':
      return { itemType, amount: 1000, ...WAGE, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false }
    case 'benefit':
      return { itemType, amount: 1000, ...WAGE, isVacationBasis: false }
    case 'absence':
      return { itemType, amount: -1000, ...WAGE, isVacationBasis: false }
    default:
      return { itemType, amount: 1000, ...WAGE }
  }
}

/** What a line can change: the pay, the tax base or the payout. */
function payFigures(lines: CalculationLineItem[], salaryType: 'monthly' | 'hourly' = 'monthly') {
  const result = calculateSalary(
    input({ salaryType, hourlyRate: 200, hoursWorked: 150, lineItems: lines }),
    config2026,
    [],
  )
  return [result.grossSalary, result.taxableIncome, result.netSalary, result.avgifterBasis]
}

describe('every accepted line type is paid', () => {
  // Words only, and the engine's own rounding output (the API refuses it).
  const notPay = new Set<PayslipLineRole>(['text', 'net_rounding'])

  it.each(SalaryLineItemTypeSchema.options.filter((t) => !notPay.has(PAYSLIP_LINE_ROLES[t as SalaryLineItemType])))(
    '%s changes the pay when added',
    (type) => {
      const itemType = type as SalaryLineItemType
      const role = PAYSLIP_LINE_ROLES[itemType]
      // A base-salary type is pay on the payslip whose base it is not.
      const salaryType = itemType === 'monthly_salary' ? 'hourly' : 'monthly'
      expect(payFigures([typicalLine(itemType, role)], salaryType)).not.toEqual(payFigures([], salaryType))
    },
  )
})

// ---------------------------------------------------------------------------
// Grundlön and Timlön in the engine
// ---------------------------------------------------------------------------

const timlon = (amount: number): CalculationLineItem => ({ itemType: 'hourly_salary', amount, ...WAGE })
const grundlon = (amount: number): CalculationLineItem => ({ itemType: 'monthly_salary', amount, ...WAGE })

describe('calculateSalary: Grundlön and Timlön rows', () => {
  it('pays extra hours at timlön on a monthly payslip as wages (crm#1331)', () => {
    // 10 h x 250 kr on top of 30 000 kr, next to the Grundlön display row.
    const result = calculateSalary(
      input({ lineItems: [grundlon(30000), timlon(2500)] }),
      config2026,
      [],
    )
    expect(result.grossSalary).toBe(32500)
    expect(result.taxableIncome).toBe(32500)
    expect(result.avgifterBasis).toBe(32500)
    // Semestergrundande: 12 % of 32 500.
    expect(result.vacationAccrual).toBe(3900)
  })

  it('reads the row like an Övrigt row with the same flags', () => {
    const asTimlon = calculateSalary(input({ lineItems: [timlon(2500)] }), config2026, [])
    const asOther = calculateSalary(input({ lineItems: [{ ...timlon(2500), itemType: 'other' }] }), config2026, [])
    expect(asTimlon.grossSalary).toBe(asOther.grossSalary)
    expect(asTimlon.vacationAccrual).toBe(asOther.vacationAccrual)
    expect(asTimlon.netSalary).toBe(asOther.netSalary)
  })

  it('earns semesterlön as variable pay under sammalöneregeln', () => {
    const result = calculateSalary(
      input({ vacationRule: 'sammaloneregeln', lineItems: [grundlon(30000), timlon(2500)] }),
      config2026,
      [],
    )
    // Tillägg 30 000 x 0,43 % x 25/12 = 268,75, plus 12 % of the 2 500.
    expect(result.vacationAccrual).toBe(568.75)
  })

  it('never counts the payslip\'s own row: Timlön on an hourly payslip, Grundlön on a monthly one', () => {
    const hourly = calculateSalary(
      input({ salaryType: 'hourly', hourlyRate: 200, hoursWorked: 150, lineItems: [timlon(30000)] }),
      config2026,
      [],
    )
    expect(hourly.grossSalary).toBe(30000)
    expect(hourly.vacationAccrual).toBe(3600)
    const monthly = calculateSalary(input({ lineItems: [grundlon(30000)] }), config2026, [])
    expect(monthly.grossSalary).toBe(30000)
    expect(monthly.vacationAccrual).toBe(3600)
  })
})

describe('isBaseSalaryDisplayLine', () => {
  it('is the base type of a given pay type, and every base type when none is known', () => {
    expect(isBaseSalaryDisplayLine('monthly_salary', ['monthly'])).toBe(true)
    expect(isBaseSalaryDisplayLine('hourly_salary', ['monthly'])).toBe(false)
    expect(isBaseSalaryDisplayLine('hourly_salary', ['monthly', 'hourly'])).toBe(true)
    expect(isBaseSalaryDisplayLine('hourly_salary', [null, undefined])).toBe(true)
    expect(isBaseSalaryDisplayLine('bonus', [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The run calculation over the in-memory payroll tables
// ---------------------------------------------------------------------------

const COMPANY = 'company-1331'
const RUN = 'run-2026-10'
const EMP = 'emp-1331'

function seed(emp: Row, lines: Row[], sreOverrides: Row = {}, extra: Partial<Record<string, Row[]>> = {}) {
  const sre = rosterRow(COMPANY, RUN, emp, sreOverrides)
  return {
    salary_payroll_config: [PAYROLL_CONFIG_2026],
    company_settings: [{ company_id: COMPANY, salary_net_rounding: false, salary_calculation_policy: {} }],
    salary_runs: [draftRun(COMPANY, RUN, { period_year: 2026, period_month: 10, payment_date: '2026-10-25' })],
    employees: [emp],
    salary_run_employees: [sre],
    salary_line_items: lines.map((fields, idx) => line(COMPANY, sre.id as string, `li-${idx}`, fields)),
    employee_opening_balances: [],
    salary_absence_days: [],
    salary_worked_days: [],
    shift_premium_rules: [],
    employee_benefits: [],
    employee_recurring_lines: [],
    ...extra,
  }
}

async function calculate(db: ReturnType<typeof createPayrollFakeDb>) {
  return runSalaryCalculation({
    supabase: db.supabase,
    companyId: COMPANY,
    salaryRunId: RUN,
    log: createLogger('test/line-item-roles'),
    requestId: 'req_1331',
  })
}

const row = (db: ReturnType<typeof createPayrollFakeDb>) => db.rows('salary_run_employees')[0] as Row
const lines = (db: ReturnType<typeof createPayrollFakeDb>) => db.rows('salary_line_items')

const GRUNDLON: Row = { item_type: 'monthly_salary', description: 'Grundlön', amount: 30000 }
const EXTRA_HOURS: Row = { item_type: 'hourly_salary', description: 'Extra timmar', quantity: 10, unit_price: 250, amount: 2500, sort_order: 5 }

describe('runSalaryCalculation: Grundlön and Timlön rows (crm#1331)', () => {
  beforeEach(() => {
    clearTaxTableCache()
    vi.stubGlobal('fetch', vi.fn(skatteverketFetch))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pays a hand-added Timlön row on a monthly payslip and keeps it across recalculations', async () => {
    const db = createPayrollFakeDb(seed(employee(COMPANY, EMP), [GRUNDLON, EXTRA_HOURS]))
    expect((await calculate(db)).ok).toBe(true)
    expect(row(db).gross_salary).toBe(32500)
    expect(row(db).vacation_accrual).toBe(3900)
    expect((await calculate(db)).ok).toBe(true)
    expect(row(db).gross_salary).toBe(32500)
    expect(lines(db).filter((li) => li.item_type === 'hourly_salary')).toHaveLength(1)
  })

  it('pays an hourly payslip its worked hours once, whatever its Timlön row says', async () => {
    const hourly = employee(COMPANY, EMP, { salary_type: 'hourly', hourly_rate: 200, monthly_salary: null })
    const worked = [1, 2, 5, 6, 7].map((day) => ({
      id: `wd-${day}`,
      company_id: COMPANY,
      employee_id: EMP,
      work_date: `2026-10-0${day}`,
      hours: 8,
      start_time: null,
      end_time: null,
    }))
    const db = createPayrollFakeDb(
      seed(hourly, [{ item_type: 'hourly_salary', description: 'Timlön', amount: 6000 }], {}, { salary_worked_days: worked }),
    )
    expect((await calculate(db)).ok).toBe(true)
    // 40 h x 200 kr, the Timlön row rewritten to it rather than added.
    expect(row(db).gross_salary).toBe(8000)
    expect(lines(db).filter((li) => li.item_type === 'hourly_salary').map((li) => li.amount)).toEqual([8000])
  })

  it('does not pay the Timlön row of a snapshot the employee has left for monthly pay', async () => {
    // The run row still says hourly; the employee is monthly now. The old
    // Timlön row is the display the calculation swaps for a Grundlön row.
    const db = createPayrollFakeDb(
      seed(employee(COMPANY, EMP), [{ item_type: 'hourly_salary', description: 'Timlön', amount: 6000 }], {
        salary_type: 'hourly',
        monthly_salary: 30000,
      }),
    )
    expect((await calculate(db)).ok).toBe(true)
    expect(row(db).gross_salary).toBe(30000)
    expect(lines(db).map((li) => li.item_type)).toEqual(['monthly_salary'])
  })
})

// ---------------------------------------------------------------------------
// The line commands
// ---------------------------------------------------------------------------

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const HOURS_INPUT = {
  item_type: 'hourly_salary' as const,
  description: 'Extra timmar',
  quantity: 10,
  unit_price: 250,
  amount: 2500,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
  sort_order: 0,
}

describe('payslip line commands: Grundlön and Timlön rows', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient
  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
  })

  function create(itemType: 'hourly_salary' | 'monthly_salary', payTypes: { snapshot: string; current: string }) {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { salary_type: payTypes.snapshot, employee: { salary_type: payTypes.current } } })
    mock.enqueue({ data: { id: LINE_ID, salary_run_employee_id: SRE_ID, ...HOURS_INPUT, item_type: itemType } })
    return createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...HOURS_INPUT, item_type: itemType },
    })
  }

  it('adds extra hours at timlön to a monthly payslip', async () => {
    const result = await create('hourly_salary', { snapshot: 'monthly', current: 'monthly' })
    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({ item_type: 'hourly_salary', amount: 2500, quantity: 10 })
  })

  it('refuses a Timlön row on an hourly payslip: its hours are the base', async () => {
    const result = await create('hourly_salary', { snapshot: 'hourly', current: 'hourly' })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'item_type', message: OWN_HOURLY_SALARY_LINE_MESSAGE },
    })
    expect(mock.findCall('salary_line_items', 'insert')).toBeUndefined()
  })

  it('refuses a Grundlön row on a monthly payslip, and on a payslip moving to monthly pay', async () => {
    expect(await create('monthly_salary', { snapshot: 'monthly', current: 'monthly' })).toMatchObject({
      ok: false,
      details: { message: OWN_MONTHLY_SALARY_LINE_MESSAGE },
    })
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
    expect(await create('hourly_salary', { snapshot: 'monthly', current: 'hourly' })).toMatchObject({
      ok: false,
      details: { field: 'item_type' },
    })
  })

  it('reads no pay type for any other line', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
    mock.enqueue({ data: { id: LINE_ID } })
    const result = await createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMPLOYEE_ID },
      input: { ...HOURS_INPUT, item_type: 'other' },
    })
    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_run_employees', 'salary_line_items'])
  })

  it('refuses retyping a line into the payslip\'s own Timlön', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({
      data: {
        id: LINE_ID,
        salary_run_employee_id: SRE_ID,
        company_id: COMPANY_ID,
        ...HOURS_INPUT,
        item_type: 'other',
        account_number: null,
        salary_run_employee: { salary_run_id: RUN_ID },
      },
    })
    mock.enqueue({ data: { salary_type: 'hourly', employee: { salary_type: 'hourly' } } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { item_type: 'hourly_salary' },
    })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'item_type' } })
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()
  })
})
