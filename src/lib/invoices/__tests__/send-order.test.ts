import { describe, it, expect } from 'vitest'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import type { ChannelOption } from '@/lib/invoices/editor/channel'
import {
  SEND_ORDER_WAYS,
  availableSendOrderWays,
  defaultChannelByOrder,
  hasOrderToChoose,
  initialSendOrderRows,
  isAlwaysOnWay,
  isValidSendOrder,
  moveSendOrderRow,
  orderOfRows,
  parseSendOrder,
  toggleSendOrderRow,
} from '@/lib/invoices/send-order'

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

  it('keeps e-post on where a saved order left it out', () => {
    expect(initialSendOrderRows(['peppol', 'kivra', 'email'], ['kivra'])).toEqual([
      { way: 'kivra', on: true },
      { way: 'email', on: true },
      { way: 'peppol', on: false },
    ])
  })

  it('moves a row one place up or down and keeps a row at the end it moves toward', () => {
    const rows = initialSendOrderRows(['peppol', 'kivra', 'email'], null)
    expect(orderOfRows(moveSendOrderRow(rows, 'email', -1))).toEqual(['peppol', 'email', 'kivra'])
    expect(orderOfRows(moveSendOrderRow(rows, 'peppol', 1))).toEqual(['kivra', 'peppol', 'email'])
    expect(orderOfRows(moveSendOrderRow(rows, 'peppol', -1))).toEqual(['peppol', 'kivra', 'email'])
    expect(orderOfRows(moveSendOrderRow(rows, 'email', 1))).toEqual(['peppol', 'kivra', 'email'])
  })

  it('turns a way off and on again, and never e-post', () => {
    const rows = initialSendOrderRows(['peppol', 'kivra', 'email'], null)
    expect(orderOfRows(toggleSendOrderRow(rows, 'kivra'))).toEqual(['peppol', 'email'])
    expect(orderOfRows(toggleSendOrderRow(toggleSendOrderRow(rows, 'kivra'), 'kivra'))).toEqual(['peppol', 'kivra', 'email'])
    let all = rows
    for (const way of ['peppol', 'kivra', 'email'] as const) all = toggleSendOrderRow(all, way)
    expect(orderOfRows(all)).toEqual(['email'])
    expect(isAlwaysOnWay('email')).toBe(true)
    expect(isAlwaysOnWay('kivra')).toBe(false)
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
