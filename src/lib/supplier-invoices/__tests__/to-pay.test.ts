import { describe, it, expect } from 'vitest'
import { waitsToBePaid } from '../to-pay'

const free = { atTheBank: false, waitsForAttest: false }
const invoice = (over: Record<string, unknown> = {}) => ({
  status: 'registered',
  is_credit_note: false,
  remaining_amount: 1000,
  auto_debit: false,
  ...over,
})

describe('waitsToBePaid', () => {
  it.each(['registered', 'approved', 'overdue', 'partially_paid'])('a %s invoice with money left waits to be paid', (status) => {
    expect(waitsToBePaid(invoice({ status }), free)).toBe(true)
  })

  it('an unattested invoice waits to be paid when no attest policy holds it: the payment file pays it', () => {
    expect(waitsToBePaid(invoice({ status: 'registered' }), free)).toBe(true)
  })

  it.each([
    ['paid', invoice({ status: 'paid' })],
    ['credited', invoice({ status: 'credited' })],
    ['a credit note', invoice({ is_credit_note: true })],
    ['nothing left', invoice({ remaining_amount: 0.004 })],
    ['debited by the supplier itself', invoice({ auto_debit: true })],
  ])('%s does not wait to be paid', (_name, row) => {
    expect(waitsToBePaid(row, free)).toBe(false)
  })

  it('an invoice at the bank, or held by the attest policy, does not wait to be paid', () => {
    expect(waitsToBePaid(invoice(), { atTheBank: true, waitsForAttest: false })).toBe(false)
    expect(waitsToBePaid(invoice(), { atTheBank: false, waitsForAttest: true })).toBe(false)
  })

  it('a row read without its amount counts as owed', () => {
    expect(waitsToBePaid(invoice({ remaining_amount: undefined }), free)).toBe(true)
  })
})
