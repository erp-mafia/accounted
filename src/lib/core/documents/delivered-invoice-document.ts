import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

/**
 * Which archived PDF of a customer invoice is the one the customer was
 * emailed, and how it is read whoever asks. In the kernel because the
 * underlag anchoring (customer-invoice-underlag.ts) needs it as well as the
 * deferred Bokför step (lib/invoices/book-invoice-deferred.ts).
 */

/** A row of the masked delivery history, as far as its file is concerned. */
export interface DeliveredFileRow {
  status: string
  document_attachment_id: string | null
  sent_at: string | null
}

/**
 * The archived file the deferred Bokför step links to the invoice's verifikat,
 * and the one a linked payment verifikat takes as underlag: that of the newest
 * delivery, by `sent_at`, that completed as sent and kept one. Unlike
 * findArchivedInvoiceDelivery (lib/invoices/invoice-pdf-source.ts), a later
 * manual mark does not hide it (a mark keeps no file), so an emailed invoice
 * always gets its emailed copy, as `latest_sent_invoice_delivery_document`
 * chose it. Reads `sent_at`, not list order.
 */
export function latestSentDeliveryDocumentId(deliveries: readonly DeliveredFileRow[]): string | null {
  let newest: { documentId: string; sentAt: number } | null = null
  for (const delivery of deliveries) {
    if (delivery.status !== 'sent' || !delivery.document_attachment_id || !delivery.sent_at) continue
    const sentAt = Date.parse(delivery.sent_at)
    if (!newest || sentAt > newest.sentAt) newest = { documentId: delivery.document_attachment_id, sentAt }
  }
  return newest?.documentId ?? null
}

/**
 * The PDF the customer was emailed (latestSentDeliveryDocumentId), read
 * through the masked delivery history, never invoice_deliveries itself: that
 * row holds the mail's exact payload, and its SELECT policy shows a member
 * only the deliveries they sent, so a read there in a colleague's session
 * finds nothing. The session's reader serves every member of the active
 * company. On the service role (the MCP, v1 and grant doors) auth.uid() is
 * null and it refuses with 42501, so the history is read through its sibling,
 * which names the acting member and checks that membership itself. A session
 * has no EXECUTE on the sibling, so a refusal there stands.
 */
export async function deliveredInvoiceDocument(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  userId: string,
): Promise<
  | { ok: true; documentId: string | null }
  | { ok: false; error: PostgrestError; sessionError?: PostgrestError }
> {
  const session = await supabase.rpc('list_invoice_delivery_summaries', {
    p_company_id: companyId,
    p_invoice_id: invoiceId,
  })
  if (!session.error) return { ok: true, documentId: latestSentDeliveryDocumentId(session.data ?? []) }
  if (session.error.code !== '42501') return { ok: false, error: session.error }

  const service = await supabase.rpc('list_invoice_delivery_summaries_for_service', {
    p_company_id: companyId,
    p_user_id: userId,
    p_invoice_id: invoiceId,
  })
  if (service.error) return { ok: false, error: service.error, sessionError: session.error }
  return { ok: true, documentId: latestSentDeliveryDocumentId(service.data ?? []) }
}
