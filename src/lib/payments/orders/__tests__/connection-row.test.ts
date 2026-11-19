/**
 * The Kopplingar row for bank payments (../connection-row.ts): shown as it
 * is where payments are open, kept with the way to Abonnemang where a paid
 * plan is all that is missing, and left out for every other answer.
 */
import { describe, expect, it } from 'vitest'
import { paymentsConnectionRow, type PaymentsConnectionRow } from '../connection-row'
import type { PaymentsUnavailableReason } from '../switched-on'

/** Every reason the availability can give, with the row it leads to: a new reason has to be placed here. */
const ROW_BY_REASON = {
  subscription: 'subscription',
  not_in_pilot: 'hidden',
  no_provider: 'hidden',
  sandbox: 'hidden',
} as const satisfies Record<PaymentsUnavailableReason, PaymentsConnectionRow>

const REASONS = Object.keys(ROW_BY_REASON) as PaymentsUnavailableReason[]

describe('paymentsConnectionRow', () => {
  it('is on where payments are open to the company', () => {
    expect(paymentsConnectionRow({ available: true, reason: null })).toBe('on')
  })

  it('keeps the row, pointing at the subscription, when a paid plan is all that is missing', () => {
    expect(paymentsConnectionRow({ available: false, reason: 'subscription' })).toBe('subscription')
  })

  it.each(REASONS)('reads %s as the row its reason leads to', (reason) => {
    expect(paymentsConnectionRow({ available: false, reason })).toBe(ROW_BY_REASON[reason])
  })

  it('is hidden when the answer could not be read or carries no reason', () => {
    expect(paymentsConnectionRow(null)).toBe('hidden')
    expect(paymentsConnectionRow({ available: false, reason: null })).toBe('hidden')
  })

  it('never points a self-host at a subscription: its plan is the connector, not a card', () => {
    expect(paymentsConnectionRow({ available: false, reason: 'subscription' }, { selfHosted: true })).toBe('hidden')
    expect(paymentsConnectionRow({ available: true, reason: null }, { selfHosted: true })).toBe('on')
    for (const reason of REASONS) {
      expect(paymentsConnectionRow({ available: false, reason }, { selfHosted: true })).toBe('hidden')
    }
  })
})
