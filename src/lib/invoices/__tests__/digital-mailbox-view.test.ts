import { describe, it, expect } from 'vitest'
import {
  EMPTY_INVOICE_MAILBOX_VIEW,
  mailboxSendActions,
  mergeDeliveryHistory,
  parseInvoiceMailboxView,
  type MailboxDispatchView,
} from '@/lib/invoices/digital-mailbox-view'

function dispatch(overrides: Partial<MailboxDispatchView> = {}): MailboxDispatchView {
  return {
    id: 'd-1',
    provider: 'kivra',
    status: 'sent',
    error_code: null,
    created_at: '2026-10-19T10:00:00Z',
    ...overrides,
  }
}

describe('parseInvoiceMailboxView', () => {
  it('reads the options and the dispatches', () => {
    expect(
      parseInvoiceMailboxView({
        data: {
          options: [
            { provider: 'kivra', available: true, reason: null },
            { provider: 'billo', available: false, reason: 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED' },
          ],
          dispatches: [
            {
              id: 'd-2',
              provider: 'billo',
              recipient_kind: 'person',
              status: 'failed',
              error_code: 'DIGITAL_MAILBOX_SEND_FAILED',
              created_at: '2026-10-19T11:00:00Z',
            },
          ],
        },
      }),
    ).toEqual({
      options: [
        { provider: 'kivra', available: true, reason: null },
        { provider: 'billo', available: false, reason: 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED' },
      ],
      dispatches: [
        {
          id: 'd-2',
          provider: 'billo',
          status: 'failed',
          error_code: 'DIGITAL_MAILBOX_SEND_FAILED',
          created_at: '2026-10-19T11:00:00Z',
        },
      ],
    })
  })

  it('drops malformed rows and reads a refusal or garbage as the empty view', () => {
    expect(
      parseInvoiceMailboxView({
        data: {
          options: [{ provider: 'postnord', available: true }, { provider: 'kivra' }, null],
          dispatches: [{ id: 'd-1', provider: 'kivra', status: 'queued', created_at: 'x' }, 'row'],
        },
      }),
    ).toEqual(EMPTY_INVOICE_MAILBOX_VIEW)
    expect(parseInvoiceMailboxView({ error: { code: 'INVOICE_NOT_FOUND' } })).toEqual(EMPTY_INVOICE_MAILBOX_VIEW)
    expect(parseInvoiceMailboxView(null)).toEqual(EMPTY_INVOICE_MAILBOX_VIEW)
    expect(parseInvoiceMailboxView({ data: { options: 'nope' } })).toEqual(EMPTY_INVOICE_MAILBOX_VIEW)
  })
})

describe('mailboxSendActions', () => {
  const both = [
    { provider: 'kivra' as const, available: true, reason: null },
    { provider: 'billo' as const, available: true, reason: null },
  ]

  it('offers each provider for a draft and an issued, unpaid invoice', () => {
    for (const status of ['draft', 'sent', 'overdue', 'partially_paid'] as const) {
      expect(mailboxSendActions(status, both)).toEqual([
        { provider: 'kivra', blockedBy: null },
        { provider: 'billo', blockedBy: null },
      ])
    }
  })

  it('offers nothing once the invoice is paid, credited or cancelled', () => {
    for (const status of ['paid', 'credited', 'cancelled'] as const) {
      expect(mailboxSendActions(status, both)).toEqual([])
    }
  })

  it('keeps a provider the kundkort or the currency blocks, disabled with why', () => {
    expect(
      mailboxSendActions('sent', [
        { provider: 'kivra', available: false, reason: 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED' },
        { provider: 'billo', available: false, reason: 'DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED' },
      ]),
    ).toEqual([
      { provider: 'kivra', blockedBy: 'recipient_unidentified' },
      { provider: 'billo', blockedBy: 'currency' },
    ])
  })

  it('has no item for an invoice that can never go to a mailbox (a kreditfaktura, a quote)', () => {
    expect(
      mailboxSendActions('sent', [{ provider: 'kivra', available: false, reason: 'DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE' }]),
    ).toEqual([])
    expect(mailboxSendActions('sent', [{ provider: 'kivra', available: false, reason: null }])).toEqual([])
  })
})

describe('mergeDeliveryHistory', () => {
  const at = (row: { at: string }) => row.at

  it('interleaves email deliveries and mailbox dispatches, newest first', () => {
    const merged = mergeDeliveryHistory(
      [{ id: 'e-2', at: '2026-10-19T12:00:00Z' }, { id: 'e-1', at: '2026-10-18T12:00:00Z' }],
      at,
      [dispatch({ id: 'd-1', created_at: '2026-10-19T09:00:00Z' }), dispatch({ id: 'd-0', created_at: '2026-10-17T09:00:00Z' })],
    )
    expect(merged.map((entry) => (entry.kind === 'delivery' ? entry.delivery.id : entry.dispatch.id))).toEqual([
      'e-2',
      'd-1',
      'e-1',
      'd-0',
    ])
  })

  it('keeps the arrival order on a tie and sorts an unreadable time last', () => {
    const merged = mergeDeliveryHistory(
      [{ id: 'e-bad', at: 'not a date' }, { id: 'e-1', at: '2026-10-19T10:00:00Z' }],
      at,
      [dispatch({ id: 'd-1', created_at: '2026-10-19T10:00:00Z' })],
    )
    expect(merged.map((entry) => (entry.kind === 'delivery' ? entry.delivery.id : entry.dispatch.id))).toEqual([
      'e-1',
      'd-1',
      'e-bad',
    ])
  })

  it('is the dispatches alone when nothing was emailed', () => {
    const merged = mergeDeliveryHistory([], at, [dispatch()])
    expect(merged).toEqual([{ kind: 'mailbox', at: '2026-10-19T10:00:00Z', dispatch: dispatch() }])
  })
})
