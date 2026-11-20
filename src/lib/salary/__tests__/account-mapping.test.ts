import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStandardBASAccountNumber } from '@/lib/bookkeeping/bas-account-numbers'
import {
  SALARY_LINE_ITEM_TYPES,
  baseLineItemAccount,
  isCachedDefaultAccount,
  lineItemAccount,
  netDeductionAccount,
  splitVacationLiabilityChange,
  vacationLiabilityChangeAccount,
} from '../account-mapping'

const EMPLOYMENT_TYPES = ['employee', 'company_owner', 'board_member'] as const
const CATEGORIES = ['arbetare', 'tjansteman', null] as const

describe('lineItemAccount', () => {
  it('resolves every item type for every employee to a standard BAS account', () => {
    for (const itemType of SALARY_LINE_ITEM_TYPES) {
      for (const employmentType of EMPLOYMENT_TYPES) {
        for (const personnelCategory of CATEGORIES) {
          const account = lineItemAccount(itemType, { employmentType, personnelCategory })
          expect(isStandardBASAccountNumber(account), `${itemType}/${employmentType}/${personnelCategory}: ${account}`).toBe(true)
        }
      }
    }
  })

  it('books tjänstemän on the 72xx series', () => {
    const ctx = { employmentType: 'employee', personnelCategory: 'tjansteman' }
    expect(lineItemAccount('monthly_salary', ctx)).toBe('7210')
    expect(lineItemAccount('hourly_salary', ctx)).toBe('7210')
    expect(lineItemAccount('gross_deduction_pension', ctx)).toBe('7218')
    expect(lineItemAccount('sick_day2_14', ctx)).toBe('7281')
    expect(lineItemAccount('vacation', ctx)).toBe('7285')
    expect(lineItemAccount('semesterersattning', ctx)).toBe('7285')
  })

  it('books arbetare on the 70xx series, OB and övertid with the base wage', () => {
    const ctx = { employmentType: 'employee', personnelCategory: 'arbetare' }
    for (const itemType of ['monthly_salary', 'hourly_salary', 'overtime_50', 'ob_night', 'bonus', 'unpaid_leave'] as const) {
      expect(lineItemAccount(itemType, ctx), itemType).toBe('7010')
    }
    expect(lineItemAccount('gross_deduction_pension', ctx)).toBe('7018')
    expect(lineItemAccount('sick_karens', ctx)).toBe('7081')
    expect(lineItemAccount('vacation', ctx)).toBe('7082')
    expect(lineItemAccount('semesterersattning', ctx)).toBe('7082')
  })

  it('books owners on the företagsledare accounts whatever their category says', () => {
    for (const personnelCategory of CATEGORIES) {
      const ctx = { employmentType: 'company_owner', personnelCategory }
      expect(lineItemAccount('hourly_salary', ctx)).toBe('7220')
      expect(lineItemAccount('unpaid_leave', ctx)).toBe('7220')
      expect(lineItemAccount('sick_day2_14', ctx)).toBe('7282')
      expect(lineItemAccount('semesterersattning', ctx)).toBe('7286')
    }
  })

  it('books board members on 7240 whatever their category says', () => {
    for (const personnelCategory of CATEGORIES) {
      expect(lineItemAccount('monthly_salary', { employmentType: 'board_member', personnelCategory })).toBe('7240')
    }
  })

  it('leaves the fixed accounts alone for every employee', () => {
    for (const employmentType of EMPLOYMENT_TYPES) {
      for (const personnelCategory of CATEGORIES) {
        const ctx = { employmentType, personnelCategory }
        expect(lineItemAccount('net_deduction_union', ctx)).toBe('2794')
        expect(lineItemAccount('mileage_taxfree', ctx)).toBe('7331')
        expect(lineItemAccount('oresavrundning', ctx)).toBe('3740')
        expect(lineItemAccount('expense_reimbursement', ctx)).toBe('2820')
        expect(lineItemAccount('benefit_car', ctx)).toBe('7385')
      }
    }
  })

  it('reads a missing category as tjänsteman', () => {
    expect(lineItemAccount('monthly_salary', { employmentType: 'employee' })).toBe('7210')
    expect(baseLineItemAccount('monthly_salary')).toBe('7210')
  })
})

describe('netDeductionAccount: a benefit payment books on the benefit it names (crm#1492)', () => {
  const owner = { employmentType: 'company_owner' }
  it('follows the named benefit: bostad 7381, kost 7382, bil 7385, the rest as the benefit row maps', () => {
    expect(netDeductionAccount('net_deduction_benefit_payment', 'housing', owner)).toBe('7381')
    expect(netDeductionAccount('net_deduction_benefit_payment', 'meals', owner)).toBe('7382')
    expect(netDeductionAccount('net_deduction_benefit_payment', 'car', owner)).toBe('7385')
    for (const type of ['bike', 'wellness', 'other'] as const) {
      expect(netDeductionAccount('net_deduction_benefit_payment', type, owner)).toBe(
        lineItemAccount(`benefit_${type}`, owner),
      )
    }
  })

  it('unnamed, or on another net deduction, keeps the item type default', () => {
    expect(netDeductionAccount('net_deduction_benefit_payment', null, owner)).toBe('7385')
    expect(netDeductionAccount('net_deduction_union', 'car', owner)).toBe('2794')
    expect(netDeductionAccount('net_deduction_other', undefined, owner)).toBe('2799')
  })
})

describe('vacationLiabilityChangeAccount', () => {
  it('is 7090 for arbetare and 7290 for everyone else', () => {
    expect(vacationLiabilityChangeAccount({ employmentType: 'employee', personnelCategory: 'arbetare' })).toBe('7090')
    expect(vacationLiabilityChangeAccount({ employmentType: 'employee', personnelCategory: 'tjansteman' })).toBe('7290')
    expect(vacationLiabilityChangeAccount({ employmentType: 'employee' })).toBe('7290')
    expect(vacationLiabilityChangeAccount({ employmentType: 'company_owner', personnelCategory: 'arbetare' })).toBe('7290')
    expect(vacationLiabilityChangeAccount({ employmentType: 'board_member', personnelCategory: 'arbetare' })).toBe('7290')
  })
})

describe('splitVacationLiabilityChange', () => {
  it('splits pro rata by liability and sums to the amount exactly', () => {
    const parts = splitVacationLiabilityChange(
      [
        { account: '7090', liability: 1000 },
        { account: '7290', liability: 2000 },
        { account: '7090', liability: 0 },
      ],
      100,
    )
    expect(parts).toEqual([
      { account: '7090', amount: 33.33 },
      { account: '7290', amount: 66.67 },
    ])
  })

  it('keeps the sign of a decrease', () => {
    const parts = splitVacationLiabilityChange(
      [
        { account: '7090', liability: 1 },
        { account: '7290', liability: 1 },
      ],
      -0.03,
    )
    expect(parts.reduce((sum, p) => sum + p.amount, 0)).toBeCloseTo(-0.03, 10)
    expect(parts.every((p) => p.amount < 0)).toBe(true)
  })

  it('falls back to headcount without any liability, and to 7290 without employees', () => {
    expect(
      splitVacationLiabilityChange(
        [
          { account: '7090', liability: 0 },
          { account: '7090', liability: 0 },
          { account: '7290', liability: 0 },
          { account: '7290', liability: 0 },
        ],
        10,
      ),
    ).toEqual([
      { account: '7090', amount: 5 },
      { account: '7290', amount: 5 },
    ])
    expect(splitVacationLiabilityChange([], 10)).toEqual([{ account: '7290', amount: 10 }])
    expect(splitVacationLiabilityChange([{ account: '7090', liability: 5 }], 0)).toEqual([])
  })

  it('puts everything on one account when only one category owes', () => {
    expect(
      splitVacationLiabilityChange(
        [
          { account: '7090', liability: 500 },
          { account: '7290', liability: 0 },
        ],
        123.45,
      ),
    ).toEqual([{ account: '7090', amount: 123.45 }])
  })
})

describe('isCachedDefaultAccount', () => {
  it('recognises the defaults the old write sites cached, and nothing else', () => {
    // An owner's hourly line cached 7210 at the sites without an employment
    // type, and 7220 at the others: both are defaults.
    expect(isCachedDefaultAccount('hourly_salary', '7210', 'company_owner')).toBe(true)
    expect(isCachedDefaultAccount('hourly_salary', '7220', 'company_owner')).toBe(true)
    expect(isCachedDefaultAccount('monthly_salary', '7240', 'board_member')).toBe(true)
    expect(isCachedDefaultAccount('net_deduction_union', '2794', 'employee')).toBe(true)
    // Overrides stay.
    expect(isCachedDefaultAccount('bonus', '7010', 'employee')).toBe(false)
    expect(isCachedDefaultAccount('monthly_salary', '7220', 'employee')).toBe(false)
    expect(isCachedDefaultAccount('net_deduction_benefit_payment', '7381', 'employee')).toBe(false)
    // Utlägg carry the claim's account; nothing to clear without an account.
    expect(isCachedDefaultAccount('expense_reimbursement', '2820', 'employee')).toBe(false)
    expect(isCachedDefaultAccount('bonus', null, 'employee')).toBe(false)
    expect(isCachedDefaultAccount('not_a_type', '7210', 'employee')).toBe(false)
  })
})

// The backfill migration clears cached defaults in SQL with its own value
// lists. These pin the lists to the resolver, so the SQL and
// isCachedDefaultAccount (which correct-run applies to copied lines) are one
// rule.
describe('20261015010000_salary_line_default_accounts_resolved_at_booking.sql', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261015010000_salary_line_default_accounts_resolved_at_booking.sql'),
    'utf8',
  )
  const valuesOf = (cte: string): string[][] => {
    const start = sql.indexOf(`${cte}(`)
    const body = sql.slice(sql.indexOf('values', start), sql.indexOf('\n)', start))
    return [...body.matchAll(/\(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((q) => q[1]))
  }

  it('lists the base default of every item type except utlägg', () => {
    const listed = valuesOf('base_default')
    const expected = SALARY_LINE_ITEM_TYPES.filter((t) => t !== 'expense_reimbursement').map((t) => [
      t,
      baseLineItemAccount(t),
    ])
    expect(listed).toEqual(expected)
  })

  it('lists exactly the owner and board accounts that differ from the base', () => {
    const listed = valuesOf('typed_default')
    const expected = new Set<string>()
    for (const employmentType of ['company_owner', 'board_member']) {
      for (const itemType of SALARY_LINE_ITEM_TYPES) {
        const base = baseLineItemAccount(itemType)
        const typed = lineItemAccount(itemType, { employmentType, personnelCategory: 'tjansteman' })
        if (typed !== base) expected.add(JSON.stringify([employmentType, base, typed]))
      }
    }
    expect(new Set(listed.map((row) => JSON.stringify(row)))).toEqual(expected)
  })
})
