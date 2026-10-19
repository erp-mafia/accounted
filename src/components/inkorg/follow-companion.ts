import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'

/** What POST /api/inkorg/items/:id/companion answers, as far as the page reads it. */
export type CompanionAnswer =
  | { status: 'completed' | 'already_done' }
  | { status: 'waiting'; reason: 'invoice_not_booked' | 'invoice_unpaid' | 'several_payments' | 'receipt_not_linked' }
  | { status: 'failed'; message: string }

/**
 * The receipt that came with an invoice follows it onto its booking, once
 * the person's answer has booked the invoice. Never throws: a failure is an
 * answer the page tells the person about, and the receipt stays in the inbox.
 */
export async function followCompanion(invoiceItemId: string, receiptItemId: string, locale: 'sv' | 'en'): Promise<CompanionAnswer> {
  try {
    const res = await fetch(`/api/inkorg/items/${invoiceItemId}/companion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receipt_item_id: receiptItemId }),
    })
    if (!res.ok) {
      notifySessionExpired(res)
      return { status: 'failed', message: await getResponseErrorMessage(res, undefined, locale) }
    }
    const json = (await res.json()) as { data?: CompanionAnswer }
    return json.data ?? { status: 'already_done' }
  } catch {
    return { status: 'failed', message: '' }
  }
}
