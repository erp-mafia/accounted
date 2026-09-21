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

function vacationReport(rows: number, accruedAmount: number) {
  return {
    rows: Array.from({ length: rows }, (_, i) => ({ employee_id: `e-${i}` })),
    totals: { accruedAmount },
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

  it('still proposes a decrease when employees exist and the liability fell', async () => {
    vi.mocked(generateVacationLiability).mockResolvedValue(vacationReport(2, 50000) as never)
    vi.mocked(generateTrialBalance).mockResolvedValue(trialBalanceWith2920(80000) as never)

    const result = await assessVacationLiability({} as never, 'c1', 'p1', OPTIONS)

    expect(result.notice).toBeNull()
    expect(result.proposal!.computation).toMatchObject({ delta: -30000, employee_rows: 2 })
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
