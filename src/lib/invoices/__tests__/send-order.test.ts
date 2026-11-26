import { describe, it, expect } from 'vitest'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import type { ChannelOption } from '@/lib/invoices/editor/channel'
import {
  SEND_ORDER_WAYS,
  availableSendOrderWays,
  defaultChannelByOrder,
  hasOrderToChoose,
  initialSendOrderRows,
  isValidSendOrder,
  moveSendOrderRowUp,
  orderOfRows,
  parseSendOrder,
  splitCustomers,
  toggleSendOrderRow,
  type CustomerReachCount,
} from '@/lib/invoices/send-order'
import { countCustomerReach, customerReach } from '@/lib/invoices/send-order-reach'

function option(channel: ChannelOption['channel'], available = true): ChannelOption {
  return { channel, available, reason: available ? null : 'peppol_send_limit' }
}

describe('SEND_ORDER_WAYS', () => {
  it('lists the ways in the recommended order', () => {
    expect([...SEND_ORDER_WAYS]).toEqual(['peppol', 'kivra', 'billo', 'email'])
  })
})

describe('isValidSendOrder', () => {
  it('accepts a non-empty list of distinct ways', () => {
    expect(isValidSendOrder(['email'])).toBe(true)
    expect(isValidSendOrder(['kivra', 'peppol', 'email'])).toBe(true)
    expect(isValidSendOrder([...SEND_ORDER_WAYS])).toBe(true)
  })

  it('refuses an empty list, a duplicate, an unknown way and a non-list', () => {
    expect(isValidSendOrder([])).toBe(false)
    expect(isValidSendOrder(['email', 'email'])).toBe(false)
    expect(isValidSendOrder(['fax'])).toBe(false)
    expect(isValidSendOrder(['manual'])).toBe(false)
    expect(isValidSendOrder(null)).toBe(false)
    expect(isValidSendOrder('email')).toBe(false)
  })

  it('reads a stored value as an order only when it is valid', () => {
    expect(parseSendOrder(['billo', 'email'])).toEqual(['billo', 'email'])
    expect(parseSendOrder(null)).toBeNull()
    expect(parseSendOrder(undefined)).toBeNull()
    expect(parseSendOrder(['x'])).toBeNull()
  })
})

describe('defaultChannelByOrder', () => {
  const options = [option('email'), option('manual'), option('peppol'), option('kivra')]

  it('is the first way in the order that is listed and choosable', () => {
    expect(defaultChannelByOrder(options, ['kivra', 'peppol', 'email'], 'email')).toBe('kivra')
    expect(defaultChannelByOrder(options, ['peppol', 'kivra', 'email'], 'email')).toBe('peppol')
  })

  it('skips a way that is not listed', () => {
    expect(defaultChannelByOrder(options, ['billo', 'kivra'], 'email')).toBe('kivra')
  })

  it('skips a way that is listed but not choosable', () => {
    const blocked = [option('email'), option('manual'), option('peppol', false), option('kivra')]
    expect(defaultChannelByOrder(blocked, ['peppol', 'kivra', 'email'], 'email')).toBe('kivra')
  })

  it('falls back to the given default when no way in the order is usable', () => {
    expect(defaultChannelByOrder([option('manual')], ['peppol', 'kivra'], 'manual')).toBe('manual')
    expect(defaultChannelByOrder(options, ['billo'], 'email')).toBe('email')
    expect(defaultChannelByOrder([option('email', false), option('manual')], ['email'], 'manual')).toBe('manual')
  })
})

describe('splitCustomers', () => {
  const counts: CustomerReachCount[] = [
    { reach: { peppol: true, mailbox: true, email: true }, count: 5 },
    { reach: { peppol: false, mailbox: true, email: true }, count: 3 },
    { reach: { peppol: false, mailbox: false, email: true }, count: 2 },
    { reach: { peppol: false, mailbox: false, email: false }, count: 1 },
  ]

  it('counts each customer for the first way in the order that reaches it', () => {
    const split = splitCustomers(counts, ['peppol', 'kivra', 'email'])
    expect(split.perWay).toEqual({ peppol: 5, kivra: 3, billo: 0, email: 2 })
    expect(split.none).toBe(1)
    expect(split.total).toBe(11)
  })

  it('moves customers when the order changes', () => {
    const split = splitCustomers(counts, ['email', 'peppol'])
    expect(split.perWay).toEqual({ peppol: 0, kivra: 0, billo: 0, email: 10 })
    expect(split.none).toBe(1)
  })

  it('counts a customer no listed way reaches as without a way', () => {
    const split = splitCustomers(counts, ['peppol'])
    expect(split.perWay.peppol).toBe(5)
    expect(split.none).toBe(6)
  })

  it('serves Kivra and Billo from the same mailbox answer', () => {
    const split = splitCustomers(counts, ['billo', 'kivra'])
    expect(split.perWay).toEqual({ peppol: 0, kivra: 0, billo: 8, email: 0 })
  })

  it('splits nothing without customers', () => {
    expect(splitCustomers([], ['email'])).toEqual({
      perWay: { peppol: 0, kivra: 0, billo: 0, email: 0 },
      none: 0,
      total: 0,
    })
  })
})

describe('customer reach', () => {
  it('reads the three answers the editor gives', () => {
    expect(customerReach({ customer_type: 'swedish_business', org_number: '5560360793', email: 'a@b.se' })).toEqual({
      peppol: true,
      mailbox: true,
      email: true,
    })
    expect(customerReach({ customer_type: 'individual', personal_number: 'x', email: null })).toEqual({
      peppol: false,
      mailbox: true,
      email: false,
    })
    expect(customerReach({ customer_type: 'eu_business', email: 'not-an-address' })).toEqual({
      peppol: false,
      mailbox: false,
      email: false,
    })
  })

  it('counts customers per combination', () => {
    const counts = countCustomerReach([
      { customer_type: 'eu_business', email: 'a@b.se' },
      { customer_type: 'eu_business', email: 'c@d.se' },
      { customer_type: 'eu_business', email: null },
    ])
    const total = counts.reduce((sum, c) => sum + c.count, 0)
    expect(total).toBe(3)
    expect(counts).toHaveLength(2)
    expect(splitCustomers(counts, ['email'])).toMatchObject({ none: 1, total: 3 })
  })
})

describe('the order list', () => {
  it('starts from the recommended order, all on, without a saved order', () => {
    expect(initialSendOrderRows(['peppol', 'email'], null)).toEqual([
      { way: 'peppol', on: true },
      { way: 'email', on: true },
    ])
  })

  it('starts from a saved order, its ways on and the others off', () => {
    expect(initialSendOrderRows(['peppol', 'kivra', 'email'], ['email', 'peppol'])).toEqual([
      { way: 'email', on: true },
      { way: 'peppol', on: true },
      { way: 'kivra', on: false },
    ])
  })

  it('leaves out a saved way the company cannot use', () => {
    expect(orderOfRows(initialSendOrderRows(['email'], ['billo', 'email']))).toEqual(['email'])
  })

  it('moves a row up, keeps the first row, and turns rows off', () => {
    const rows = initialSendOrderRows(['peppol', 'kivra', 'email'], null)
    expect(orderOfRows(moveSendOrderRowUp(rows, 'email'))).toEqual(['peppol', 'email', 'kivra'])
    expect(orderOfRows(moveSendOrderRowUp(rows, 'peppol'))).toEqual(['peppol', 'kivra', 'email'])
    expect(orderOfRows(toggleSendOrderRow(rows, 'kivra'))).toEqual(['peppol', 'email'])
    let none = rows
    for (const way of ['peppol', 'kivra', 'email'] as const) none = toggleSendOrderRow(none, way)
    expect(orderOfRows(none)).toEqual([])
  })

  it('offers e-faktura and each mailbox only where the company can use it, and email always', () => {
    expect(availableSendOrderWays(false, [])).toEqual(['email'])
    expect(availableSendOrderWays(true, ['billo', 'kivra'])).toEqual(['peppol', 'kivra', 'billo', 'email'])
    expect(availableSendOrderWays(false, ['billo'])).toEqual(['billo', 'email'])
  })
})

describe('invoice_send_order in the settings schema', () => {
  const parse = (value: unknown) => UpdateSettingsSchema.safeParse({ invoice_send_order: value })

  it('accepts a valid order and null', () => {
    expect(parse(['kivra', 'email']).success).toBe(true)
    expect(parse(null).success).toBe(true)
    expect(UpdateSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('refuses an unknown way, a duplicate and an empty list', () => {
    expect(parse(['fax']).success).toBe(false)
    expect(parse(['email', 'email']).success).toBe(false)
    expect(parse([]).success).toBe(false)
    expect(parse('email').success).toBe(false)
  })
})

describe('hasOrderToChoose', () => {
  it('is false with no way or one way', () => {
    expect(hasOrderToChoose([])).toBe(false)
    expect(hasOrderToChoose(['email'])).toBe(false)
  })

  it('is true with two or more ways', () => {
    expect(hasOrderToChoose(['peppol', 'email'])).toBe(true)
    expect(hasOrderToChoose(availableSendOrderWays(true, ['kivra', 'billo']))).toBe(true)
  })

  it('is false for a company that can only send by email', () => {
    expect(hasOrderToChoose(availableSendOrderWays(false, []))).toBe(false)
  })
})
