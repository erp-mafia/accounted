import { describe, it, expect } from 'vitest'
import { isOwnerLoanInterestAccount, kuSignalTriggers, type KuSignalLine } from '../ku-signal'

function line(id: string, account: string, debit: number, credit: number, date = '2026-06-30'): KuSignalLine {
  return { journal_entry_id: id, account_number: account, debit_amount: debit, credit_amount: credit, entry_date: date }
}

describe('kuSignalTriggers', () => {
  it('an interest-free ägarlån is no trigger: the loan alone reports nothing (crm#1171)', () => {
    expect(kuSignalTriggers([
      line('in', '2393', 0, 4000),
      line('out', '2893', 1500, 0),
    ])).toEqual([])
  })

  it('interest added to the loan (D 84xx / K 2393) is', () => {
    expect(kuSignalTriggers([line('a', '8410', 2400, 0), line('a', '2393', 0, 2400)])).toEqual([
      { kind: 'owner_loan_interest', year: 2026, amount: 2400, interest_accounts: ['8410'], loan_accounts: ['2393'] },
    ])
  })

  it('interest paid with an amortisation (D 2893 + D 8429 / K 1930) is', () => {
    expect(kuSignalTriggers([line('a', '2893', 10000, 0), line('a', '8429', 350, 0)])).toEqual([
      { kind: 'owner_loan_interest', year: 2026, amount: 350, interest_accounts: ['8429'], loan_accounts: ['2893'] },
    ])
  })

  it('interest on a verifikat without a loan line cannot be told from bank interest and is not counted', () => {
    expect(kuSignalTriggers([line('a', '8410', 5000, 0)])).toEqual([])
  })

  it('sums per calendar year and needs 100 kr in a year (SFL 17 kap. 4 § 2)', () => {
    expect(kuSignalTriggers([
      line('a', '8410', 60, 0, '2025-06-30'), line('a', '2393', 0, 60, '2025-06-30'),
      line('b', '8410', 39.99, 0, '2025-12-31'), line('b', '2393', 0, 39.99, '2025-12-31'),
      line('c', '8410', 50, 0, '2026-06-30'), line('c', '2393', 0, 50, '2026-06-30'),
      line('d', '8410', 50, 0, '2026-12-31'), line('d', '2393', 0, 50, '2026-12-31'),
    ])).toEqual([
      { kind: 'owner_loan_interest', year: 2026, amount: 100, interest_accounts: ['8410'], loan_accounts: ['2393'] },
    ])
  })

  it('leaves tax interest and supplier late interest out even beside a loan line', () => {
    expect(isOwnerLoanInterestAccount('8423')).toBe(false)
    expect(isOwnerLoanInterestAccount('8422')).toBe(false)
    expect(isOwnerLoanInterestAccount('8430')).toBe(false)
    expect(isOwnerLoanInterestAccount('8400')).toBe(true)
    expect(isOwnerLoanInterestAccount('8429')).toBe(true)
    expect(kuSignalTriggers([line('a', '8423', 500, 0), line('a', '2893', 0, 500)])).toEqual([])
  })

  it('skips excluded verifikat (the bokslutsverifikat)', () => {
    expect(kuSignalTriggers(
      [line('closing', '8410', 0, 900), line('closing', '2393', 900, 0)],
      new Set(['closing']),
    )).toEqual([])
  })

  it('reports utdelning paid out, or decided when nothing is paid yet', () => {
    expect(kuSignalTriggers([line('d', '2898', 0, 80000), line('p', '2898', 80000, 0)])).toEqual([
      { kind: 'dividend', account_number: '2898', amount: 80000 },
    ])
    expect(kuSignalTriggers([line('d', '2898', 0, 80000)])).toEqual([
      { kind: 'dividend', account_number: '2898', amount: 80000 },
    ])
  })
})
