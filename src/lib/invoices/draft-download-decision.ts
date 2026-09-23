import type { Invoice } from '@/types'

/**
 * What "Ladda ner PDF" should do for a document that is not yet issued.
 *
 * The renderer watermarks every status='draft' document "UTKAST" ("DRAFT"
 * on an English document). That stamp is correct: an unbooked invoice is
 * not issued. The
 * problem (#2399) is that nothing said so before the file was on disk, and
 * the stamped PDF was mailed to customers by mistake. So the download asks
 * first, and offers the path that produces the real document.
 *
 * - `download`: issued (or a document kind with no issue step); save as is.
 * - `offer_issue`: numbered, not sent: offer "Markera som skickad (och
 *   bokför) och ladda ner", the same action as the page's primary button.
 * - `confirm_draft`: no number yet: nothing to issue, only a warning that the
 *   file is a stamped draft. Granska & skapa is the way to a number.
 */
export type DraftDownloadDecision = 'download' | 'offer_issue' | 'confirm_draft'

type DecisionInvoice = Pick<Invoice, 'status' | 'invoice_number'> & {
  document_type?: string | null
  is_self_billed?: boolean | null
}

export function draftDownloadDecision(invoice: DecisionInvoice): DraftDownloadDecision {
  if (invoice.status !== 'draft') return 'download'
  // Self-billed: the counterparty's document, no own PDF to issue.
  if (invoice.is_self_billed) return 'download'
  // Every other kind (faktura, kreditfaktura, offert, proforma, följesedel)
  // is stamped while status is draft; the page picks the issue action per
  // kind (send dialog, or the plain status flip for följesedlar).
  return invoice.invoice_number ? 'offer_issue' : 'confirm_draft'
}
