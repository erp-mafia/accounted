import { describe, expect, it } from 'vitest'
import { reconcileLoanAccounts } from '../reconcile'
import { buildBoardLoansNote } from '../arl-note'
import type { OwnerLoanRow } from '../loans'

type Loan = Pick<OwnerLoanRow, 'id' | 'kind' | 'account' | 'outstanding' | 'status' | 'start_date' | 'repaid_on'>

function loan(over: Partial<Loan> = {}): Loan {
  return { id: 'loan-1', kind: 'loan', account: '2893', outstanding: 200_000, status: 'active', start_date: '2026-03-01', repaid_on: null, ...over }
}

describe('reconcileLoanAccounts', () => {
  it('a loan from an owner on 2893 matches the credit balance in the ledger', () => {
    const [row] = reconcileLoanAccounts([loan()], new Map([['2893', -200_000]]), '2026-12-31')
    expect(row).toEqual({ account: '2893', register_amount: 200_000, ledger_amount: 200_000, difference: 0, matches: true, owner_loan_ids: ['loan-1'] })
  })

  it('a loan to an owner on 1685 reads the debit balance; a difference is reported, not corrected', () => {
    const [row] = reconcileLoanAccounts([loan({ account: '1685', outstanding: 50_000 })], new Map([['1685', 30_000]]), '2026-12-31')
    expect(row).toMatchObject({ register_amount: 50_000, ledger_amount: 30_000, difference: -20_000, matches: false })
  })

  it('sums the loans on one account; leaves out securities, repaid loans and loans not yet started', () => {
    const rows = reconcileLoanAccounts(
      [
        loan(),
        loan({ id: 'loan-2', outstanding: 100_000 }),
        loan({ id: 'loan-3', outstanding: 0, status: 'repaid', repaid_on: '2026-06-30' }),
        loan({ id: 'loan-4', start_date: '2027-01-15', outstanding: 999 }),
        loan({ id: 'sec-1', kind: 'security', account: null, outstanding: 75_000 }),
        loan({ id: 'loan-5', account: '2393', status: 'repaid', repaid_on: '2026-02-01', outstanding: 0, start_date: '2025-01-01' }),
      ],
      new Map([['2893', -300_000], ['2393', -10_000]]),
      '2026-12-31',
    )
    expect(rows).toEqual([
      { account: '2393', register_amount: 0, ledger_amount: 10_000, difference: 10_000, matches: false, owner_loan_ids: [] },
      { account: '2893', register_amount: 300_000, ledger_amount: 300_000, difference: 0, matches: true, owner_loan_ids: ['loan-1', 'loan-2'] },
    ])
  })

  it('a ledger read that failed is unknown, never a match', () => {
    expect(reconcileLoanAccounts([loan()], new Map([['2893', null]]), '2026-12-31')[0]).toMatchObject({ ledger_amount: null, difference: null, matches: null })
  })
})

describe('buildBoardLoansNote (ÅRL 5:18)', () => {
  it('no loan or security to the board or VD: no note', () => {
    expect(buildBoardLoansNote('2026-12-31', [])).toMatchObject({ applicable: false, text_sv: null, categories: [] })
  })

  it('amounts per category with interest and terms, no names', () => {
    const note = buildBoardLoansNote('2026-12-31', [
      { kind: 'loan', amount: 50_000, interest_rate: 3.5, terms: 'Amorteras månadsvis.', category: 'ceo' },
      { kind: 'loan', amount: 20_000, interest_rate: null, terms: null, category: 'board' },
      { kind: 'security', amount: 100_000, interest_rate: null, terms: null, category: 'board' },
    ])
    expect(note.applicable).toBe(true)
    expect(note.categories.map((c) => [c.category, c.loans_total, c.securities_total])).toEqual([
      ['board', 20_000, 100_000],
      ['ceo', 50_000, 0],
    ])
    expect(note.text_sv).toContain('lån till styrelseledamöter och styrelsesuppleanter med sammanlagt 20 000 kr')
    expect(note.text_sv).toContain('ställt säkerhet för styrelseledamöter och styrelsesuppleanter med sammanlagt 100 000 kr')
    expect(note.text_sv).toContain('verkställande direktör och vice verkställande direktör med sammanlagt 50 000 kr: 50 000 kr (räntesats 3,5 %, villkor: Amorteras månadsvis)')
  })
})
