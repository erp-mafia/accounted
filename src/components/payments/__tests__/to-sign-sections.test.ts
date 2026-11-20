import { describe, expect, it } from 'vitest'
import { PAYMENT_ORDER_STATUSES, paymentOrderWaitsFor } from '@/lib/payments/orders/status'
import { sectionOf } from '../payment-order-status'

describe('the Att göra row "Signera N betalningar" counts what Betalningar lists to approve and to sign (crm#1925)', () => {
  it('an order waits for a person exactly when the page files it under Att godkänna or Att signera', () => {
    for (const status of PAYMENT_ORDER_STATUSES) {
      const section = sectionOf({ status, outcome_unknown_at: null })
      const waitsFor = paymentOrderWaitsFor({ status })
      expect(section === 'to_approve').toBe(waitsFor === 'approval')
      expect(section === 'to_sign').toBe(waitsFor === 'signature')
    }
  })
})
