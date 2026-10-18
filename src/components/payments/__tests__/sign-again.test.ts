import { describe, expect, it } from 'vitest'
import { signAgainOrders } from '../payment-order-status'

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
