import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'
import { extractBirthDate, validatePersonnummer } from '@/lib/salary/personnummer'
import { FALLBACK_TAX_TABLES_2026 } from '@/lib/salary/tax-tables-fallback'
import {
  SANDBOX_EMPLOYEE_LAST_NAMES,
  SANDBOX_PAYROLL_FIGURES,
  SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER,
  buildSandboxEmployees,
  buildSandboxSalaryLineItems,
  buildSandboxSalaryRunEmployees,
  buildSandboxSalaryRuns,
  mapSandboxEmployeeIds,
  resolveSandboxSalaryPeriods,
} from '../salary'

// Mid-year reference date: the previous month is May, inside the same
// calendar year, so this exercises the normal (non-January) path.
const TODAY = new Date(2026, 5, 11) // 2026-06-11, local calendar
const USER_ID = 'user-1'
const COMPANY_ID = 'company-1'

const BOOKED_RUN_ID = 'run-booked'
const DRAFT_RUN_ID = 'run-draft'
const ANNA_ID = 'emp-anna'
const ERIK_ID = 'emp-erik'

/** Records what was handed to encryptPersonnummer so the test can check it. */
function fakeEncrypt() {
  const seen: string[] = []
  return {
    seen,
    encrypt: (personnummer: string) => {
      seen.push(personnummer)
      return `cipher:${personnummer}`
    },
  }
}

function employees(today: Date = TODAY) {
  const { encrypt, seen } = fakeEncrypt()
  const rows = buildSandboxEmployees({
    userId: USER_ID,
    companyId: COMPANY_ID,
    today,
    encrypt,
  })
  return { rows, plaintext: seen }
}

function runEmployeeRows(today: Date = TODAY) {
  return buildSandboxSalaryRunEmployees({
    companyId: COMPANY_ID,
    today,
    bookedRunId: BOOKED_RUN_ID,
    draftRunId: DRAFT_RUN_ID,
    annaEmployeeId: ANNA_ID,
    erikEmployeeId: ERIK_ID,
  })
}

/**
 * PostgREST normalizes the key set across a bulk insert: a key present on one
 * row and missing on another is sent as null for the missing row, which either
 * violates NOT NULL or clobbers a schema default. Every builder must therefore
 * emit the same keys on every row.
 */
function assertUniformKeys(rows: Array<Record<string, unknown>>) {
  const reference = Object.keys(rows[0]).sort().join(',')
  for (const row of rows) {
    expect(Object.keys(row).sort().join(',')).toBe(reference)
  }
}

const AVGIFTER_RATE = 0.3142

describe('sandbox employee seed data', () => {
  it('emits two active employees with every NOT NULL column set', () => {
    const { rows } = employees()

    expect(rows).toHaveLength(2)
    assertUniformKeys(rows)

    for (const emp of rows) {
      expect(emp.user_id).toBe(USER_ID)
      expect(emp.company_id).toBe(COMPANY_ID)
      expect(emp.first_name).toBeTruthy()
      expect(emp.last_name).toBeTruthy()
      expect(emp.personnummer).toBeTruthy()
      expect(emp.personnummer_last4).toMatch(/^\d{4}$/)
      expect(emp.employment_start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(emp.is_active).toBe(true)
      expect(emp.is_sidoinkomst).toBe(false)
      expect(emp.vacation_days_per_year).toBe(25)
    }

    expect(rows.map((e) => e.last_name)).toEqual([
      SANDBOX_EMPLOYEE_LAST_NAMES.anna,
      SANDBOX_EMPLOYEE_LAST_NAMES.erik,
    ])
    // AGI FK570 specification numbers: unique per company, 1 and 2 here.
    expect(rows.map((e) => e.specification_number)).toEqual([1, 2])
    // No address at all: the payslip-send action is reachable on the seeded
    // booked run, and a demo address would mean real outbound mail from the
    // production sending domain to a domain with no MX.
    expect(rows.map((e) => e.email)).toEqual([null, null])
  })

  it('takes skatteavdrag from the real Skatteverket 2026 table, not a schablon', () => {
    const table = FALLBACK_TAX_TABLES_2026[34]
    const lookup = (income: number) =>
      table.find(([from, to]) => income >= from && income <= to)![2]

    // Column 1 of table 34: ordinary employment income, under 66.
    expect(SANDBOX_PAYROLL_FIGURES.anna.taxWithheld).toBe(lookup(38000))
    expect(SANDBOX_PAYROLL_FIGURES.erik.taxWithheld).toBe(lookup(245 * 80))

    // A flat 30 % / 24 % schablon was the previous behaviour; assert we are
    // nowhere near it, so a regression back to one fails loudly.
    expect(SANDBOX_PAYROLL_FIGURES.anna.taxWithheld).not.toBe(38000 * 0.3)
    expect(SANDBOX_PAYROLL_FIGURES.erik.taxWithheld).not.toBe(245 * 80 * 0.24)
  })

  it('satisfies every CHECK constraint in migration 20260414120000', () => {
    const { rows } = employees()

    for (const emp of rows) {
      expect(['employee', 'company_owner', 'board_member']).toContain(emp.employment_type)
      expect(['monthly', 'hourly']).toContain(emp.salary_type)
      expect(emp.tax_column as number).toBeGreaterThanOrEqual(1)
      expect(emp.tax_column as number).toBeLessThanOrEqual(6)
      // Widened twice since the original migration (20260512200000 added
      // 'none', 20260513160559 added 'semesterersattning').
      expect(['procentregeln', 'sammaloneregeln', 'none', 'semesterersattning']).toContain(
        emp.vacation_rule,
      )
      expect(['a_skatt', 'f_skatt', 'fa_skatt', 'not_verified']).toContain(emp.f_skatt_status)
      expect(emp.employment_degree as number).toBeGreaterThan(0)
      expect(emp.employment_degree as number).toBeLessThanOrEqual(100)
    }
  })

  it('stores the personnummer encrypted, with the plain last 4 alongside', () => {
    const { rows, plaintext } = employees()

    expect(plaintext).toHaveLength(2)
    for (const [i, emp] of rows.entries()) {
      const plain = plaintext[i]
      // The ciphertext, never the plaintext, goes into the column.
      expect(emp.personnummer).toBe(`cipher:${plain}`)
      expect(emp.personnummer).not.toBe(plain)
      expect(emp.personnummer_last4).toBe(plain.slice(-4))
    }
  })

  it('uses obviously fake samordningsnummer that still pass validation', () => {
    const { plaintext } = employees()

    for (const pnr of plaintext) {
      // Passes format + Luhn, so the demo user can open and save the employee
      // without the update schema rejecting the seeded row.
      expect(validatePersonnummer(pnr)).toEqual({ valid: true })
      // Day field carries the +60 samordningsnummer offset: not a real
      // person's personnummer, by construction.
      expect(Number(pnr.slice(6, 8))).toBeGreaterThan(60)
      expect(extractBirthDate(pnr).day).toBeLessThanOrEqual(31)
    }
  })

  it('pairs a monthly employee with an hourly one', () => {
    const [anna, erik] = employees().rows

    expect(anna.salary_type).toBe('monthly')
    expect(anna.monthly_salary).toBe(38000)
    expect(anna.hourly_rate).toBeNull()
    expect(anna.employment_degree).toBe(100)
    expect(anna.tax_municipality).toBe('Stockholm')

    expect(erik.salary_type).toBe('hourly')
    expect(erik.hourly_rate).toBe(245)
    expect(erik.monthly_salary).toBeNull()
    expect(erik.employment_degree).toBe(50)
  })

  it('gives both employees payable bank details', () => {
    for (const emp of employees().rows) {
      expect(
        validateEmployeeBankAccount(
          emp.clearing_number as string,
          emp.bank_account_number as string,
        ),
      ).toEqual([])
    }
  })

  it('starts both employments before the booked period', () => {
    const { rows } = employees()
    const { booked } = resolveSandboxSalaryPeriods(TODAY)
    const periodStart = `${booked.year}-${String(booked.month).padStart(2, '0')}-01`

    for (const emp of rows) {
      expect((emp.employment_start as string) < periodStart).toBe(true)
    }
    // Roughly two years and eight months back respectively.
    expect(rows[0].employment_start).toBe('2024-06-11')
    expect(rows[1].employment_start).toBe('2025-10-11')
  })

  it('resolves the inserted rows back to the two employees', () => {
    expect(
      mapSandboxEmployeeIds([
        { id: ERIK_ID, last_name: SANDBOX_EMPLOYEE_LAST_NAMES.erik },
        { id: ANNA_ID, last_name: SANDBOX_EMPLOYEE_LAST_NAMES.anna },
      ]),
    ).toEqual({ annaEmployeeId: ANNA_ID, erikEmployeeId: ERIK_ID })

    expect(() =>
      mapSandboxEmployeeIds([{ id: ANNA_ID, last_name: SANDBOX_EMPLOYEE_LAST_NAMES.anna }]),
    ).toThrow(/employee ids/)
  })
})

describe('sandbox salary run seed data', () => {
  it('emits one booked and one draft run with a legal status and series', () => {
    const runs = buildSandboxSalaryRuns({ userId: USER_ID, companyId: COMPANY_ID, today: TODAY })

    expect(runs).toHaveLength(2)
    assertUniformKeys(runs)
    expect(runs.map((r) => r.status)).toEqual(['booked', 'draft'])

    for (const run of runs) {
      expect(['draft', 'review', 'approved', 'paid', 'booked', 'corrected']).toContain(run.status)
      expect(run.voucher_series as string).toMatch(/^[A-Z]$/)
      expect(run.period_month as number).toBeGreaterThanOrEqual(1)
      expect(run.period_month as number).toBeLessThanOrEqual(12)
      expect(run.payment_date as string).toMatch(/^\d{4}-\d{2}-25$/)
      expect(run.user_id).toBe(USER_ID)
      expect(run.company_id).toBe(COMPANY_ID)
      // Non-null calculation_params is what makes the run detail page render
      // the KPI cards, Beräkningsdetaljer and the bokförings-preview.
      expect(run.calculation_params).not.toBeNull()
    }
  })

  it('completes the booked run and leaves the draft untouched', () => {
    const [booked, draft] = buildSandboxSalaryRuns({
      userId: USER_ID,
      companyId: COMPANY_ID,
      today: TODAY,
    })

    expect(booked.paid_at).toBeTruthy()
    expect(booked.booked_at).toBeTruthy()
    expect(booked.booked_by).toBe(USER_ID)
    expect(booked.approved_by).toBe(USER_ID)
    // Never stamped ahead of "today": in January the payday can still be in
    // the future when the sandbox is seeded.
    expect((booked.booked_at as string) <= '2026-06-11T23:59:59.999Z').toBe(true)

    expect(draft.paid_at).toBeNull()
    expect(draft.booked_at).toBeNull()
    expect(draft.booked_by).toBeNull()
    expect(draft.approved_at).toBeNull()
  })

  it('keeps run totals equal to the sum of the per-employee rows', () => {
    const runs = buildSandboxSalaryRuns({ userId: USER_ID, companyId: COMPANY_ID, today: TODAY })
    const perEmployee = runEmployeeRows()

    const runIdOf = (status: string) =>
      status === 'booked' ? BOOKED_RUN_ID : DRAFT_RUN_ID

    for (const run of runs) {
      const rows = perEmployee.filter((r) => r.salary_run_id === runIdOf(run.status))
      expect(rows).toHaveLength(2)

      const sum = (pick: (r: (typeof rows)[number]) => number) =>
        roundOre(rows.reduce((n, r) => n + pick(r), 0))

      expect(run.total_gross).toBe(sum((r) => r.gross_salary))
      expect(run.total_tax).toBe(sum((r) => r.tax_withheld))
      expect(run.total_net).toBe(sum((r) => r.net_salary))
      expect(run.total_avgifter).toBe(sum((r) => r.avgifter_amount))
      expect(run.total_vacation_accrual).toBe(sum((r) => r.vacation_accrual))
      expect(run.total_employer_cost).toBe(
        sum(
          (r) =>
            r.gross_salary +
            r.avgifter_amount +
            r.vacation_accrual +
            r.vacation_accrual_avgifter,
        ),
      )
    }
  })

  it('exports the vacation-avgifter total the semester voucher needs', () => {
    const rows = runEmployeeRows().filter((r) => r.salary_run_id === BOOKED_RUN_ID)

    expect(SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER).toBe(
      roundOre(rows.reduce((n, r) => n + r.vacation_accrual_avgifter, 0)),
    )
    // Not a salary_runs column: it must never leak onto the run row.
    const [booked] = buildSandboxSalaryRuns({
      userId: USER_ID,
      companyId: COMPANY_ID,
      today: TODAY,
    })
    expect(Object.keys(booked)).not.toContain('total_vacation_accrual_avgifter')
  })
})

describe('sandbox salary periods', () => {
  it('puts the booked run in the previous month during the rest of the year', () => {
    expect(resolveSandboxSalaryPeriods(new Date(2026, 5, 11))).toEqual({
      booked: { year: 2026, month: 5, paymentDate: '2026-05-25' },
      draft: { year: 2026, month: 6, paymentDate: '2026-06-25' },
    })
    expect(resolveSandboxSalaryPeriods(new Date(2026, 11, 31))).toEqual({
      booked: { year: 2026, month: 11, paymentDate: '2026-11-25' },
      draft: { year: 2026, month: 12, paymentDate: '2026-12-25' },
    })
  })

  it('keeps both January runs inside the current fiscal year', () => {
    // The sandbox seeds exactly one fiscal period, the current calendar year.
    // December of the previous year has no period to book against.
    const periods = resolveSandboxSalaryPeriods(new Date(2026, 0, 3))
    expect(periods).toEqual({
      booked: { year: 2026, month: 1, paymentDate: '2026-01-25' },
      draft: { year: 2026, month: 2, paymentDate: '2026-02-25' },
    })

    const runs = buildSandboxSalaryRuns({
      userId: USER_ID,
      companyId: COMPANY_ID,
      today: new Date(2026, 0, 3),
    })
    for (const run of runs) {
      expect(run.period_year).toBe(2026)
      expect(run.payment_date as string).toMatch(/^2026-/)
    }
    expect(runs.map((r) => r.period_month)).toEqual([1, 2])
    // And the completion stamps stay on or before "today" even though the
    // January payday has not arrived yet.
    expect(runs[0].booked_at).toBe('2026-01-03T09:00:00.000Z')
  })
})

describe('sandbox salary run employee seed data', () => {
  it('emits both employees on both runs', () => {
    const rows = runEmployeeRows()

    expect(rows).toHaveLength(4)
    assertUniformKeys(rows)
    expect(rows.filter((r) => r.salary_run_id === BOOKED_RUN_ID)).toHaveLength(2)
    expect(rows.filter((r) => r.salary_run_id === DRAFT_RUN_ID)).toHaveLength(2)

    for (const row of rows) {
      expect(row.company_id).toBe(COMPANY_ID)
      expect([ANNA_ID, ERIK_ID]).toContain(row.employee_id)
      expect(['monthly', 'hourly']).toContain(row.salary_type)
      expect(['standard', 'reduced_65plus', 'youth', 'vaxa_stod', 'exempt']).toContain(
        row.avgifter_category,
      )
      expect(row.tax_table_number).toBe(34)
      expect(row.tax_column).toBe(1)
      expect(row.tax_table_year).toBe(2026)
    }
  })

  it('keeps net = taxable - tax - net deductions on every row', () => {
    for (const row of runEmployeeRows()) {
      expect(row.net_salary).toBe(
        roundOre(row.taxable_income - row.tax_withheld - row.net_deductions),
      )
      // No förmåner in the demo, so the tax base is the gross salary.
      expect(row.taxable_income).toBe(row.gross_salary)
      expect(row.benefit_values).toBe(0)
    }
  })

  it('derives avgifter and semesteravsättning from the 2026 rates', () => {
    for (const row of runEmployeeRows()) {
      expect(row.avgifter_rate).toBe(AVGIFTER_RATE)
      expect(row.avgifter_basis).toBe(row.gross_salary)
      expect(row.avgifter_amount).toBe(roundOre(row.gross_salary * AVGIFTER_RATE))
      // Procentregeln, 25 semesterdagar.
      expect(row.vacation_accrual).toBe(roundOre(row.gross_salary * 0.12))
      expect(row.vacation_accrual_avgifter).toBe(roundOre(row.vacation_accrual * AVGIFTER_RATE))
    }
  })

  it('snapshots the monthly and hourly branches the way the engine does', () => {
    const rows = runEmployeeRows()
    const anna = rows.find((r) => r.employee_id === ANNA_ID)!
    const erik = rows.find((r) => r.employee_id === ERIK_ID)!

    expect(anna.monthly_salary).toBe(38000)
    expect(anna.hours_worked).toBeNull()
    expect(anna.gross_salary).toBe(38000)

    // createSalaryRunWithEmployees writes 0 for an hourly employee's monthly
    // salary snapshot; the gross comes from timlön × timmar.
    expect(erik.monthly_salary).toBe(0)
    expect(erik.hours_worked).toBe(80)
    expect(erik.gross_salary).toBe(roundOre(80 * 245))
  })

  it('accumulates YTD from the booked run into the draft run', () => {
    const rows = runEmployeeRows()

    for (const employeeId of [ANNA_ID, ERIK_ID]) {
      const booked = rows.find(
        (r) => r.employee_id === employeeId && r.salary_run_id === BOOKED_RUN_ID,
      )!
      const draft = rows.find(
        (r) => r.employee_id === employeeId && r.salary_run_id === DRAFT_RUN_ID,
      )!

      // The booked run is the earliest payroll in the sandbox, so its YTD is
      // its own month.
      expect(booked.ytd_gross).toBe(booked.gross_salary)
      expect(booked.ytd_tax).toBe(booked.tax_withheld)
      expect(booked.ytd_net).toBe(booked.net_salary)

      expect(draft.ytd_gross).toBe(roundOre(booked.ytd_gross + draft.gross_salary))
      expect(draft.ytd_tax).toBe(roundOre(booked.ytd_tax + draft.tax_withheld))
      expect(draft.ytd_net).toBe(roundOre(booked.ytd_net + draft.net_salary))
    }
  })

  it('carries a calculation breakdown whose skatteavdrag step names the real table', () => {
    for (const row of runEmployeeRows()) {
      const breakdown = row.calculation_breakdown as {
        steps: Array<{ label: string; formula: string; output: number | null }>
      }
      expect(breakdown.steps.length).toBeGreaterThan(0)

      const tax = breakdown.steps.find((s) => s.label.startsWith('Skatteavdrag'))!
      expect(tax.output).toBe(row.tax_withheld)
      // The step names the table it came from, and it really came from there.
      expect(tax.formula).toContain('skattetabell 34')
      expect(tax.formula).toContain('kolumn 1')

      const total = breakdown.steps.find((s) => s.label === 'Total arbetsgivarkostnad')!
      expect(total.output).toBe(
        roundOre(
          row.gross_salary +
            row.avgifter_amount +
            row.vacation_accrual +
            row.vacation_accrual_avgifter,
        ),
      )
    }
  })

  it('rounds every money column to öre', () => {
    const moneyColumns = [
      'gross_salary',
      'taxable_income',
      'tax_withheld',
      'net_salary',
      'avgifter_amount',
      'avgifter_basis',
      'vacation_accrual',
      'vacation_accrual_avgifter',
      'ytd_gross',
      'ytd_tax',
      'ytd_net',
    ] as const

    for (const row of runEmployeeRows()) {
      for (const column of moneyColumns) {
        const value = row[column]
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBe(roundOre(value))
      }
    }
  })
})

describe('sandbox salary line item seed data', () => {
  const inserted = [
    { id: 'sre-booked-anna', employee_id: ANNA_ID },
    { id: 'sre-booked-erik', employee_id: ERIK_ID },
    { id: 'sre-draft-anna', employee_id: ANNA_ID },
    { id: 'sre-draft-erik', employee_id: ERIK_ID },
  ]

  function lineItems() {
    return buildSandboxSalaryLineItems({
      companyId: COMPANY_ID,
      annaEmployeeId: ANNA_ID,
      erikEmployeeId: ERIK_ID,
      runEmployees: inserted,
    })
  }

  it('emits one payslip line per calculation row', () => {
    const rows = lineItems()

    expect(rows).toHaveLength(4)
    assertUniformKeys(rows)
    expect(rows.map((r) => r.salary_run_employee_id)).toEqual(inserted.map((r) => r.id))
    for (const row of rows) {
      expect(row.company_id).toBe(COMPANY_ID)
      expect(['monthly_salary', 'hourly_salary']).toContain(row.item_type)
      expect(row.is_taxable).toBe(true)
      expect(row.is_avgift_basis).toBe(true)
      expect(row.is_vacation_basis).toBe(true)
      expect(row.is_gross_deduction).toBe(false)
      expect(row.is_net_deduction).toBe(false)
      expect(row.sort_order).toBe(0)
    }
  })

  it('takes the BAS account from the salary account map, as a string', () => {
    for (const row of lineItems()) {
      expect(typeof row.account_number).toBe('string')
      expect(row.account_number).toBe(getLineItemAccount(row.item_type, 'employee'))
      // Ordinary employees: 7210 Löner till tjänstemän.
      expect(row.account_number).toBe('7210')
    }
  })

  it('prices the hourly line as timmar × timlön', () => {
    const rows = lineItems()
    const anna = rows.find((r) => r.salary_run_employee_id === 'sre-booked-anna')!
    const erik = rows.find((r) => r.salary_run_employee_id === 'sre-booked-erik')!

    expect(anna.item_type).toBe('monthly_salary')
    expect(anna.description).toBe('Grundlön')
    expect(anna.amount).toBe(38000)

    expect(erik.item_type).toBe('hourly_salary')
    expect(erik.description).toBe('Timlön')
    expect(erik.quantity).toBe(80)
    expect(erik.unit_price).toBe(245)
    expect(erik.amount).toBe(roundOre(80 * 245))
  })

  it('matches the gross salary on the calculation row it belongs to', () => {
    const runEmployees = runEmployeeRows()
    const rows = buildSandboxSalaryLineItems({
      companyId: COMPANY_ID,
      annaEmployeeId: ANNA_ID,
      erikEmployeeId: ERIK_ID,
      runEmployees: runEmployees.map((r, i) => ({ id: `sre-${i}`, employee_id: r.employee_id })),
    })

    for (const [i, row] of rows.entries()) {
      expect(row.amount).toBe(runEmployees[i].gross_salary)
    }
  })

  it('refuses to build a line for an unknown employee', () => {
    expect(() =>
      buildSandboxSalaryLineItems({
        companyId: COMPANY_ID,
        annaEmployeeId: ANNA_ID,
        erikEmployeeId: ERIK_ID,
        runEmployees: [{ id: 'sre-x', employee_id: 'someone-else' }],
      }),
    ).toThrow(/unknown employee/)
  })
})
