import { describe, it, expect } from 'vitest'
import { paymentMethodsSeen } from '../booking-lines'

describe('paymentMethodsSeen', () => {
  it('lists each method once, first-seen order, with its title', () => {
    expect(
      paymentMethodsSeen([
        { payment_method: 'SWISH', payment_method_title: 'Swish', status: 'paid' },
        { payment_method: 'IZETTLE_CARD', payment_method_title: 'Kort', status: 'paid' },
        { payment_method: 'SWISH', payment_method_title: 'Swish', status: 'refunded' },
      ]),
    ).toEqual([
      { method: 'SWISH', title: 'Swish' },
      { method: 'IZETTLE_CARD', title: 'Kort' },
    ])
  })

  it('skips rows without a payment method (Shopify sends an empty gateway name)', () => {
    expect(
      paymentMethodsSeen([
        { payment_method: null, payment_method_title: null, status: 'paid' },
        { payment_method: '', payment_method_title: null, status: 'paid' },
      ]),
    ).toEqual([])
  })

  it('never takes a needs_review title as the method name, and lets a later row name it', () => {
    // Zettle stores why a purchase is held in the title of a needs_review row.
    expect(
      paymentMethodsSeen([
        {
          payment_method: 'IZETTLE_CARD',
          payment_method_title: 'Dricks ingår: bokför manuellt',
          status: 'needs_review',
        },
        { payment_method: 'IZETTLE_CASH', payment_method_title: 'Delad betalning: bokför manuellt', status: 'needs_review' },
        { payment_method: 'IZETTLE_CARD', payment_method_title: 'Kort', status: 'paid' },
      ]),
    ).toEqual([
      { method: 'IZETTLE_CARD', title: 'Kort' },
      { method: 'IZETTLE_CASH', title: null },
    ])
  })
})
