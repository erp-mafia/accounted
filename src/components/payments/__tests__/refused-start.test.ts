import { describe, expect, it } from 'vitest'
import { PaymentsClientError, signingOfRefusedStart, type SigningView } from '../payments-client'

const held: SigningView = {
  batch_id: 'batch-1',
  status: 'failed',
  challenge: null,
  failure_code: 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN',
  step: null,
  follow_up: false,
  orders: [{ id: 'o1', status: 'submitted', provider_status: null, outcome_unknown: true, bank_confirming: false }],
}

const refusal = (code: string, details?: Record<string, unknown>) => new PaymentsClientError({ error: { code, message: 'x', details } }, 502)

describe('a refused start that moved its payments (crm#1357)', () => {
  it('reads the signing the start left its payments in, so the screen stops offering the same start', () => {
    expect(signingOfRefusedStart(refusal('PAYMENT_ORDERS_OUTCOME_UNKNOWN', { payment_order_id: 'o1', signing: held }))).toEqual(held)
  })

  it('reads nothing from a refusal that left the payments approved, or from a server before the field', () => {
    expect(signingOfRefusedStart(refusal('PAYMENT_PROVIDER_UNAVAILABLE', { provider_code: 'RATE_LIMITED' }))).toBeNull()
    expect(signingOfRefusedStart(refusal('PAYMENT_ORDERS_WRONG_STATUS'))).toBeNull()
    expect(signingOfRefusedStart(new PaymentsClientError(null, 504))).toBeNull()
    expect(signingOfRefusedStart(new TypeError('Failed to fetch'))).toBeNull()
  })

  it('reads nothing from a signing that is not one', () => {
    expect(signingOfRefusedStart(refusal('PAYMENT_ORDERS_OUTCOME_UNKNOWN', { signing: { batch_id: 'batch-1' } }))).toBeNull()
    expect(signingOfRefusedStart(refusal('PAYMENT_ORDERS_OUTCOME_UNKNOWN', { signing: 'batch-1' }))).toBeNull()
  })
})
