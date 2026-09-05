import { describe, expect, it } from 'vitest'
import {
  invoiceDocumentCaveat,
  invoicePaymentConfirmationUrl,
  invoiceRerenderUrl,
  paymentConfirmationPdfSource,
  resolveInvoicePdfSource,
  type InvoicePdfDelivery,
} from '@/lib/invoices/invoice-pdf-source'

const INVOICE_ID = '3f2b9a6e-1c4d-4a51-9d0f-8b7c6e5d4a31'
const DOCUMENT_ID = 'a1b2c3d4-e5f6-4708-89ab-cdef01234567'

function emailDelivery(overrides: Partial<InvoicePdfDelivery> = {}): InvoicePdfDelivery {
  return {
    id: 'delivery-1',
    status: 'sent',
    document_attachment_id: DOCUMENT_ID,
    sent_at: '2026-07-23T09:15:00.000Z',
    ...overrides,
  }
}

describe('resolveInvoicePdfSource', () => {
  it('serves the archived delivery when one exists', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'sent',
      deliveriesLoaded: true,
      deliveries: [emailDelivery()],
    })

    expect(source).toEqual({
      kind: 'archived',
      url: `/api/documents/${DOCUMENT_ID}/inline`,
      deliveryId: 'delivery-1',
      sentAt: '2026-07-23T09:15:00.000Z',
    })
    expect(invoiceDocumentCaveat(source)).toBeNull()
  })

  it('picks the newest completed delivery, ignoring pending and failed attempts', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'paid',
      deliveriesLoaded: true,
      deliveries: [
        emailDelivery({ id: 'pending', status: 'pending', sent_at: null }),
        emailDelivery({
          id: 'failed',
          status: 'failed',
          document_attachment_id: null,
          sent_at: null,
        }),
        emailDelivery({ id: 'newest-sent', document_attachment_id: DOCUMENT_ID }),
        emailDelivery({ id: 'older-sent', document_attachment_id: 'older-doc' }),
      ],
    })

    expect(source).toMatchObject({ kind: 'archived', deliveryId: 'newest-sent' })
  })

  // The regression this module exists for: a failed delivery-history read used
  // to collapse to [], which is indistinguishable from "never sent", and the
  // download silently switched to a freshly re-rendered PDF while still
  // reporting success.
  it('never re-renders when the delivery history could not be read', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'sent',
      deliveriesLoaded: false,
      deliveries: [],
    })

    expect(source).toEqual({ kind: 'unavailable', reason: 'delivery_history_unreadable' })
    expect(source.kind).not.toBe('rerender')
  })

  it.each(['sent', 'paid', 'partially_paid', 'overdue', 'credited'])(
    'reports unavailable rather than guessing for a %s invoice',
    (invoiceStatus) => {
      expect(
        resolveInvoicePdfSource({
          invoiceId: INVOICE_ID,
          invoiceStatus,
          deliveriesLoaded: false,
          deliveries: [],
        }).kind,
      ).toBe('unavailable')
    },
  )

  it('labels the re-render when a sent invoice genuinely has no delivery row', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'sent',
      deliveriesLoaded: true,
      deliveries: [],
    })

    expect(source).toEqual({
      kind: 'rerender',
      url: `/api/invoices/${INVOICE_ID}/pdf`,
      reason: 'no_archived_copy',
    })
    expect(invoiceDocumentCaveat(source)).toBe('no_archived_copy')
  })

  it('labels the re-render when the latest delivery was marked sent manually', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'overdue',
      deliveriesLoaded: true,
      deliveries: [
        emailDelivery({ id: 'manual', status: 'marked_sent', document_attachment_id: null }),
        emailDelivery({ id: 'older-email' }),
      ],
    })

    expect(source).toEqual({
      kind: 'rerender',
      url: `/api/invoices/${INVOICE_ID}/pdf`,
      reason: 'sent_outside_accounted',
    })
    expect(invoiceDocumentCaveat(source)).toBe('sent_outside_accounted')
  })

  it('falls back to a labelled re-render when a sent row lost its attachment', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'sent',
      deliveriesLoaded: true,
      deliveries: [emailDelivery({ document_attachment_id: null })],
    })

    expect(source).toMatchObject({ kind: 'rerender', reason: 'no_archived_copy' })
  })

  // A proforma can be emailed and makulerad afterwards, so `cancelled` does not
  // prove nothing was sent. A readable history outranks the status: the
  // archived copy exists and is what the recipient got.
  it('serves the archived copy of a sent invoice that was cancelled afterwards', () => {
    const source = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'cancelled',
      deliveriesLoaded: true,
      deliveries: [emailDelivery({ id: 'proforma-send' })],
    })

    expect(source).toMatchObject({ kind: 'archived', deliveryId: 'proforma-send' })
    expect(invoiceDocumentCaveat(source)).toBeNull()
  })

  it.each(['draft', 'cancelled'])(
    'serves the re-render unblocked for a %s invoice even if the history read failed',
    (invoiceStatus) => {
      const source = resolveInvoicePdfSource({
        invoiceId: INVOICE_ID,
        invoiceStatus,
        deliveriesLoaded: false,
        deliveries: [],
      })

      expect(source).toEqual({
        kind: 'rerender',
        url: `/api/invoices/${INVOICE_ID}/pdf`,
        reason: 'not_sent_yet',
      })
      // Nothing was ever sent, so there is no "sent document" to mislabel.
      expect(invoiceDocumentCaveat(source)).toBeNull()
    },
  )

  it('encodes identifiers into both urls', () => {
    const archived = resolveInvoicePdfSource({
      invoiceId: 'inv/1',
      invoiceStatus: 'sent',
      deliveriesLoaded: true,
      deliveries: [emailDelivery({ document_attachment_id: 'doc/1' })],
    })
    expect(archived).toMatchObject({ url: '/api/documents/doc%2F1/inline' })

    const rerender = resolveInvoicePdfSource({
      invoiceId: 'inv/1',
      invoiceStatus: 'draft',
      deliveriesLoaded: true,
      deliveries: [],
    })
    expect(rerender).toMatchObject({ url: '/api/invoices/inv%2F1/pdf' })
  })
})

describe('invoiceDocumentCaveat', () => {
  it.each(['sent_outside_accounted', 'no_archived_copy', 'archive_unreachable'] as const)(
    'refuses to present a %s re-render as the sent document',
    (reason) => {
      expect(
        invoiceDocumentCaveat({
          kind: 'rerender',
          url: `/api/invoices/${INVOICE_ID}/pdf`,
          reason,
        }),
      ).toBe(reason)
    },
  )

  // Nothing was downloaded, so there is nothing to caveat: the caller must
  // open the dialog rather than report any kind of success.
  it('returns no caveat for an unavailable source', () => {
    expect(
      invoiceDocumentCaveat({ kind: 'unavailable', reason: 'delivery_history_unreadable' }),
    ).toBeNull()
  })
})

describe('invoiceRerenderUrl', () => {
  it('defaults to the download endpoint', () => {
    expect(invoiceRerenderUrl(INVOICE_ID)).toBe(`/api/invoices/${INVOICE_ID}/pdf`)
  })

  // #1190: previewing must not silently become a download, and the archived
  // delivery URL above is already an inline proxy, so both source kinds can be
  // opened in the browser the same way.
  it('asks for an inline response when previewing', () => {
    expect(invoiceRerenderUrl(INVOICE_ID, { inline: true })).toBe(
      `/api/invoices/${INVOICE_ID}/pdf?disposition=inline`,
    )
  })

  it('encodes the invoice id', () => {
    expect(invoiceRerenderUrl('a/b', { inline: true })).toBe(
      '/api/invoices/a%2Fb/pdf?disposition=inline',
    )
  })

  // The preview probes the route before pointing the tab at it, so a refusal
  // (no payment account for the currency) is shown in the app instead of as
  // raw JSON in the new tab.
  it('adds the probe flag next to the inline disposition', () => {
    expect(invoiceRerenderUrl(INVOICE_ID, { inline: true, probe: true })).toBe(
      `/api/invoices/${INVOICE_ID}/pdf?disposition=inline&probe=1`,
    )
    expect(invoiceRerenderUrl(INVOICE_ID, { probe: true })).toBe(
      `/api/invoices/${INVOICE_ID}/pdf?probe=1`,
    )
  })
})

// #1693: the betalningsbekräftelse is always a re-render and always says so,
// however the delivery history looks. An archived delivery is the invoice as
// sent (unpaid); the paid copy is a different document and never replaces it.
describe('paymentConfirmationPdfSource', () => {
  it('is a re-render of the paid variant with its own caveat', () => {
    const source = paymentConfirmationPdfSource(INVOICE_ID)

    expect(source).toEqual({
      kind: 'rerender',
      url: `/api/invoices/${INVOICE_ID}/pdf?variant=paid`,
      reason: 'payment_confirmation',
    })
    expect(invoiceDocumentCaveat(source)).toBe('payment_confirmation')
  })

  it('never resolves to the archived delivery, even when one exists', () => {
    const archived = resolveInvoicePdfSource({
      invoiceId: INVOICE_ID,
      invoiceStatus: 'paid',
      deliveriesLoaded: true,
      deliveries: [emailDelivery()],
    })
    expect(archived.kind).toBe('archived')

    const confirmation = paymentConfirmationPdfSource(INVOICE_ID)
    expect(confirmation.kind).toBe('rerender')
    expect(confirmation.url).not.toContain('/api/documents/')
  })

  it('encodes the invoice id in the confirmation url', () => {
    expect(invoicePaymentConfirmationUrl('a/b')).toBe('/api/invoices/a%2Fb/pdf?variant=paid')
  })
})
