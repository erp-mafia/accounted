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
