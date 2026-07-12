import { describe, it, expect } from 'vitest'
import {
  proposeAvsattning,
  proposeAteforing,
  getPeriodiseringsfondCohortAccount,
  PFOND_AB_RATE,
  PFOND_MAX_HOLD_YEARS,
  type ExistingFond,
} from '../reserves/periodiseringsfond-service'

describe('getPeriodiseringsfondCohortAccount', () => {
  it('maps fiscal year to BAS 212X account', () => {
    expect(getPeriodiseringsfondCohortAccount(2020)).toBe('2120')
    expect(getPeriodiseringsfondCohortAccount(2025)).toBe('2125')
    expect(getPeriodiseringsfondCohortAccount(2026)).toBe('2126')
    expect(getPeriodiseringsfondCohortAccount(2027)).toBe('2127')
  })

  it('returns 2129 for 2019 per BAS collision rule', () => {
    expect(getPeriodiseringsfondCohortAccount(2019)).toBe('2129')
  })
})

describe('proposeAvsattning', () => {
  it('caps avsättning at 25% of base', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      desiredAmount: 200_000, // user asks for 50%: should be capped
      fiscalYear: 2025,
    })
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(100_000) // 25% of 400_000
    expect(result!.warnings).toHaveLength(1)
    expect(result!.warnings[0]).toContain('25 %')
    expect(result!.lines[0].account_number).toBe('8811')
    expect(result!.lines[1].account_number).toBe('2125')
  })

  it('defaults to maximum when desiredAmount is omitted', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      fiscalYear: 2025,
    })
    expect(result!.amount).toBe(100_000)
    expect(result!.warnings).toHaveLength(0)
  })

  it('honors a smaller desiredAmount', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      desiredAmount: 30_000,
      fiscalYear: 2025,
    })
    expect(result!.amount).toBe(30_000)
    expect(result!.warnings).toHaveLength(0)
  })

  it('returns null when base is negative (loss year)', () => {
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: -100_000,
        fiscalYear: 2025,
      }),
    ).toBeNull()
  })

  it('returns null when desired is zero', () => {
    expect(
      proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: 400_000,
        desiredAmount: 0,
        fiscalYear: 2025,
      }),
    ).toBeNull()
  })

  it('emits balanced lines (debit 8811 = credit 21XX)', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 400_000,
      fiscalYear: 2026,
    })
    expect(result!.lines).toHaveLength(2)
    const totalDebit = result!.lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = result!.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
    expect(result!.lines[1].account_number).toBe('2126')
  })

  it('uses fiscal year for cohort account number', () => {
    const result = proposeAvsattning({
      skattemassigtResultatBeforeAvsattning: 100_000,
      fiscalYear: 2027,
    })
    expect(result!.lines[1].account_number).toBe('2127')
  })
})

describe('proposeAteforing', () => {
  it('forces full reversal of 6+ year old fonder and marks them required', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 50_000,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].amount).toBe(50_000)
    expect(result.proposals[0].required).toBe(true)
    expect(result.proposals[0].warnings[0]).toContain('6-årsgränsen')
    // 50_000 × 0.03 = 1500
    expect(result.schablonintaktAmount).toBe(1_500)
  })

  it('skips non-mandatory fonder when no return amount requested', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2122',
        cohort_year: 2022,
        balance: 100_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    expect(result.proposals).toHaveLength(0)
    // Schablonintäkt is computed regardless of return decision
    expect(result.schablonintaktAmount).toBe(3_000)
  })

  it('returns the requested optional amount when user opts in', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2123',
        cohort_year: 2023,
        balance: 80_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, {
      returns: { '2123': 50_000 },
      schablonintaktRate: 0.03,
    })
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].amount).toBe(50_000)
    expect(result.proposals[0].required).toBeFalsy()
  })

  it('caps optional returns to the actual balance', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2124',
        cohort_year: 2024,
        balance: 30_000,
        must_return_this_year: false,
      },
    ]
    const result = proposeAteforing(fonder, {
      returns: { '2124': 100_000 },
      schablonintaktRate: 0.03,
    })
    expect(result.proposals[0].amount).toBe(30_000) // capped to balance
  })

  it('emits balanced lines (debit 21XX = credit 8819)', () => {
    const fonder: ExistingFond[] = [
      {
        account_number: '2120',
        cohort_year: 2020,
        balance: 50_000,
        must_return_this_year: true,
      },
    ]
    const result = proposeAteforing(fonder, { schablonintaktRate: 0.03 })
    const lines = result.proposals[0].lines
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2120')
    expect(lines[0].debit_amount).toBe(50_000)
    expect(lines[1].account_number).toBe('8819')
    expect(lines[1].credit_amount).toBe(50_000)
  })

  it('exposes constants used by callers', () => {
    expect(PFOND_AB_RATE).toBe(0.25)
    expect(PFOND_MAX_HOLD_YEARS).toBe(6)
  })
})
