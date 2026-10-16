import { describe, expect, it } from 'vitest'
import { skattekontoPaymentsCovering } from '../skattekonto-underway'

const FETCHED = Date.parse('2026-10-16T05:00:00Z')

describe('skattekontoPaymentsCovering', () => {
  it('counts orders on their way and executed ones the saldo cannot show yet, never a draft', () => {
    const orders = [
      { amount: '1000.10', status: 'approved', executed_at: null },
      { amount: 200, status: 'awaiting_signature', executed_at: null },
      { amount: 300, status: 'executed', executed_at: '2026-10-16T08:00:00Z' }, // after the fetch: counts
      { amount: 400, status: 'executed', executed_at: '2026-10-15T08:00:00Z' }, // before the fetch: already in the saldo
      { amount: 500, status: 'draft', executed_at: null },
    ]
    expect(skattekontoPaymentsCovering(orders, FETCHED)).toBe(1500.1)
  })

  it('without a snapshot counts only the orders on their way', () => {
    const orders = [
      { amount: 100, status: 'accepted', executed_at: null },
      { amount: 300, status: 'executed', executed_at: '2026-10-16T08:00:00Z' },
    ]
    expect(skattekontoPaymentsCovering(orders, null)).toBe(100)
    expect(skattekontoPaymentsCovering([], FETCHED)).toBe(0)
  })
})
