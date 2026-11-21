import type {
  InvoiceDeliveryProviderStatus,
  InvoiceDeliveryRecipientStatuses,
} from '@/types'

const PROVIDER_STATUSES = new Set<InvoiceDeliveryProviderStatus>([
  'delayed',
  'delivered',
  'complained',
  'bounced',
  'failed',
  'suppressed',
])

/**
 * Keeps the public recipient-outcome shape PII-free even if an upstream RPC
 * is widened accidentally. Only stable To/CC positions and known outcomes
 * survive; raw addresses and BCC references are discarded.
 */
export function sanitizeDeliveryRecipientStatuses(
  value: unknown,
): InvoiceDeliveryRecipientStatuses {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const sanitized: Record<
    string,
    { status: InvoiceDeliveryProviderStatus; status_at: string }
  > = {}

  for (const [reference, outcome] of Object.entries(value)) {
    if (!/^(to|cc):[1-9][0-9]*$/.test(reference)) continue
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) continue

    const candidate = outcome as { status?: unknown; status_at?: unknown }
    if (
      typeof candidate.status !== 'string'
      || !PROVIDER_STATUSES.has(candidate.status as InvoiceDeliveryProviderStatus)
      || typeof candidate.status_at !== 'string'
      || Number.isNaN(new Date(candidate.status_at).getTime())
    ) {
      continue
    }

    sanitized[reference] = {
      status: candidate.status as InvoiceDeliveryProviderStatus,
      status_at: candidate.status_at,
    }
  }

  return sanitized as InvoiceDeliveryRecipientStatuses
}

/** Same normalization as apply_invoice_delivery_provider_event: lower(btrim()). */
function normalizeDeliveryAddress(address: string): string {
  return address.trim().toLocaleLowerCase('en-US')
}

/**
 * The addresses a provider report names that are not To, CC or BCC of the
 * send. A bounce can arrive for a forward target the customer never told us
 * about: the recipient's server accepted the mail and a later hop rejected
 * it. The DB function then flips the delivery to bounced while every listed
 * recipient stays delivered, which is what this helper lets the caller
 * explain.
 */
export function unmatchedReportRecipients(
  row: { to_addresses: string[]; cc_addresses: string[]; bcc_addresses: string[] },
  reported: string[],
): string[] {
  const known = new Set(
    [...row.to_addresses, ...row.cc_addresses, ...row.bcc_addresses].map(normalizeDeliveryAddress),
  )
  return reported.filter((address) => !known.has(normalizeDeliveryAddress(address)))
}

/**
 * Only the domain survives: the detail column is shown raw to every member
 * and is not cleared by the PII redaction that empties the address columns,
 * so a third party's mailbox name must never land there.
 */
export function maskAddressToDomain(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return '***'
  return `***@${normalizeDeliveryAddress(address.slice(at + 1))}`
}

const DESTRUCTIVE_STATUSES = new Set<string>(['bounced', 'failed', 'suppressed'])

/** The outcomes that mean the invoice did not arrive. */
export function isDestructiveDeliveryStatus(
  status: string | null | undefined,
): status is 'bounced' | 'failed' | 'suppressed' {
  return !!status && DESTRUCTIVE_STATUSES.has(status)
}

/**
 * Appends who a destructive report was for when that is nobody in the send.
 * Delivered and delayed reports are left alone: an unmatched success needs no
 * explanation, and the row would only get noisier.
 */
export function annotateUnmatchedReportDetail(
  status: InvoiceDeliveryProviderStatus,
  detail: string | null,
  reported: string[],
  unmatched: string[],
): string | null {
  if (!isDestructiveDeliveryStatus(status)) return detail
  if (reported.length > 0 && unmatched.length < reported.length) return detail

  const note = reported.length === 0
    ? '(reported without a recipient)'
    : `(reported for ${unmatched.map(maskAddressToDomain).join(', ')})`
  return detail ? `${detail} ${note}` : note
}
