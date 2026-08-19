/**
 * Which PDF the invoice detail page may hand the user, and what it must be
 * called when it does.
 *
 * A sent invoice has an archived delivery: the exact file the customer
 * received, captured before the provider call and kept in the WORM archive
 * (`invoice_deliveries.document_attachment_id`, held down by
 * `block_sent_invoice_document_deletion`). That file is räkenskapsinformation:
 * BFL 7 kap requires it preserved for 7 years, in varaktigt läsbart skick, and
 * producible on request as a faithful reproduction.
 *
 * `/api/invoices/[id]/pdf` does NOT return that file. It re-renders from
 * today's invoice row, today's customer row, today's company_settings and
 * today's branding/logo. Whenever any of those changed since the send, the
 * re-render is a different document. It is a perfectly legitimate document in
 * its own right; it is simply not the one that was sent, and it must never be
 * served as though it were.
 *
 * Hence three outcomes that are never allowed to collapse into each other:
 *
 *  - `archived`:    the delivered file exists. Serve it. Nothing to explain.
 *  - `unavailable`: the delivery history could not be read, so whether an
 *                   archived copy exists is unknown. Substituting a re-render
 *                   here is the bug this module exists to prevent: the caller
 *                   must ask the user, not guess on their behalf.
 *  - `rerender`:    no archived copy can be served, and `reason` says why, so
 *                   the caller can label what it hands over instead of
 *                   presenting it as the sent document.
 */

/** Delivery statuses whose CHECK constraint guarantees `sent_at IS NOT NULL`. */
const COMPLETED_DELIVERY_STATUSES = ['sent', 'marked_sent'] as const

/**
 * Invoice statuses that make an archived copy plausible enough to stop for when
 * the delivery history cannot be read. A draft was never sent, and `cancelled`
 * is reachable only for a draft (`DELETE /api/invoices/[id]` refuses anything
 * else) or for a proforma, which is not a faktura and not
 * räkenskapsinformation. Blocking those behind a dialog would trade a real cost
 * (a draft you cannot download because an unrelated request failed) for a
 * near-empty risk, so the gate stays narrow.
 *
 * This list only governs the unreadable case. When the history DID load it is
 * the data, not the status, that decides: an emailed proforma that was later
 * makulerad still has its archived copy and still gets served it.
 */
const POSSIBLY_DELIVERED_STATUSES = [
  'sent',
  'paid',
  'partially_paid',
  'overdue',
  'credited',
] as const

export interface InvoicePdfDelivery {
  id: string
  status: 'pending' | 'sent' | 'failed' | 'marked_sent'
  document_attachment_id: string | null
  sent_at: string | null
}

export type InvoicePdfRerenderReason =
  /** Never sent. The re-render is the only document there has ever been. */
  | 'not_sent_yet'
  /** Latest completed delivery was a manual mark: Accounted never held that file. */
  | 'sent_outside_accounted'
  /** Sent, but no archived delivery exists (invoice predates delivery history). */
  | 'no_archived_copy'
  /** An archived copy may exist but could not be retrieved; the user chose this. */
  | 'archive_unreachable'
  /**
   * The betalningsbekräftelse (#1693): a fresh render of a paid invoice with
   * the BETALD stamp. It is its own document, produced on request, and is never
   * the file the customer was originally sent, however the archive looks.
   */
  | 'payment_confirmation'

export type InvoicePdfSource =
  | {
      kind: 'archived'
      url: string
      deliveryId: string
      sentAt: string | null
    }
  | {
      kind: 'rerender'
      url: string
      reason: InvoicePdfRerenderReason
    }
  | {
      kind: 'unavailable'
      reason: 'delivery_history_unreadable'
    }

/**
 * The re-render endpoint. `inline` asks it to serve the PDF for in-browser
 * review instead of a download (#1190); the archived-delivery URL below is
 * already an inline proxy, so both source kinds can be previewed the same way.
 */
export function invoiceRerenderUrl(invoiceId: string, options?: { inline?: boolean }): string {
  const base = `/api/invoices/${encodeURIComponent(invoiceId)}/pdf`
  return options?.inline ? `${base}?disposition=inline` : base
}

/**
 * The betalningsbekräftelse endpoint: the same re-render route in its paid
 * variant. The route refuses anything but a paid faktura and names the file
 * accordingly; the archived original is not involved at any point.
 */
export function invoicePaymentConfirmationUrl(invoiceId: string): string {
  return `${invoiceRerenderUrl(invoiceId)}?variant=paid`
}

/**
 * The paid copy is always a re-render and is always labelled as one. There is
 * no archived variant to look for: even when the delivery history holds the
 * sent invoice, that file shows the invoice as it was before payment and is
 * a different document from the betalningsbekräftelse.
 */
export function paymentConfirmationPdfSource(
  invoiceId: string,
): Extract<InvoicePdfSource, { kind: 'rerender' }> {
  return {
    kind: 'rerender',
    url: invoicePaymentConfirmationUrl(invoiceId),
    reason: 'payment_confirmation',
  }
}

/**
 * Decide which file the download button may fetch.
 *
 * `deliveries` is the list as returned by `/api/invoices/[id]/deliveries`,
 * newest first (`list_invoice_delivery_summaries` orders by `created_at DESC`).
 * `deliveriesLoaded` must be false whenever that request failed or returned an
 * unexpected shape: an empty array from a failed read is indistinguishable from
 * a genuinely empty history, and treating the two alike is exactly what turns a
 * network blip into a substituted document.
 */
export function resolveInvoicePdfSource(input: {
  invoiceId: string
  invoiceStatus: string
  deliveriesLoaded: boolean
  deliveries: InvoicePdfDelivery[]
}): InvoicePdfSource {
  const rerenderUrl = invoiceRerenderUrl(input.invoiceId)
  const couldHaveBeenDelivered = (POSSIBLY_DELIVERED_STATUSES as readonly string[]).includes(
    input.invoiceStatus,
  )

  // The history is the record of what was sent, so when it is readable it
  // decides on its own. Reaching for the status first would discard a real
  // archived copy behind a status that merely makes one unlikely.
  if (!input.deliveriesLoaded) {
    return couldHaveBeenDelivered
      ? { kind: 'unavailable', reason: 'delivery_history_unreadable' }
      : { kind: 'rerender', url: rerenderUrl, reason: 'not_sent_yet' }
  }

  const latestCompleted = input.deliveries.find((delivery) =>
    (COMPLETED_DELIVERY_STATUSES as readonly string[]).includes(delivery.status),
  )

  if (latestCompleted?.status === 'sent' && latestCompleted.document_attachment_id) {
    return {
      kind: 'archived',
      url: `/api/documents/${encodeURIComponent(latestCompleted.document_attachment_id)}/inline`,
      deliveryId: latestCompleted.id,
      sentAt: latestCompleted.sent_at,
    }
  }

  if (latestCompleted?.status === 'marked_sent') {
    return { kind: 'rerender', url: rerenderUrl, reason: 'sent_outside_accounted' }
  }

  // No completed delivery in a history that loaded fine. For a status that was
  // never sent there is no sent document to be confused with; otherwise the
  // invoice went out before delivery history existed.
  return {
    kind: 'rerender',
    url: rerenderUrl,
    reason:
      latestCompleted !== undefined || couldHaveBeenDelivered
        ? 'no_archived_copy'
        : 'not_sent_yet',
  }
}

/**
 * What must be disclosed about the file the user just received, or null when it
 * may be presented plainly as the invoice. Only the archived delivery earns
 * that, plus a never-sent invoice, where there is no sent document to be
 * confused with in the first place.
 */
export function invoiceDocumentCaveat(
  source: InvoicePdfSource,
): Exclude<InvoicePdfRerenderReason, 'not_sent_yet'> | null {
  if (source.kind !== 'rerender') return null
  return source.reason === 'not_sent_yet' ? null : source.reason
}
