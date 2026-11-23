/**
 * Vacation-liability proposal: anchored on the current 2920 balance, and
 * never a "zero it" card for a company whose payroll lives elsewhere.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
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

  async function assess(rows: Array<Record<string, unknown>>) {
    vi.mocked(generateVacationLiability).mockResolvedValue(report(rows) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(40000) as never)
    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)
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
  })
})
