/**
 * Vacation-liability proposal: anchored on the current 2920 balance, and
 * never a "zero it" card for a company whose payroll lives elsewhere.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  assessVacationLiability,
  buildAccrualsProposal,
  proposeVacationLiabilityChange,
} from '../accrual-detector'

vi.mock('@/lib/reports/vacation-liability', () => ({
  generateVacationLiability: vi.fn(),
}))
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

const OPTIONS = { closingDate: '2026-12-31' }

// computedLiability is the day-valued target; accruedAmount the booked
// specification, which by default restates the same figure.
function vacationReport(rows: number, computedLiability: number, accruedAmount = computedLiability) {
  return {
    rows: Array.from({ length: rows }, (_, i) => ({
      employeeId: `e-${i}`,
      accruedAmount: accruedAmount / rows,
      computedLiability: computedLiability / rows,
      liabilityChangeAccount: '7290',
    })),
    totals: { accruedAmount, computedLiability },
  }
}

function trialBalanceWith2920(credit: number, debit = 0) {
  return {
    rows: [{ account_number: '2920', closing_credit: credit, closing_debit: debit }],
  }
}

describe('assessVacationLiability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('declines with a notice when 2920 carries a balance but no employees exist', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(0, 0) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(1361046) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.proposal).toBeNull()
    expect(result.notice).toContain('på 2920')
    expect(result.notice).toContain('inga anställda')
    expect(result.notice).toContain('Ingen justering föreslås')
    // Whole kronor; the sv-SE group separator varies by ICU build.
    expect(result.notice!.replace(/\D/g, '')).toContain('1361046')
  })

  it('also declines on a debit balance, naming the absolute amount', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(0, 0) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(0, 2500) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.proposal).toBeNull()
    expect(result.notice!.replace(/\D/g, '')).toContain('2500')
  })

  it('stays silent when there are no employees and no balance', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(0, 0) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue({ rows: [] } as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result).toEqual({ proposal: null, notice: null })
  })

  it('proposes the delta as before when employees exist', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(3, 100000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.notice).toBeNull()
    expect(result.proposal).not.toBeNull()
    expect(result.proposal!.kind).toBe('vacation_liability_change')
    expect(result.proposal!.computation).toMatchObject({
      current_2920: 80000,
      closing_target: 100000,
      delta: 20000,
      employee_rows: 3,
    })
    const l2920 = result.proposal!.lines.find((l) => l.account_number === '2920')!
    expect(l2920.credit_amount).toBe(20000)
    expect(l2920.debit_amount).toBe(0)
  })

  // The booked specification restates 2920 itself, so targeting it proposed
  // ~0 whenever the runs had under- or over-accrued. The target is the
  // day-valued liability.
  it('targets the computed liability, not the booked specification', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(2, 100000, 80000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.proposal!.computation).toMatchObject({ current_2920: 80000, closing_target: 100000, delta: 20000 })
  })

  // Plan 1: the förändring side splits per category, pro rata by each
  // employee's 2920 share; 2920 stays one line.
  it('splits the change over 7090 and 7290 by each employee share', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue({
      rows: [
        { employeeId: 'e-arb', computedLiability: 75000, liabilityChangeAccount: '7090' },
        { employeeId: 'e-tj', computedLiability: 25000, liabilityChangeAccount: '7290' },
      ],
      totals: { computedLiability: 100000 },
    } as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    const lines = result.proposal!.lines
    expect(lines.filter((l) => l.account_number === '7090')).toEqual([
      expect.objectContaining({ debit_amount: 15000, credit_amount: 0 }),
    ])
    expect(lines.filter((l) => l.account_number === '7290')).toEqual([
      expect.objectContaining({ debit_amount: 5000, credit_amount: 0 }),
    ])
    expect(lines.filter((l) => l.account_number === '2920')).toEqual([
      expect.objectContaining({ debit_amount: 0, credit_amount: 20000 }),
    ])
    const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(debit).toBeCloseTo(credit, 2)
    expect(result.proposal!.description).toContain('7090/7290')
  })

  it('still proposes a decrease when employees exist and the liability fell', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(2, 50000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.notice).toBeNull()
    expect(result.proposal!.computation).toMatchObject({ delta: -30000, employee_rows: 2 })
    expect(result.proposal!.lines.find((l) => l.account_number === '7290')).toMatchObject({
      debit_amount: 0,
      credit_amount: 30000,
    })
  })
})

// A reviewer must be able to trace the target per employee and see when a
// figure rests on an estimate or a part-year employment.
describe('assessVacationLiability: the workings behind the target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function employee(over: Record<string, unknown>) {
    return {
      employeeId: 'e-1',
      employeeName: 'Anna Andersson',
      employmentStart: '2020-01-01',
      vacationRule: 'procentregeln',
      vacationDaysEntitled: 25,
      liabilityDays: 25,
      dayValue: 2400,
      dayValueEstimated: false,
      earningPay: 0,
      variablePay: 0,
      computedLiability: 60000,
      liabilityChangeAccount: '7290',
      ...over,
    }
  }

  function report(rows: Array<Record<string, unknown>>) {
    const computedLiability = rows.reduce((sum, row) => sum + (row.computedLiability as number), 0)
    return { rows, totals: { computedLiability }, vacationYearStart: '2026-01-01' }
  }

  async function assess(rows: Array<Record<string, unknown>>, employeeDetail = true) {
    vi.mocked(generateVacationLiability).mockResolvedValue(report(rows) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(40000) as never)
    const result = await assessVacationLiability({} as never, 'c1', 'p1', { ...OPTIONS, employeeDetail })
    return result.proposal!
  }

  function amounts(proposal: Awaited<ReturnType<typeof assess>>) {
    return {
      amount: proposal.amount,
      lines: proposal.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]),
    }
  }

  const UNCHANGED = {
    amount: 26284,
    lines: [
      ['7290', 20000, 0],
      ['2920', 0, 20000],
      ['7519', 6284, 0],
      ['2940', 0, 6284],
    ],
  }

  it('returns each employee: entitled and valued days, day value, estimate flag, employment start and liability', async () => {
    const proposal = await assess([
      employee({ liabilityDays: 20, earningPay: 8000, computedLiability: 56000 }),
      employee({
        employeeId: 'e-2',
        employeeName: 'Bo Berg',
        employmentStart: '2018-03-01',
        vacationRule: 'sammaloneregeln',
        liabilityDays: 4,
        dayValue: 900,
        variablePay: 400,
        computedLiability: 4000,
      }),
    ])

    expect(proposal.computation).toMatchObject({
      current_2920: 40000,
      closing_target: 60000,
      delta: 20000,
      vacation_year_start: '2026-01-01',
      employees: [
        {
          employee_id: 'e-1',
          employee_name: 'Anna Andersson',
          employment_start: '2020-01-01',
          vacation_rule: 'procentregeln',
          entitled_days: 25,
          valued_days: 20,
          day_value: 2400,
          day_value_estimated: false,
          earning_pay: 8000,
          variable_pay: 0,
          liability: 56000,
        },
        {
          employee_id: 'e-2',
          employee_name: 'Bo Berg',
          employment_start: '2018-03-01',
          vacation_rule: 'sammaloneregeln',
          entitled_days: 25,
          valued_days: 4,
          day_value: 900,
          day_value_estimated: false,
          earning_pay: 0,
          variable_pay: 400,
          liability: 4000,
        },
      ],
    })
    expect(proposal.warnings).toEqual([])
    expect(amounts(proposal)).toEqual(UNCHANGED)
  })

  it('warns when a day value is estimated from today\'s pay, and books the same amounts', async () => {
    const proposal = await assess([employee({ dayValueEstimated: true })])

    expect(proposal.warnings).toHaveLength(1)
    expect(proposal.warnings[0]).toContain('Dagvärdet är uppskattat från dagens lön för Anna Andersson')
    expect(proposal.warnings[0]).toContain('Kontrollera semesterlöneskulden innan du godkänner')
    expect(amounts(proposal)).toEqual(UNCHANGED)
  })

  it('warns when an employment started inside the intjänandeår, and books the same amounts', async () => {
    const proposal = await assess([employee({ employmentStart: '2026-09-01' })])

    expect(proposal.warnings).toHaveLength(1)
    expect(proposal.warnings[0]).toContain('Anställningen började under intjänandeåret för Anna Andersson (2026-09-01)')
    expect(proposal.warnings[0]).toContain('innan du godkänner')
    expect(amounts(proposal)).toEqual(UNCHANGED)
  })

  it('does not warn for an employment that started on the intjänandeår\'s first day', async () => {
    const proposal = await assess([employee({ employmentStart: '2026-01-01' })])

    expect(proposal.warnings).toEqual([])
  })

  // Names, employment start, day value and pay are payroll data: a caller
  // without employee detail gets the totals and counted warnings only.
  it('leaves out the employees and names nobody without employee detail', async () => {
    const proposal = await assess(
      [
        employee({ dayValueEstimated: true, employmentStart: '2026-09-01', computedLiability: 30000 }),
        employee({ employeeId: 'e-2', employeeName: 'Bo Berg', dayValueEstimated: true, computedLiability: 30000 }),
      ],
      false,
    )

    expect(proposal.computation).not.toHaveProperty('employees')
    expect(proposal.computation).toMatchObject({ current_2920: 40000, closing_target: 60000, employee_rows: 2 })
    expect(proposal.warnings).toHaveLength(2)
    expect(proposal.warnings[0]).toContain('Dagvärdet är uppskattat från dagens lön för 2 anställda:')
    expect(proposal.warnings[1]).toContain('Anställningen började under intjänandeåret för 1 anställd:')
    const text = proposal.warnings.join(' ')
    expect(text).not.toContain('Anna Andersson')
    expect(text).not.toContain('Bo Berg')
    expect(text).not.toContain('2026-09-01')
    expect(amounts(proposal)).toEqual(UNCHANGED)
  })

  it('is off unless asked for', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(report([employee({})]) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(40000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.proposal!.computation).not.toHaveProperty('employees')
  })
})

// The real vacation report and valuation over a per-table mock; only the
// trial balance (what 2920 holds) is stubbed.
describe('assessVacationLiability: procentregeln hires during a calendar intjänandeår (Semesterlagen 7 §, 16 b §)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const actual = await vi.importActual<typeof import('@/lib/reports/vacation-liability')>('@/lib/reports/vacation-liability')
    vi.mocked(generateVacationLiability).mockImplementation(actual.generateVacationLiability)
  })

  const hire = (id: string) => ({
    id,
    first_name: id,
    last_name: 'Hire',
    personnummer_last4: '0000',
    personnummer: null,
    employment_type: 'employee',
    personnel_category: 'tjansteman',
    default_dimensions: null,
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    vacation_days_saved: 0,
    vacation_pay_rate: null,
    semestertillagg_rate: 0.0043,
    salary_type: 'monthly',
    monthly_salary: 35000,
    employment_degree: 100,
    hourly_rate: null,
    hours_per_week: 40,
    workdays_per_week: 5,
    employment_start: '2026-06-01',
    employment_end: null,
  })

  /** A booked payslip whose procentregeln step carries 35 000 kr of semesterunderlag, paid the 25th. */
  const payslip = (employeeId: string, month: number) => {
    const mm = String(month).padStart(2, '0')
    return {
      employee_id: employeeId,
      calculation_breakdown: { steps: [{ label: 'Semesteravsättning (procentregeln 12 %)', input: { vacation_basis: 35000 } }] },
      salary_run: { id: `run-${mm}`, payment_date: `2026-${mm}-25`, status: 'booked' },
    }
  }
  const JUNE_TO_DECEMBER = [6, 7, 8, 9, 10, 11, 12]

  function company(payslips: ReturnType<typeof payslip>[]) {
    const { supabase } = createTableMockSupabase({
      company_settings: { data: { salary_vacation_year_basis: 'calendar', salary_calculation_policy: {} } },
      vacation_year_closures: { data: [] },
      employees: { data: [hire('e-1'), hire('e-2')] },
      employee_vacation_balances: { data: [] },
      employee_opening_balances: { data: [] },
      vacation_liability_remeasurements: { data: [] },
      // The procentregeln payslips; no vacation was taken and the booked
      // specification is not what the target reads.
      salary_run_employees: (chain: Array<{ method: string; args: unknown[] }>) => {
        const select = String(chain.find((c) => c.method === 'select')?.args[0] ?? '')
        return { data: select.includes('calculation_breakdown') ? payslips : [] }
      },
    })
    return supabase as never
  }

  const bothHires = () => [...JUNE_TO_DECEMBER.map((m) => payslip('e-1', m)), ...JUNE_TO_DECEMBER.map((m) => payslip('e-2', m))]

  it('targets 15 days each at 12 % of seven months\' pay: 58 800 kr, and proposes the difference to 2920', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(50000) as never)

    const { proposal } = await assessVacationLiability(company(bothHires()), 'c1', 'p1', { ...OPTIONS, employeeDetail: true })

    expect(proposal!.computation).toMatchObject({ current_2920: 50000, closing_target: 58800, delta: 8800 })
    const employees = (proposal!.computation as { employees: Array<Record<string, unknown>> }).employees
    expect(employees).toHaveLength(2)
    for (const employee of employees) {
      expect(employee).toMatchObject({
        employment_start: '2026-06-01',
        entitled_days: 15,
        valued_days: 15,
        day_value: 1960,
        day_value_estimated: false,
        earning_pay: 0,
        liability: 29400,
      })
    }
    expect(proposal!.lines.find((l) => l.account_number === '2920')).toMatchObject({ credit_amount: 8800, debit_amount: 0 })
    expect(proposal!.warnings.some((w) => w.includes('uppskattat'))).toBe(false)
  })

  it('proposes nothing when 2920 holds what the runs accrued (7 x 4 200 kr each); the flat 25 days proposed +42 000 kr', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(58800) as never)

    const { proposal, notice } = await assessVacationLiability(company(bothHires()), 'c1', 'p1', OPTIONS)

    expect(proposal).toBeNull()
    expect(notice).toBeNull()
  })

  it('an employee whose payslips are missing still gets today\'s-pay estimate, flagged with the warning', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(50000) as never)
    const withoutAugust = bothHires().filter((p) => !(p.employee_id === 'e-2' && p.salary_run.payment_date === '2026-08-25'))

    const { proposal } = await assessVacationLiability(company(withoutAugust), 'c1', 'p1', { ...OPTIONS, employeeDetail: true })

    const employees = (proposal!.computation as { employees: Array<Record<string, unknown>> }).employees
    expect(employees.find((e) => e.employee_id === 'e-1')).toMatchObject({ day_value_estimated: false, liability: 29400 })
    // 15 days (not 25) at 35 000 x 12 x 12 % / 25.
    expect(employees.find((e) => e.employee_id === 'e-2')).toMatchObject({ day_value_estimated: true, day_value: 2016, liability: 30240 })
    expect(proposal!.computation).toMatchObject({ closing_target: 59640 })
    expect(proposal!.warnings).toContain(
      'Dagvärdet är uppskattat från dagens lön för e-2 Hire: lönebesked för intjänandeåret saknas i Accounted. Kontrollera semesterlöneskulden innan du godkänner.',
    )
  })
})

describe('proposeVacationLiabilityChange', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null for the declined case so the POST route books nothing', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(0, 0) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(1361046) as never)

    await expect(proposeVacationLiabilityChange({} as never, 'c1', 'p1', OPTIONS)).resolves.toBeNull()
  })
})

describe('buildAccrualsProposal', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
    vi.clearAllMocks()
  })

  it('carries the notice instead of a proposal when the detector declined', async () => {
    mock.enqueue({
      data: { id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    })
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(0, 0) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(1361046) as never)

    const snapshot = await buildAccrualsProposal(mock.supabase as never, 'c1', 'p1')

    expect(snapshot.proposals).toEqual([])
    expect(snapshot.notices).toHaveLength(1)
    expect(snapshot.notices[0]).toContain('inga anställda')
  })

  it('has empty notices when a proposal was made', async () => {
    mock.enqueue({
      data: { id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    })
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(1, 100000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const snapshot = await buildAccrualsProposal(mock.supabase as never, 'c1', 'p1')

    expect(snapshot.proposals).toHaveLength(1)
    expect(snapshot.notices).toEqual([])
    expect(snapshot.proposals[0].computation).not.toHaveProperty('employees')
  })

  it('lists the employees when asked for employee detail', async () => {
    mock.enqueue({
      data: { id: 'p1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    })
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(1, 100000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const snapshot = await buildAccrualsProposal(mock.supabase as never, 'c1', 'p1', { employeeDetail: true })

    expect(snapshot.proposals[0].computation).toMatchObject({ employees: [expect.objectContaining({ employee_id: 'e-0' })] })
  })
})
