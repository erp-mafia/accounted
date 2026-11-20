import { describe, expect, it } from 'vitest'
import { signAgainOrders, signsAnew } from '../payment-order-status'

const row = (id: string, batch_id: string | null, sign_again?: boolean) => ({ id, batch_id, sign_again })

describe('Signera igen on a Betalningar row (crm#1282)', () => {
  it('signs again every order of the signing that waits unsigned at the bank, not just the row clicked', () => {
    const orders = [row('a', 'batch-1', true), row('b', 'batch-1', true), row('c', 'batch-2', true), row('d', 'batch-1', false)]
    expect(signAgainOrders(orders[0]!, orders).map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('offers nothing for a row the server does not mark, or one from a server before the flag', () => {
    const orders = [row('a', 'batch-1', false), row('b', 'batch-1'), row('c', null, true)]
    for (const order of orders) expect(signAgainOrders(order, orders)).toEqual([])
  })
})

describe('a BankID that ended unsigned offers a new signing over the orders the server let go (crm#1470)', () => {
  it('when the server names orders to sign anew', () => {
    expect(signsAnew({ status: 'failed', sign_anew: ['o1'] })).toBe(true)
  })

  it('never when it names none (a failure signing cannot fix, a payment the bank kept), for a signing still waiting at the bank, or from a server before the field', () => {
    expect(signsAnew({ status: 'failed', sign_anew: [] })).toBe(false)
    expect(signsAnew({ status: 'created', sign_anew: ['o1'] })).toBe(false)
    expect(signsAnew({ status: 'failed' })).toBe(false)
  })
})
