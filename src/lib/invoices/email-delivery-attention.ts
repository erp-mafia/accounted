import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { isDestructiveDeliveryStatus } from '@/lib/invoices/delivery-recipient-statuses'
import type { InvoiceDelivery } from '@/types'

export type EmailDeliveryFailure = 'bounced' | 'failed' | 'suppressed'

export interface EmailDeliveryAttention {
  status: EmailDeliveryFailure
  /**
   * The addresses the failure is for, as the delivery list holds them (the
   * read masks them to the domain): the listed recipients the provider named,
   * else the To addresses of the send.
   */
  addresses: string[]
}

export type EmailDeliveryAttentionInput = Pick<
  InvoiceDelivery,
  | 'channel'
  | 'to_addresses'
  | 'cc_addresses'
  | 'provider_status'
  | 'provider_recipient_statuses'
  | 'created_at'
> & { status: string }

function isHandover(delivery: EmailDeliveryAttentionInput): boolean {
  if (delivery.channel === 'import') return false
  return delivery.status === 'sent' || delivery.status === 'marked_sent'
}

function timeOf(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/**
 * What the invoice page says when the invoice email did not reach the
 * recipient (one sentence, convention 6): the email counterpart of
 * peppol-attention.ts.
 *
 * The provider's report on the newest handover decides. Bounced, failed and
 * suppressed mean the mail never arrived (isDestructiveDeliveryStatus, the
 * outcomes the delivery history marks red). A spam complaint is not one of
 * them: that mail arrived and the recipient flagged it, which the delivery
 * history shows on its own row.
 *
 * Only the newest handover counts, so the warning clears once the invoice
 * went out again: a later email the provider accepted and has not reported as
 * failed (a resend), a manual mark, or a send another way (Peppol, a digital
 * mailbox; the caller passes when those were made). A send that failed before
 * it left (delivery status failed) reached nobody and changes nothing, and an
 * imported copy from the previous system is not a handover by this app.
 *
 * The warning holds while the invoice is still owed (isOwedInvoiceStatus): a
 * paid, credited or cancelled invoice has nothing left to deliver.
 */
export function emailDeliveryAttention(
  invoiceStatus: string,
  deliveries: EmailDeliveryAttentionInput[],
  sentOtherWayAt: Array<string | null | undefined> = [],
): EmailDeliveryAttention | null {
  if (!isOwedInvoiceStatus(invoiceStatus)) return null

  let latest: EmailDeliveryAttentionInput | null = null
  for (const delivery of deliveries) {
    if (!isHandover(delivery)) continue
    if (!latest || timeOf(delivery.created_at) > timeOf(latest.created_at)) latest = delivery
  }
  if (!latest || latest.channel !== 'email') return null

  const status = latest.provider_status
  if (!isDestructiveDeliveryStatus(status)) return null

  const handedOverAt = timeOf(latest.created_at)
  if (sentOtherWayAt.some((at) => timeOf(at) > handedOverAt)) return null

  const recipientStatuses = latest.provider_recipient_statuses ?? {}
  const failedRecipients = [
    ...latest.to_addresses.filter((_, index) =>
      isDestructiveDeliveryStatus(recipientStatuses[`to:${index + 1}`]?.status)),
    ...latest.cc_addresses.filter((_, index) =>
      isDestructiveDeliveryStatus(recipientStatuses[`cc:${index + 1}`]?.status)),
  ]

  return {
    status,
    addresses: failedRecipients.length > 0 ? failedRecipients : latest.to_addresses,
  }
}
