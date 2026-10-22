import { describe, it, expect } from 'vitest'
import { UNDECRYPTABLE_PERSONAL_NUMBER_MASK } from '@/lib/customers/mask-personal-number'
import {
  emailBlockReason,
  emailPreviewBlock,
  isMailboxChannel,
  mailboxRecipientIdentifiable,
  NO_MAILBOX_READY,
  resolveChannelOptions,
  resolveDefaultChannel,
  resolveEffectiveChannel,
  resolveMailboxReady,
  type ChannelContext,
  type MailboxReadyInput,
} from '@/lib/invoices/editor/channel'

function ctx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    documentType: 'invoice',
    canEmail: true,
    isSandbox: false,
    customerSelected: true,
    customerEmail: 'ekonomi@example.se',
    peppolReady: false,
    mailboxReady: NO_MAILBOX_READY,
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

  it('lists each ready mailbox after the other channels, for a faktura only', () => {
    expect(
      resolveChannelOptions(ctx({ mailboxReady: { kivra: true, billo: true } })).map((o) => o.channel),
    ).toEqual(['email', 'manual', 'kivra', 'billo'])
    expect(
      resolveChannelOptions(ctx({ mailboxReady: { kivra: false, billo: true } })),
    ).toEqual([
      { channel: 'email', available: true, reason: null },
      { channel: 'manual', available: true, reason: null },
      { channel: 'billo', available: true, reason: null },
    ])
    for (const documentType of ['quote', 'proforma', 'delivery_note'] as const) {
      expect(
        resolveChannelOptions(ctx({ documentType, mailboxReady: { kivra: true, billo: true } })).some((o) =>
          isMailboxChannel(o.channel),
        ),
      ).toBe(false)
    }
  })

  it('keeps email the default when a mailbox is offered', () => {
    expect(resolveDefaultChannel(ctx({ mailboxReady: { kivra: true, billo: true } }))).toBe('email')
  })
})

describe('mailboxRecipientIdentifiable', () => {
  it('addresses a Swedish company by a valid organisationsnummer', () => {
    expect(mailboxRecipientIdentifiable({ customer_type: 'swedish_business', org_number: '442005-9208' })).toBe(true)
    expect(mailboxRecipientIdentifiable({ customer_type: 'swedish_business', org_number: '4420059208' })).toBe(true)
    expect(mailboxRecipientIdentifiable({ customer_type: 'swedish_business', org_number: null })).toBe(false)
    expect(mailboxRecipientIdentifiable({ customer_type: 'swedish_business', org_number: '442005-9209' })).toBe(false)
  })

  it('addresses a private person by a personnummer on file, masked or not', () => {
    expect(mailboxRecipientIdentifiable({ customer_type: 'individual', personal_number: '19850101-****' })).toBe(true)
    expect(mailboxRecipientIdentifiable({ customer_type: 'individual', personal_number: null })).toBe(false)
    expect(mailboxRecipientIdentifiable({ customer_type: 'individual', personal_number: '  ' })).toBe(false)
    expect(
      mailboxRecipientIdentifiable({ customer_type: 'individual', personal_number: UNDECRYPTABLE_PERSONAL_NUMBER_MASK }),
    ).toBe(false)
  })

  it('has no mailbox address for a foreign customer or no customer', () => {
    expect(mailboxRecipientIdentifiable({ customer_type: 'eu_business', org_number: '4420059208' })).toBe(false)
    expect(mailboxRecipientIdentifiable({ customer_type: 'non_eu_business', org_number: '4420059208' })).toBe(false)
    expect(mailboxRecipientIdentifiable(null)).toBe(false)
  })
})

describe('resolveMailboxReady', () => {
  function input(overrides: Partial<MailboxReadyInput> = {}): MailboxReadyInput {
    return {
      activeProviders: ['kivra', 'billo'],
      documentType: 'invoice',
      isCreditNote: false,
      currency: 'SEK',
      customer: { customer_type: 'swedish_business', org_number: '4420059208' },
      ...overrides,
    }
  }

  it('is ready for each provider the company sends through', () => {
    expect(resolveMailboxReady(input())).toEqual({ kivra: true, billo: true })
    expect(resolveMailboxReady(input({ activeProviders: ['billo'] }))).toEqual({ kivra: false, billo: true })
    expect(resolveMailboxReady(input({ activeProviders: [] }))).toEqual(NO_MAILBOX_READY)
  })

  it('is never ready for a credit note, a quote, a proforma or a följesedel', () => {
    expect(resolveMailboxReady(input({ isCreditNote: true }))).toEqual(NO_MAILBOX_READY)
    for (const documentType of ['quote', 'proforma', 'delivery_note'] as const) {
      expect(resolveMailboxReady(input({ documentType }))).toEqual(NO_MAILBOX_READY)
    }
  })

  it('needs kronor', () => {
    expect(resolveMailboxReady(input({ currency: 'EUR' }))).toEqual(NO_MAILBOX_READY)
    expect(resolveMailboxReady(input({ currency: 'NOK' }))).toEqual(NO_MAILBOX_READY)
    expect(resolveMailboxReady(input({ currency: 'sek' }))).toEqual({ kivra: true, billo: true })
  })

  it('needs a customer the mailbox can be addressed to', () => {
    expect(resolveMailboxReady(input({ customer: null }))).toEqual(NO_MAILBOX_READY)
    expect(
      resolveMailboxReady(input({ customer: { customer_type: 'swedish_business', org_number: null } })),
    ).toEqual(NO_MAILBOX_READY)
    expect(
      resolveMailboxReady(input({ customer: { customer_type: 'individual', personal_number: '19850101-****' } })),
    ).toEqual({ kivra: true, billo: true })
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

  it('keeps a mailbox pick while it is ready and drops it once it is not (customer, currency switched)', () => {
    expect(resolveEffectiveChannel('kivra', ctx({ mailboxReady: { kivra: true, billo: false } }))).toBe('kivra')
    expect(resolveEffectiveChannel('kivra', ctx({ mailboxReady: { kivra: false, billo: true } }))).toBe('email')
    expect(
      resolveEffectiveChannel('billo', ctx({ customerEmail: null, mailboxReady: NO_MAILBOX_READY })),
    ).toBe('manual')
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
    const mailboxes = resolveChannelOptions(ctx({ mailboxReady: { kivra: true, billo: true } }))
    expect(emailPreviewBlock('kivra', mailboxes)).toBe('kivra')
    expect(emailPreviewBlock('billo', mailboxes)).toBe('billo')
  })

  it('on a mailbox channel to a customer without an address, says why email is off', () => {
    const options = resolveChannelOptions(ctx({ customerEmail: null, mailboxReady: { kivra: true, billo: false } }))
    expect(emailPreviewBlock('kivra', options)).toBe('no_customer_email')
  })
})
