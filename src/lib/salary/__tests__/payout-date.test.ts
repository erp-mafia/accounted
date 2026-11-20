/**
 * crm#1216: a salary run marked paid and booked days before its payment date
 * posted a bank payout that had not happened, with nothing asking first.
 */
import { describe, it, expect } from 'vitest'
import { isPaymentDateAhead, needsFuturePayoutConfirm, paymentDateAheadRefusal } from '../payout-date'

describe('isPaymentDateAhead', () => {
  const today = '2026-10-15'

  it('is true for a payment date after today', () => {
    expect(isPaymentDateAhead('2026-10-23', today)).toBe(true)
    expect(isPaymentDateAhead('2026-10-16', today)).toBe(true)
  })

  it('is false on the payment date itself and after it', () => {
    expect(isPaymentDateAhead('2026-10-15', today)).toBe(false)
    expect(isPaymentDateAhead('2026-09-25', today)).toBe(false)
  })

  it('compares across a month and a year boundary', () => {
    expect(isPaymentDateAhead('2027-01-02', '2026-12-31')).toBe(true)
    expect(isPaymentDateAhead('2026-12-31', '2027-01-02')).toBe(false)
  })

  it('is false without a payment date', () => {
    expect(isPaymentDateAhead(null, today)).toBe(false)
    expect(isPaymentDateAhead(undefined, today)).toBe(false)
    expect(isPaymentDateAhead('', today)).toBe(false)
  })

  it('defaults to the Stockholm calendar day', () => {
    expect(isPaymentDateAhead('1999-01-01')).toBe(false)
    expect(isPaymentDateAhead('2999-01-01')).toBe(true)
  })
})

describe('needsFuturePayoutConfirm', () => {
  const today = '2026-10-15'

  it('asks when the run pays out and the payment date is ahead (the crm#1216 case)', () => {
    expect(needsFuturePayoutConfirm('2026-10-23', false, today)).toBe(true)
  })

  it('goes straight on once the payment date has come', () => {
    expect(needsFuturePayoutConfirm('2026-10-15', false, today)).toBe(false)
    expect(needsFuturePayoutConfirm('2026-10-01', false, today)).toBe(false)
  })

  it('never asks for a run with no payout: there is nothing to have paid', () => {
    expect(needsFuturePayoutConfirm('2026-10-23', true, today)).toBe(false)
  })
})

describe('paymentDateAheadRefusal (the server-side rule every door shares)', () => {
  const today = '2026-10-15'
  const run = { payment_date: '2026-10-23', total_net: 23000 }

  it('refuses a payout ahead of its payment date without the confirmation', () => {
    expect(paymentDateAheadRefusal(run, undefined, today)).toEqual({
      ok: false,
      code: 'SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED',
      details: { payment_date: '2026-10-23', today },
    })
    expect(paymentDateAheadRefusal(run, false, today)).not.toBeNull()
  })

  it('lets a confirmed one through', () => {
    expect(paymentDateAheadRefusal(run, true, today)).toBeNull()
  })

  it('lets the payment date itself and any later day through', () => {
    expect(paymentDateAheadRefusal({ ...run, payment_date: today }, undefined, today)).toBeNull()
    expect(paymentDateAheadRefusal(run, undefined, '2026-10-24')).toBeNull()
  })

  it('never refuses a run with nothing paid out (net rounds to 0 öre)', () => {
    expect(paymentDateAheadRefusal({ ...run, total_net: 0 }, undefined, today)).toBeNull()
    expect(paymentDateAheadRefusal({ ...run, total_net: 0.004 }, undefined, today)).toBeNull()
    expect(paymentDateAheadRefusal({ ...run, total_net: null }, undefined, today)).toBeNull()
  })
})
