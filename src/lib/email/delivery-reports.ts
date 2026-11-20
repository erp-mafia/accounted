import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceDeliveryProviderStatus } from '@/types'

/**
 * Delivery reports, whichever provider sent the mail. Each provider's
 * webhook verifies and parses its own payload into a ProviderDeliveryReport
 * (Resend: extensions/general/email/lib/delivery-webhook.ts) and hands it to
 * applyDeliveryReport, which finds the mail it belongs to: an invoice
 * delivery (invoice_deliveries) or a reminder (invoice_reminders). Moving to
 * another provider means a new parser and webhook route, nothing below.
 */
export interface ProviderDeliveryReport {
  providerMessageId: string
  status: InvoiceDeliveryProviderStatus
  occurredAt: string
  detail: string | null
  recipients: string[]
}

export type AppliedDeliveryReport =
  | { applied: 'invoice_delivery' | 'invoice_reminder'; id: string }
  | { applied: null }

export class DeliveryReportError extends Error {
  constructor(target: string, message: string) {
    super(`${target} delivery report failed: ${message}`)
    this.name = 'DeliveryReportError'
  }
}

/** PostgREST and Postgres codes for a function the schema does not have (yet). */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883'])

/**
 * Record a report on the mail that carries its message id, invoice
 * deliveries first. Throws on a database error, so the webhook answers 5xx
 * and the provider retries. `detail` is the line stored with the status
 * (the caller may annotate the provider's own).
 */
export async function applyDeliveryReport(
  service: Pick<SupabaseClient, 'rpc'>,
  provider: string,
  report: ProviderDeliveryReport,
  detail: string | null = report.detail,
): Promise<AppliedDeliveryReport> {
  const delivery = await service.rpc('apply_invoice_delivery_provider_event', {
    p_provider: provider,
    p_provider_message_id: report.providerMessageId,
    p_status: report.status,
    p_occurred_at: report.occurredAt,
    p_detail: detail,
    p_recipient_addresses: report.recipients,
  })
  if (delivery.error) throw new DeliveryReportError('invoice', delivery.error.message)
  if (delivery.data) return { applied: 'invoice_delivery', id: delivery.data as string }

  const reminder = await service.rpc('apply_invoice_reminder_provider_status', {
    p_provider: provider,
    p_provider_message_id: report.providerMessageId,
    p_status: report.status,
    p_occurred_at: report.occurredAt,
    p_detail: detail,
  })
  if (reminder.error) {
    // Between a deploy and its migration (migrations-production runs after
    // the merge) the function may not exist yet; no reminder can carry the
    // id then, so the report matches nothing instead of failing every mail.
    if (MISSING_FUNCTION_CODES.has(reminder.error.code ?? '')) return { applied: null }
    throw new DeliveryReportError('reminder', reminder.error.message)
  }
  if (reminder.data) return { applied: 'invoice_reminder', id: reminder.data as string }
  return { applied: null }
}
