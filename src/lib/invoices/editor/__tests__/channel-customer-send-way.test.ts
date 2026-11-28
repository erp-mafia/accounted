import { describe, it, expect } from 'vitest'
import {
  NO_MAILBOX_READY,
  resolveChannelOptions,
  resolveEffectiveChannel,
  type ChannelContext,
} from '@/lib/invoices/editor/channel'
import { SEND_ORDER_WAYS, parseSendOrder, parseSendWay, sendOrderForCustomer } from '@/lib/invoices/send-order'

const PEPPOL_OPEN = { available: true, reason: null } as const

function ctx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    documentType: 'invoice',
    canEmail: true,
    isSandbox: false,
    customerSelected: true,
    customerEmail: 'ekonomi@example.se',
    peppol: null,
    mailboxReady: NO_MAILBOX_READY,
    ...overrides,
  }
}

const CONTEXTS: ChannelContext[] = [
  ctx(),
  ctx({ canEmail: false }),
  ctx({ isSandbox: true }),
  ctx({ customerEmail: null }),
  ctx({ customerSelected: false, customerEmail: null }),
  ctx({ documentType: 'delivery_note' }),
  ctx({ documentType: 'quote' }),
  ctx({ peppol: PEPPOL_OPEN }),
  ctx({ peppol: { available: false, reason: 'peppol_no_participant' } }),
  ctx({ peppol: { available: false, reason: 'peppol_send_limit' } }),
  ctx({ mailboxReady: { kivra: true, billo: true } }),
  ctx({ peppol: PEPPOL_OPEN, mailboxReady: { kivra: true, billo: false }, customerEmail: null }),
]

const COMPANY_ORDERS: unknown[] = [null, undefined, ['peppol', 'email'], ['email'], ['kivra', 'peppol', 'email'], ['bogus']]

describe('parseSendWay', () => {
  it('reads a way and nothing else', () => {
    for (const way of SEND_ORDER_WAYS) expect(parseSendWay(way)).toBe(way)
    for (const value of [null, undefined, '', 'manual', 'Peppol', 1, ['email']]) expect(parseSendWay(value)).toBeNull()
  })
})

describe('sendOrderForCustomer', () => {
  it('is the company order when the customer has no way of its own', () => {
    expect(sendOrderForCustomer(null, null)).toBeNull()
    expect(sendOrderForCustomer(undefined, ['peppol', 'email'])).toEqual(['peppol', 'email'])
    expect(sendOrderForCustomer('manual', ['email'])).toEqual(['email'])
  })

  it('puts the customer\'s way first, once', () => {
    expect(sendOrderForCustomer('peppol', null)).toEqual(['peppol'])
    expect(sendOrderForCustomer('email', ['peppol', 'kivra', 'email'])).toEqual(['email', 'peppol', 'kivra'])
    expect(sendOrderForCustomer('peppol', ['email'])).toEqual(['peppol', 'email'])
  })

  it('reads a stored company order that is not valid as none', () => {
    expect(sendOrderForCustomer('peppol', ['bogus'])).toEqual(['peppol'])
  })
})

describe('the editor default with a customer\'s way', () => {
  it('picks e-faktura for a customer set to it when the invoice can go that way, over email', () => {
    expect(resolveEffectiveChannel(null, ctx({ peppol: PEPPOL_OPEN }), sendOrderForCustomer('peppol', null))).toBe('peppol')
    expect(
      resolveEffectiveChannel(null, ctx({ peppol: PEPPOL_OPEN }), sendOrderForCustomer('peppol', ['email', 'peppol'])),
    ).toBe('peppol')
  })

  it('picks email for a customer set to it, over a company order that starts with e-faktura', () => {
    expect(
      resolveEffectiveChannel(null, ctx({ peppol: PEPPOL_OPEN }), sendOrderForCustomer('email', ['peppol', 'email'])),
    ).toBe('email')
  })

  it('falls back to the company order when the buyer has no Peppol id', () => {
    const noPeppolId = ctx({ peppol: { available: false, reason: 'peppol_no_participant' } })
    expect(resolveEffectiveChannel(null, noPeppolId, sendOrderForCustomer('peppol', null))).toBe('email')
    expect(
      resolveEffectiveChannel(null, noPeppolId, sendOrderForCustomer('peppol', ['kivra', 'peppol', 'email'])),
    ).toBe('email')
  })

  it('decides exactly as without the way whenever the invoice cannot use it', () => {
    for (const c of CONTEXTS) {
      const options = resolveChannelOptions(c)
      for (const way of SEND_ORDER_WAYS) {
        const usable = options.some((option) => option.channel === way && option.available)
        for (const companyOrder of COMPANY_ORDERS) {
          const withWay = resolveEffectiveChannel(null, c, sendOrderForCustomer(way, companyOrder))
          const without = resolveEffectiveChannel(null, c, parseSendOrder(companyOrder))
          expect(withWay).toBe(usable ? way : without)
        }
      }
    }
  })

  it('lets a pick by hand win while it is available', () => {
    expect(
      resolveEffectiveChannel('email', ctx({ peppol: PEPPOL_OPEN }), sendOrderForCustomer('peppol', null)),
    ).toBe('email')
    expect(
      resolveEffectiveChannel('manual', ctx({ peppol: PEPPOL_OPEN }), sendOrderForCustomer('peppol', null)),
    ).toBe('manual')
  })
})
