/**
 * Tell the attesters when an invoice that needs their attest is registered.
 *
 * Two surfaces. The worklist row ("Attestera {leverantör} {belopp}" on Hem)
 * is derived from the policy and the trail on every read
 * (listSupplierInvoiceAttestsDue), so it needs nothing written here. The
 * mail is sent from here, once per registration, to each attester who may
 * attest the invoice and has not switched the mail off
 * (notification_settings.attest_request_email_enabled, default on), with
 * Godkänn / Neka links that work without a login (attest-links.ts).
 *
 * Bound to supplier_invoice.registered (registerAttestNotificationHandler,
 * lib/init.ts). Never throws at the emitter: a failed mail leaves the
 * worklist row, which asks for the same attest.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'
import { sendAttestRequestMail } from '@/lib/email/send-attest-request'
import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createLogger, type Logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import { attestLinkUrl, markAttestLinkMailed, mintAttestLink } from './attest-links'
import { eligibleAttesters, invoiceNeedsAttest } from './attest-policy'
import { loadActiveAttestMembers, loadAttestPeople, loadAttestPolicy } from './attest-service'

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

  const members = await loadActiveAttestMembers(service, companyId)
  const recipients = eligibleAttesters(policy, facts, members)
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

async function handleSupplierInvoiceRegistered(payload: EventPayload<'supplier_invoice.registered'>): Promise<void> {
  const { supplierInvoice, companyId } = payload
  try {
    await notifyAttestersOfInvoice(createServiceClient(), companyId, supplierInvoice.id)
  } catch (error) {
    log.warn('attest request mail not sent', {
      companyId,
      invoiceId: supplierInvoice.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Wired in lib/init.ts beside the other core handlers. */
export function registerAttestNotificationHandler(): () => void {
  return eventBus.on('supplier_invoice.registered', handleSupplierInvoiceRegistered)
}
