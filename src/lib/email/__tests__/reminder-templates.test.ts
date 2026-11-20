import { describe, it, expect } from 'vitest'
import { calculateReminderAmounts, REMINDER_FEE_CURRENCY } from '../reminder-templates'

describe('REMINDER_FEE_CURRENCY', () => {
  it('quotes the statutory fee in SEK (Lag 1981:739)', () => {
    expect(REMINDER_FEE_CURRENCY).toBe('SEK')
  })
})

describe('calculateReminderAmounts', () => {
  it('folds the fee into the total for a SEK invoice', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 10_000,
        interestAmount: 86.3,
        reminderFee: 60,
        currency: 'SEK',
      }),
    ).toEqual({ currency: 'SEK', totalDue: 10_146.3, feeDueSeparately: 0 })
  })

  it('keeps the SEK fee out of a foreign-currency total', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 1_000,
        interestAmount: 10,
        reminderFee: 60,
        currency: 'EUR',
      }),
    ).toEqual({ currency: 'EUR', totalDue: 1_010, feeDueSeparately: 60 })
  })

  it('treats a missing currency as SEK', () => {
    expect(
      calculateReminderAmounts({
        invoiceTotal: 100,
        interestAmount: 0,
        reminderFee: 60,
        currency: null,
      }),
    ).toEqual({ currency: 'SEK', totalDue: 160, feeDueSeparately: 0 })
  })

  it('rounds with Math.round(x * 100) / 100, not toFixed', () => {
    const amounts = calculateReminderAmounts({
      invoiceTotal: 1_000.005,
      interestAmount: 0.011,
      reminderFee: 0,
      currency: 'SEK',
    })
    expect(amounts.totalDue).toBe(1_000.02)
  })
})
