import { describe, it, expect } from 'vitest'
import {
  booksOnIssue,
  resolveEditorMenu,
  resolvePrimaryAction,
  resolveSendLabel,
  type PrimaryContext,
} from '@/lib/invoices/editor/primary-action'
import { resolveChannelOptions } from '@/lib/invoices/editor/channel'

function primary(overrides: Partial<PrimaryContext> = {}): PrimaryContext {
  return {
    mode: 'create',
    isSelfBilled: false,
    documentType: 'invoice',
    channel: 'email',
    booksOnIssue: true,
    ...overrides,
  }
}

describe('booksOnIssue', () => {
  it('books a faktura at issue under faktureringsmetoden', () => {
    expect(booksOnIssue('invoice', { accountingMethod: 'accrual', deferInvoiceBooking: false })).toBe(true)
  })

  it('does not book under kontantmetoden or deferred booking', () => {
    expect(booksOnIssue('invoice', { accountingMethod: 'cash', deferInvoiceBooking: false })).toBe(false)
    expect(booksOnIssue('invoice', { accountingMethod: 'accrual', deferInvoiceBooking: true })).toBe(false)
  })

  it('never books a quote, proforma or följesedel', () => {
    for (const type of ['quote', 'proforma', 'delivery_note'] as const) {
      expect(booksOnIssue(type, { accountingMethod: 'accrual', deferInvoiceBooking: false })).toBe(false)
    }
  })
})

describe('resolveSendLabel', () => {
  it('email + accrual = Skicka och bokför', () => {
    expect(resolveSendLabel({ documentType: 'invoice', channel: 'email', booksOnIssue: true })).toBe(
      'action_send_and_book',
    )
  })

  it('email + cash (or no voucher) = Skicka', () => {
    expect(resolveSendLabel({ documentType: 'invoice', channel: 'email', booksOnIssue: false })).toBe('action_send')
    expect(resolveSendLabel({ documentType: 'proforma', channel: 'email', booksOnIssue: true })).toBe('action_send')
  })

  it('manual adds "och bokför" only when the faktura books', () => {
    expect(resolveSendLabel({ documentType: 'invoice', channel: 'manual', booksOnIssue: true })).toBe(
      'action_mark_sent_book_download',
    )
    expect(resolveSendLabel({ documentType: 'invoice', channel: 'manual', booksOnIssue: false })).toBe(
      'action_mark_sent_download',
    )
    expect(resolveSendLabel({ documentType: 'quote', channel: 'manual', booksOnIssue: true })).toBe(
      'action_mark_sent_download',
    )
  })

  it('a quote by email is Skicka offert', () => {
    expect(resolveSendLabel({ documentType: 'quote', channel: 'email', booksOnIssue: false })).toBe('action_send_quote')
  })

  it('Peppol is Skicka som e-faktura', () => {
    expect(resolveSendLabel({ documentType: 'invoice', channel: 'peppol', booksOnIssue: true })).toBe(
      'action_send_peppol',
    )
  })
})

describe('resolvePrimaryAction', () => {
  it('sends on the effective channel in create mode', () => {
    expect(resolvePrimaryAction(primary())).toEqual({
      intent: { kind: 'send', channel: 'email' },
      label: 'action_send_and_book',
    })
    expect(resolvePrimaryAction(primary({ channel: 'manual', booksOnIssue: false }))).toEqual({
      intent: { kind: 'send', channel: 'manual' },
      label: 'action_mark_sent_download',
    })
  })

  it('saves in edit mode', () => {
    expect(resolvePrimaryAction(primary({ mode: 'edit' }))).toEqual({
      intent: { kind: 'save_changes' },
      label: 'action_save_changes',
    })
  })

  it('registers a received självfaktura', () => {
    expect(resolvePrimaryAction(primary({ isSelfBilled: true }))).toEqual({
      intent: { kind: 'register_self_billed' },
      label: 'action_register_self_billed',
    })
  })
})

describe('resolveEditorMenu', () => {
  const channelOptions = resolveChannelOptions({
    documentType: 'invoice',
    canEmail: true,
    isSandbox: false,
    customerSelected: true,
    customerEmail: 'ekonomi@example.se',
    peppolReady: false,
  })

  it('lists the channels with the primary one checked, then draft and create-only', () => {
    const menu = resolveEditorMenu({ ...primary(), channelOptions })
    expect(menu?.channels.map((c) => [c.label, c.selected, c.available])).toEqual([
      ['channel_email', true, true],
      ['channel_manual', false, true],
    ])
    expect(menu?.actions.map((a) => a.label)).toEqual(['action_save_as_draft', 'action_create_without_sending'])
  })

  it('offers no unnumbered draft for a quote (numbered at insert)', () => {
    const menu = resolveEditorMenu({ ...primary({ documentType: 'quote' }), channelOptions })
    expect(menu?.actions.map((a) => a.label)).toEqual(['action_create_without_sending'])
  })

  it('in edit mode lists the channels (save, then send) without a checked one and no create actions', () => {
    const menu = resolveEditorMenu({ ...primary({ mode: 'edit' }), channelOptions })
    expect(menu?.channels.every((c) => !c.selected)).toBe(true)
    expect(menu?.channels.map((c) => c.intent)).toEqual([
      { kind: 'send', channel: 'email' },
      { kind: 'send', channel: 'manual' },
    ])
    expect(menu?.actions).toEqual([])
  })

  it('has no menu for a received självfaktura', () => {
    expect(resolveEditorMenu({ ...primary({ isSelfBilled: true }), channelOptions })).toBeNull()
  })

  it('carries the reason of an unavailable channel', () => {
    const blocked = resolveChannelOptions({
      documentType: 'invoice',
      canEmail: false,
      isSandbox: false,
      customerSelected: true,
      customerEmail: 'ekonomi@example.se',
      peppolReady: false,
    })
    const menu = resolveEditorMenu({ ...primary({ channel: 'manual' }), channelOptions: blocked })
    expect(menu?.channels[0]).toMatchObject({ channel: 'email', available: false, reason: 'no_email_plan', selected: false })
    expect(menu?.channels[1]).toMatchObject({ channel: 'manual', selected: true })
  })
})
