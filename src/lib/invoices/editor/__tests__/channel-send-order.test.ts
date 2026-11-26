import { describe, it, expect } from 'vitest'
import {
  NO_MAILBOX_READY,
  resolveChannelOptions,
  resolveDefaultChannel,
  resolveEffectiveChannel,
  type ChannelContext,
} from '@/lib/invoices/editor/channel'
import type { SendOrderWay } from '@/lib/invoices/send-order'

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
  ctx({ peppol: { available: false, reason: 'peppol_send_limit' } }),
  ctx({ mailboxReady: { kivra: true, billo: true } }),
  ctx({ peppol: PEPPOL_OPEN, mailboxReady: { kivra: true, billo: false }, customerEmail: null }),
]

describe('resolveEffectiveChannel without a saved send order', () => {
  it('gives today\'s default in every case, with no order, null or undefined', () => {
    for (const c of CONTEXTS) {
      expect(resolveEffectiveChannel(null, c)).toBe(resolveDefaultChannel(c))
      expect(resolveEffectiveChannel(null, c, null)).toBe(resolveDefaultChannel(c))
      expect(resolveEffectiveChannel(null, c, undefined)).toBe(resolveDefaultChannel(c))
    }
  })

  it('keeps a pick by hand exactly as before', () => {
    for (const c of CONTEXTS) {
      for (const o of resolveChannelOptions(c)) {
        expect(resolveEffectiveChannel(o.channel, c, null)).toBe(resolveEffectiveChannel(o.channel, c))
      }
    }
  })
})

describe('resolveEffectiveChannel with a saved send order', () => {
  const order: SendOrderWay[] = ['peppol', 'kivra', 'email']

  it('picks the first way in the order that is listed and choosable', () => {
    expect(resolveEffectiveChannel(null, ctx({ peppol: PEPPOL_OPEN }), order)).toBe('peppol')
    expect(resolveEffectiveChannel(null, ctx({ mailboxReady: { kivra: true, billo: false } }), order)).toBe('kivra')
    expect(resolveEffectiveChannel(null, ctx(), order)).toBe('email')
  })

  it('skips a listed way that cannot be chosen', () => {
    const blocked = ctx({ peppol: { available: false, reason: 'peppol_no_participant' }, mailboxReady: { kivra: true, billo: false } })
    expect(resolveEffectiveChannel(null, blocked, order)).toBe('kivra')
  })

  it('falls back to today\'s default when no way in the order can be used', () => {
    expect(resolveEffectiveChannel(null, ctx({ customerEmail: null }), ['peppol', 'email'])).toBe('manual')
    expect(resolveEffectiveChannel(null, ctx(), ['billo'])).toBe('email')
  })

  it('lets a pick by hand win while it is available', () => {
    expect(resolveEffectiveChannel('manual', ctx({ peppol: PEPPOL_OPEN }), order)).toBe('manual')
    expect(resolveEffectiveChannel('email', ctx({ peppol: PEPPOL_OPEN }), order)).toBe('email')
  })

  it('uses the order when the pick by hand is no longer available', () => {
    expect(resolveEffectiveChannel('peppol', ctx({ peppol: null, mailboxReady: { kivra: true, billo: false } }), order)).toBe('kivra')
  })
})
