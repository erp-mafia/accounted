import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sanitizeDeliveryRecipientStatuses } from '@/lib/invoices/delivery-recipient-statuses'
import type {
  InvoiceDeliveryChannel,
  InvoiceDeliveryProviderStatus,
  InvoiceDeliveryRecipientStatuses,
  InvoiceDeliveryStatus,
} from '@/types'

interface InvoiceDeliverySummaryRow {
  id: string
  channel: InvoiceDeliveryChannel
  status: InvoiceDeliveryStatus
  to_addresses: string[]
  cc_addresses: string[]
  provider: string | null
  provider_status: InvoiceDeliveryProviderStatus | null
  provider_status_at: string | null
  provider_status_detail: string | null
  provider_recipient_statuses: InvoiceDeliveryRecipientStatuses
  error_code: string | null
  document_attachment_id: string | null
  attachment_filename: string | null
  sent_at: string | null
  failed_at: string | null
  created_at: string
}

type MaskedRecipientAddress = string & { readonly __maskedRecipientAddress: true }

interface MaskedInvoiceDeliverySummaryRow
  extends Omit<InvoiceDeliverySummaryRow, 'to_addresses' | 'cc_addresses'> {
  to_addresses: MaskedRecipientAddress[]
  cc_addresses: MaskedRecipientAddress[]
}

/**
 * GET /api/invoices/[id]/deliveries
 *
 * Returns minimized delivery metadata for an invoice. Exact message content,
 * BCC recipients, provider identifiers, checksums, and full recipient
 * addresses stay server-side. The attachment filename passes through: it is
 * derived from data the invoice already exposes to every company member. The
 * database allow-list and masking boundary is defined by
 * list_invoice_delivery_summaries in the invoice delivery migrations; this route
 * masks returned addresses again as defense in depth.
 *
 * Recipient outcomes use only stable To/CC positions. Exact addresses and BCC
 * references never cross the database boundary, and reason text that can
 * quote a failing address is masked again here.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.deliveries.list',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: deliveries, error } = await supabase.rpc(
      'list_invoice_delivery_summaries',
      { p_company_id: companyId, p_invoice_id: id },
    )

    if (error) {
      log.error('failed to list invoice deliveries', error, { invoiceId: id })
      throw error
    }

    const minimized: MaskedInvoiceDeliverySummaryRow[] = (
      (deliveries || []) as unknown as InvoiceDeliverySummaryRow[]
    ).map((delivery) => ({
      id: delivery.id,
      channel: delivery.channel,
      status: delivery.status,
      to_addresses: delivery.to_addresses.map(maskRecipientDomain),
      cc_addresses: delivery.cc_addresses.map(maskRecipientDomain),
      provider: delivery.provider,
      provider_status: delivery.provider_status,
      provider_status_at: delivery.provider_status_at,
      provider_status_detail: maskAddressesInText(delivery.provider_status_detail),
      provider_recipient_statuses: sanitizeDeliveryRecipientStatuses(
        delivery.provider_recipient_statuses,
      ),
      error_code: delivery.error_code,
      document_attachment_id: delivery.document_attachment_id,
      attachment_filename: delivery.attachment_filename,
      sent_at: delivery.sent_at,
      failed_at: delivery.failed_at,
      created_at: delivery.created_at,
    }))

    return NextResponse.json(
      { data: minimized },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
)

/**
 * Provider reason texts routinely quote the address that failed
 * ("550 5.1.1 <anna@example.se>: user unknown"). Keep the diagnostic value,
 * drop the local part, matching how the recipient list itself is masked.
 *
 * The local part is matched by exclusion, not by an allow-list of ASCII mail
 * characters: an allow-list stops at the first character it does not know, so
 * it leaks the head of every address it cannot spell. `anna.bergström@` would
 * mask only the `m`, and a quoted local part ("anna berg"@example.com) would
 * not match at all. Anything up to the delimiters that genuinely cannot sit
 * inside an address (whitespace, the angle brackets and punctuation providers
 * wrap addresses in) is treated as local part, so over-masking is the failure
 * mode rather than a partial disclosure.
 */
const ADDRESS_LOCAL_PART = /"[^"]*"@|[^\s<>()[\],;:"@]+@/gu

function maskAddressesInText(text: string | null): string | null {
  if (!text) return null
  return text.replace(ADDRESS_LOCAL_PART, '***@')
}

function maskRecipientDomain(address: string): MaskedRecipientAddress {
  const separator = address.lastIndexOf('@')
  if (separator <= 0 || separator === address.length - 1) {
    return '***' as MaskedRecipientAddress
  }
  return `***@${address.slice(separator + 1)}` as MaskedRecipientAddress
}
