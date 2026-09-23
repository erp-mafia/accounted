import { describe, it, expect } from 'vitest'
import {
  groupExpenseClaimsByPerson,
  matchTransactionsToExpensePayouts,
} from '../expense-payout-candidates'

const anna = { key: 'emp-1', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', claim_count: 2, claim_ids: ['c2', 'c3'], total_sek: 1596, oldest_expense_date: '2026-09-02' }
const owner = { key: 'owner:Jakob', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', claim_count: 1, claim_ids: ['c1'], total_sek: 1240, oldest_expense_date: '2026-09-03' }

describe('groupExpenseClaimsByPerson', () => {
  it('sums per person in öre-safe arithmetic and keeps claim ids in date order', () => {
    const out = groupExpenseClaimsByPerson([
      { id: 'a', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: '0.1', expense_date: '2026-09-01' },
      { id: 'b', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: 0.2, expense_date: '2026-09-02' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].total_sek).toBe(0.3)
    expect(out[0].claim_ids).toEqual(['a', 'b'])
  })

  it('treats "Jakob" and "jakob " as one owner, the way the payout RPC does', () => {
    const out = groupExpenseClaimsByPerson([
      { id: 'a', employee_id: null, claimant_name: 'Jakob', liability_account: '2893', amount_sek: 100, expense_date: '2026-09-01' },
      { id: 'b', employee_id: null, claimant_name: 'jakob ', liability_account: '2893', amount_sek: 50, expense_date: '2026-09-02' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ key: 'owner:jakob', claimant_name: 'Jakob', total_sek: 150, claim_ids: ['a', 'b'] })
  })

  it('leaves an enskild firma owner out: egen insättning is not a debt', () => {
    const out = groupExpenseClaimsByPerson([
      { id: 'a', employee_id: null, claimant_name: 'Sara', liability_account: '2018', amount_sek: 500, expense_date: '2026-09-01' },
      { id: 'b', employee_id: 'emp-1', claimant_name: 'Anna Berg', liability_account: '2820', amount_sek: 200, expense_date: '2026-09-02' },
    ])
    expect(out.map((p) => p.key)).toEqual(['emp-1'])
  })
})

describe('matchTransactionsToExpensePayouts', () => {
  it('pairs an SEK outflow with the one person owed exactly that amount', () => {
    const m = matchTransactionsToExpensePayouts(
      [{ id: 'tx-1', amount: -1596, currency: 'SEK', is_business: null, journal_entry_id: null }],
      [anna, owner],
    )
    expect(m.get('tx-1')?.person.key).toBe('emp-1')
  })

  it('ignores inflows, booked rows, foreign currency and near misses', () => {
    const m = matchTransactionsToExpensePayouts(
      [
        { id: 'in', amount: 1596, currency: 'SEK', is_business: null, journal_entry_id: null },
        { id: 'booked', amount: -1596, currency: 'SEK', is_business: true, journal_entry_id: 'je' },
        { id: 'eur', amount: -1596, currency: 'EUR', is_business: null, journal_entry_id: null },
        { id: 'near', amount: -1596.01, currency: 'SEK', is_business: null, journal_entry_id: null },
      ],
      [anna],
    )
    expect(m.size).toBe(0)
  })

  it('skips a total two people share: the amount alone cannot say who', () => {
    const twin = { ...owner, key: 'owner:Emil', claimant_name: 'Emil', total_sek: 1596 }
    const m = matchTransactionsToExpensePayouts(
      [{ id: 'tx-1', amount: -1596, currency: 'SEK', is_business: null, journal_entry_id: null }],
      [anna, twin],
    )
    expect(m.size).toBe(0)
  })
})
