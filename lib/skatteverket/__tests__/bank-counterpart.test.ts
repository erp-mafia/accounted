import { describe, it, expect } from 'vitest'
import {
  findBankSkvCounterparts,
  BANK_SKV_DATE_WINDOW_DAYS,
} from '../bank-counterpart'
import type { StoredSkattekontoTransaction } from '@/types/skatteverket'

function skv(
  partial: Partial<StoredSkattekontoTransaction> &
    Pick<StoredSkattekontoTransaction, 'id' | 'transaktionsdatum' | 'belopp_skatteverket'>,
): Pick<StoredSkattekontoTransaction, 'id' | 'transaktionsdatum' | 'belopp_skatteverket'> {
  return partial
}

describe('findBankSkvCounterparts', () => {
  it('pairs a -5000 bank outflow with a +5000 SKV inflow within window', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000 })],
    })
    expect(result.get('bank-1')).toBe('2026-03-17')
  })

  it('pairs a +5000 bank inflow (refund) with a -5000 SKV outflow', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-20', amount: 5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-19', belopp_skatteverket: -5000 })],
    })
    expect(result.get('bank-1')).toBe('2026-03-19')
  })

  it('does NOT pair when signs are equal (not a transfer)', () => {
    // Bank -5000 (outgoing) and SKV -5000 (outgoing from skattekonto)
    // would mean the user both paid 5000 from bank AND was charged 5000
    // by SKV. Not the same event: independent cash flows.
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: -5000 })],
    })
    expect(result.has('bank-1')).toBe(false)
  })

  it('does NOT pair when amounts differ even slightly', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000.01 })],
    })
    expect(result.has('bank-1')).toBe(false)
  })

  it('rounds to öre: 5000.001 equals 5000', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [
        skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000.001 }),
      ],
    })
    expect(result.get('bank-1')).toBe('2026-03-17')
  })

  it('does NOT pair when SKV date is outside the ±14 day window', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-01', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-20', belopp_skatteverket: 5000 })],
    })
    expect(result.has('bank-1')).toBe(false)
  })

  it('pairs at the exact 14-day boundary', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-01', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-15', belopp_skatteverket: 5000 })],
    })
    expect(result.get('bank-1')).toBe('2026-03-15')
  })

  it('first plausible match wins when multiple SKV rows would qualify', () => {
    // Two SKV inflows of 5000 within window: the first one (in iteration
    // order) wins. UI only shows one hint, so we don't need to rank.
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [
        skv({ id: 'skv-a', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000 }),
        skv({ id: 'skv-b', transaktionsdatum: '2026-03-15', belopp_skatteverket: 5000 }),
      ],
    })
    expect(result.get('bank-1')).toBe('2026-03-17')
  })

  it('handles multiple bank txs independently', () => {
    const result = findBankSkvCounterparts({
      bankRows: [
        { id: 'bank-a', date: '2026-03-16', amount: -5000 },
        { id: 'bank-b', date: '2026-04-16', amount: -3000 },
      ],
      skvRows: [
        skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000 }),
        skv({ id: 'skv-2', transaktionsdatum: '2026-04-18', belopp_skatteverket: 3000 }),
      ],
    })
    expect(result.size).toBe(2)
    expect(result.get('bank-a')).toBe('2026-03-17')
    expect(result.get('bank-b')).toBe('2026-04-18')
  })

  it('ignores zero-amount bank tx', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: 0 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 0 })],
    })
    expect(result.has('bank-1')).toBe(false)
  })

  it('returns empty map when no SKV rows are provided', () => {
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-16', amount: -5000 }],
      skvRows: [],
    })
    expect(result.size).toBe(0)
  })

  it('returns empty map when no bank rows are provided', () => {
    const result = findBankSkvCounterparts({
      bankRows: [],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-17', belopp_skatteverket: 5000 })],
    })
    expect(result.size).toBe(0)
  })

  it('respects a custom dateWindowDays override', () => {
    // 20 days apart: would fail default window, passes with override.
    const result = findBankSkvCounterparts({
      bankRows: [{ id: 'bank-1', date: '2026-03-01', amount: -5000 }],
      skvRows: [skv({ id: 'skv-1', transaktionsdatum: '2026-03-21', belopp_skatteverket: 5000 })],
      dateWindowDays: 30,
    })
    expect(result.get('bank-1')).toBe('2026-03-21')
  })

  it('exposes a sensible default window constant', () => {
    expect(BANK_SKV_DATE_WINDOW_DAYS).toBe(14)
  })
})
