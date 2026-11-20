import { describe, it, expect } from 'vitest'
import { futurePaymentDateRefusal } from '../payment-date'

describe('futurePaymentDateRefusal', () => {
  it('takes today and every day before it', () => {
    expect(futurePaymentDateRefusal('2026-11-01', '2026-11-01')).toBeNull()
    expect(futurePaymentDateRefusal('2026-10-31', '2026-11-01')).toBeNull()
  })

  it('refuses a day ahead of today, naming both', () => {
    expect(futurePaymentDateRefusal('2026-11-02', '2026-11-01')).toEqual({
      code: 'PAYMENT_DATE_IN_FUTURE',
      details: { field: 'payment_date', attempted: '2026-11-02', today: '2026-11-01' },
    })
  })

  it('reads today in Sweden when it is not told: a far date is always ahead', () => {
    expect(futurePaymentDateRefusal('2099-01-01')).toMatchObject({ code: 'PAYMENT_DATE_IN_FUTURE' })
    expect(futurePaymentDateRefusal('2020-01-01')).toBeNull()
  })
})
