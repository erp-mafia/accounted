import { describe, it, expect } from 'vitest'
import {
  emailBlockReason,
  emailPreviewBlock,
  resolveChannelOptions,
  resolveDefaultChannel,
  resolveEffectiveChannel,
  type ChannelContext,
} from '@/lib/invoices/editor/channel'

function ctx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    documentType: 'invoice',
    canEmail: true,
    isSandbox: false,
    customerSelected: true,
    customerEmail: 'ekonomi@example.se',
    peppolReady: false,
    ...overrides,
  }
}

describe('resolveDefaultChannel', () => {
  it('is email when the plan, the environment and the customer allow it', () => {
    expect(resolveDefaultChannel(ctx())).toBe('email')
  })

  it('is manual without the email_send plan', () => {
    expect(resolveDefaultChannel(ctx({ canEmail: false }))).toBe('manual')
    expect(emailBlockReason(ctx({ canEmail: false }))).toBe('no_email_plan')
  })

  it('is manual in the sandbox, where email sending is off', () => {
    expect(resolveDefaultChannel(ctx({ isSandbox: true }))).toBe('manual')
    expect(emailBlockReason(ctx({ isSandbox: true }))).toBe('sandbox')
  })

  it('is manual when the customer has no usable address', () => {
    expect(resolveDefaultChannel(ctx({ customerEmail: null }))).toBe('manual')
    expect(resolveDefaultChannel(ctx({ customerEmail: '  ' }))).toBe('manual')
    expect(resolveDefaultChannel(ctx({ customerEmail: 'not-an-address' }))).toBe('manual')
    expect(emailBlockReason(ctx({ customerEmail: null }))).toBe('no_customer_email')
  })

  it('stays email before a customer is picked, so the label does not flip on the first pick', () => {
    expect(resolveDefaultChannel(ctx({ customerSelected: false, customerEmail: null }))).toBe('email')
  })

  it('never emails a följesedel', () => {
    expect(resolveDefaultChannel(ctx({ documentType: 'delivery_note' }))).toBe('manual')
    expect(emailBlockReason(ctx({ documentType: 'delivery_note' }))).toBe('not_emailable')
  })

  it('emails quotes and proformas like invoices', () => {
    expect(resolveDefaultChannel(ctx({ documentType: 'quote' }))).toBe('email')
    expect(resolveDefaultChannel(ctx({ documentType: 'proforma' }))).toBe('email')
  })
})

describe('resolveChannelOptions', () => {
  it('lists email (with its reason) and manual; manual is always available', () => {
    expect(resolveChannelOptions(ctx({ canEmail: false }))).toEqual([
      { channel: 'email', available: false, reason: 'no_email_plan' },
      { channel: 'manual', available: true, reason: null },
    ])
  })

  it('lists Peppol only when the company and the customer are ready for it, and only for a faktura', () => {
    expect(resolveChannelOptions(ctx()).map((o) => o.channel)).toEqual(['email', 'manual'])
    expect(resolveChannelOptions(ctx({ peppolReady: true })).map((o) => o.channel)).toEqual([
      'email',
      'manual',
      'peppol',
    ])
    expect(
      resolveChannelOptions(ctx({ peppolReady: true, documentType: 'quote' })).map((o) => o.channel),
    ).toEqual(['email', 'manual'])
  })
})

describe('resolveEffectiveChannel', () => {
  it('keeps the user pick while it is available', () => {
    expect(resolveEffectiveChannel('manual', ctx())).toBe('manual')
  })

  it('falls back to the default when the pick became unavailable (customer without email)', () => {
    expect(resolveEffectiveChannel('email', ctx({ customerEmail: null }))).toBe('manual')
  })

  it('uses the default without a pick', () => {
    expect(resolveEffectiveChannel(null, ctx())).toBe('email')
  })

  it('drops a Peppol pick that is no longer offered', () => {
    expect(resolveEffectiveChannel('peppol', ctx({ peppolReady: false }))).toBe('email')
  })
})

describe('emailPreviewBlock', () => {
  it('leaves the Mejl tab on while the email goes out', () => {
    expect(emailPreviewBlock('email', resolveChannelOptions(ctx()))).toBeNull()
  })

  it('says why email cannot go out: a customer without an address, the plan, a följesedel', () => {
    expect(emailPreviewBlock('manual', resolveChannelOptions(ctx({ customerEmail: null })))).toBe('no_customer_email')
    expect(emailPreviewBlock('manual', resolveChannelOptions(ctx({ canEmail: false })))).toBe('no_email_plan')
    expect(emailPreviewBlock('manual', resolveChannelOptions(ctx({ documentType: 'delivery_note' })))).toBe(
      'not_emailable',
    )
  })

  it('names the picked channel when email was possible but not chosen', () => {
    expect(emailPreviewBlock('manual', resolveChannelOptions(ctx()))).toBe('manual')
    expect(emailPreviewBlock('peppol', resolveChannelOptions(ctx({ peppolReady: true })))).toBe('peppol')
  })
})
