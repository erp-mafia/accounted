/**
 * Tell the attesters when an invoice that needs their attest is registered.
 *
 * Two surfaces. The worklist row ("Attestera {leverantör} {belopp}" on Hem)
 * is derived from the policy and the trail on every read
 * (listSupplierInvoiceAttestsDue), so it needs nothing written here. The
 * mail goes to each attester whose approval would count
 * (attestProgress.remaining: with limits, only those whose limit covers the
 * invoice unless it needs two attesters) and who has not switched the mail
 * off (notification_settings.attest_request_email_enabled, default on).
 *
 * Batched (crm#1569): a registration only queues the invoice
 * (queueAttestRequest); the request job (attest-mail-run.ts) sends each
 * attester one mail per company and round, listing every invoice waiting on
 * them, once the company has registered nothing new for 15 minutes. Until
 * the migration has reached the database, a registration mails the
 * attesters at once, one invoice per mail, with the Godkänn / Neka links of
 * that invoice (notifyAttestersOfInvoice, attest-links.ts): the way every
 * registration was told before.
 *
 * Bound to supplier_invoice.registered (the attest-notify consumer in
 * lib/composition/event-consumers.ts, which lib/init subscribes). Never
 * throws at the emitter: a failed mail leaves the worklist row, which asks
 * for the same attest.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendAttestRequestMail } from '@/lib/email/send-attest-request'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createLogger, type Logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import { queueAttestRequest } from './attest-batches'
import { attestLinkUrl, markAttestLinkMailed, mintAttestLink } from './attest-links'
import { attestProgress, invoiceNeedsAttest, type AttestInvoiceFacts } from './attest-policy'
import { loadActiveAttestMembers, loadAttestLimits, loadAttestPeople, loadAttestPolicy } from './attest-service'

const log = createLogger('supplier-invoices/attest-notify')

export interface AttestNotifyResult {
  mailed: number
  skipped_opted_out: number
  skipped_no_email: number
}

/** Mail every attester who may attest the invoice. Returns what was sent; does nothing when the policy does not govern it. */
export async function notifyAttestersOfInvoice(
  service: SupabaseClient,
  companyId: string,
  invoiceId: string,
  logger: Logger = log,
): Promise<AttestNotifyResult> {
  const result: AttestNotifyResult = { mailed: 0, skipped_opted_out: 0, skipped_no_email: 0 }
  const policy = await loadAttestPolicy(service, companyId)
  if (!policy.enabled) return result

  const [{ data: invoiceRow, error: invoiceError }, { data: settingsRow }, { data: companyRow }] = await Promise.all([
    service
      .from('supplier_invoices')
      .select('id, user_id, status, approved_at, is_credit_note, currency, total, total_sek, exchange_rate, supplier_invoice_number, arrival_number, due_date, supplier:suppliers(name)')
      .eq('company_id', companyId)
      .eq('id', invoiceId)
      .maybeSingle(),
    service.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    service.from('companies').select('name').eq('id', companyId).maybeSingle(),
  ])
  if (invoiceError) throw invoiceError
  const invoice = invoiceRow as unknown as {
    id: string
    user_id: string
    status: string
    approved_at: string | null
    is_credit_note: boolean
    currency: string
    total: number
    total_sek: number | null
    exchange_rate: number | null
    supplier_invoice_number: string | null
    arrival_number: number
    due_date: string
    supplier: { name: string | null } | null
  } | null
  if (!invoice || invoice.approved_at || !['registered', 'overdue'].includes(invoice.status)) return result
  const accountingMethod = (settingsRow as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const facts = { ...invoice, total: Number(invoice.total) }
  if (!invoiceNeedsAttest(policy, accountingMethod, facts)) return result

  const [members, limits] = await Promise.all([loadActiveAttestMembers(service, companyId), loadAttestLimits(service, companyId)])
  const recipients = attestProgress(policy, accountingMethod, facts, [], members, limits).remaining
  if (recipients.length === 0) return result

  const [people, { data: prefs }] = await Promise.all([
    loadAttestPeople(service, [...recipients, invoice.user_id]),
    service.from('notification_settings').select('user_id, attest_request_email_enabled').in('user_id', recipients),
  ])
  const optedOut = new Set(
    ((prefs ?? []) as Array<{ user_id: string; attest_request_email_enabled: boolean | null }>)
      .filter((p) => p.attest_request_email_enabled === false)
      .map((p) => p.user_id),
  )
  const baseUrl = await getBaseUrlForCompany(companyId)
  const registrant = people.get(invoice.user_id)
  const companyName = (companyRow as { name: string | null } | null)?.name?.trim() || 'Företaget'

  for (const attesterId of recipients) {
    if (optedOut.has(attesterId)) {
      result.skipped_opted_out++
      continue
    }
    const email = people.get(attesterId)?.email?.trim()
    if (!email) {
      result.skipped_no_email++
      continue
    }
    const link = await mintAttestLink(service, { companyId, invoiceId: invoice.id, attesterUserId: attesterId })
    const sent = await sendAttestRequestMail({
      companyId,
      email,
      log: logger,
      data: {
        companyName,
        supplierName: invoice.supplier?.name?.trim() || 'Leverantören',
        invoiceNumber: invoice.supplier_invoice_number,
        arrivalNumber: invoice.arrival_number,
        total: facts.total,
        currency: invoice.currency,
        dueDate: invoice.due_date,
        registeredBy: registrant?.name ?? registrant?.email ?? null,
        approveUrl: attestLinkUrl(baseUrl, link.token, 'approve'),
        rejectUrl: attestLinkUrl(baseUrl, link.token, 'reject'),
        expiresAt: link.expires_at,
      },
    })
    if (sent.emailSent) {
      result.mailed++
      await markAttestLinkMailed(service, link.link_id).catch((error) =>
        logger.warn('attest link mail not logged on the row', { message: error instanceof Error ? error.message : String(error) }),
      )
    }
  }
  return result
}

export type AskAttestersResult = { outcome: 'not_needed' } | { outcome: 'queued' } | ({ outcome: 'mailed' } & AttestNotifyResult)

/**
 * A registration: when the policy governs the invoice and it waits for
 * attest, queue it for the batched request; before the migration, mail the
 * attesters about it on its own.
 */
export async function askAttestersOfInvoice(
  service: SupabaseClient,
  companyId: string,
  invoiceId: string,
  logger: Logger = log,
): Promise<AskAttestersResult> {
  const policy = await loadAttestPolicy(service, companyId)
  if (!policy.enabled) return { outcome: 'not_needed' }
  const [{ data: invoiceRow, error: invoiceError }, { data: settingsRow, error: settingsError }] = await Promise.all([
    service
      .from('supplier_invoices')
      .select('id, user_id, status, approved_at, is_credit_note, currency, total, total_sek, exchange_rate')
      .eq('company_id', companyId)
      .eq('id', invoiceId)
      .maybeSingle(),
    service.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
  ])
  if (invoiceError) throw invoiceError
  if (settingsError) throw settingsError
  const invoice = invoiceRow as unknown as (AttestInvoiceFacts & { status: string; approved_at: string | null }) | null
  if (!invoice || invoice.approved_at || !['registered', 'overdue'].includes(invoice.status)) return { outcome: 'not_needed' }
  const accountingMethod = (settingsRow as { accounting_method?: string | null } | null)?.accounting_method ?? null
  if (!invoiceNeedsAttest(policy, accountingMethod, { ...invoice, total: Number(invoice.total) })) return { outcome: 'not_needed' }

  if ((await queueAttestRequest(service, companyId, invoiceId)) === 'queued') return { outcome: 'queued' }
  return { outcome: 'mailed', ...(await notifyAttestersOfInvoice(service, companyId, invoiceId, logger)) }
}

/**
 * The supplier_invoice.registered handler. A failure throws to the event bus,
 * which logs it as an error with the event type and this consumer's name and
 * keeps it from the registration and the other consumers (lib/events/bus.ts):
 * an invoice that was neither queued nor mailed is never asked again, so it
 * must reach error tracking.
 */
export async function handleSupplierInvoiceRegistered(payload: EventPayload<'supplier_invoice.registered'>): Promise<void> {
  const { supplierInvoice, companyId } = payload
  await askAttestersOfInvoice(createServiceClient(), companyId, supplierInvoice.id)
}

/** Subscribes the handler on its own; lib/init subscribes it through EVENT_CONSUMERS. */
export function registerAttestNotificationHandler(): () => void {
  return eventBus.on('supplier_invoice.registered', handleSupplierInvoiceRegistered)
}
