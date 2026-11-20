/**
 * The mail when the bank did not carry out a payment: rejected, or failed
 * (failed-payments.ts says why it exists). Run by the status cron after each
 * status sync, over the payments that ended so within NOTIFY_WINDOW_HOURS:
 * a payment the sync itself found rejected is mailed about in the same run,
 * one found during a signing within the next run (15 minutes).
 *
 * Who: the people behind the payment, the one who created it, approved it,
 * sent it for signing (payment_orders.user_id, approved_by, submitted_by) and
 * signed it with BankID (the signing's signer_user_id), less the person who
 * was on screen when the bank answered (the actor of the move to rejected or
 * failed, payment_order_events): they saw it in the dialog. Only active
 * members of the company with an email address, and not someone who has
 * switched mail off (notification_settings.email_enabled = false). There is
 * no switch for this mail alone: money that did not move is not a newsletter.
 *
 * Once per person and payment: a notification_log claim (type payment_failed,
 * unique per user and reference, migration 20261031224300) is inserted as
 * pending before the mail goes out, and only the run whose insert won sends.
 * After the provider took the mail the claim says sent; when the provider
 * refused it (nothing went out) the claim is removed so the next run tries
 * again; when nobody can tell whether it went out, the claim stays, because
 * a second mail is worse than none: the Att göra row still says it. Before
 * the migration has run the insert is refused (23514) and nothing is sent;
 * the window picks the payment up once it has.
 *
 * One mail per person and company per run, listing every payment of theirs
 * that ended: a basket the bank refused as a whole is one mail.
 *
 * Never throws for one company or person: the status sync's result stands.
 */

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTranslator } from 'next-intl'
import { getBaseUrlForBrand, getSenderForCompany } from '@/lib/email/brand-sender'
import {
  PAYMENT_FAILED_TEMPLATE,
  generatePaymentFailedEmailHtml,
  generatePaymentFailedEmailSubject,
  generatePaymentFailedEmailText,
  type PaymentFailedEmailLine,
} from '@/lib/email/payment-failed-templates'
import { getEmailService, type EmailService } from '@/lib/email/service'
import type { Logger } from '@/lib/logger'
import { resolveMemberEmails } from '@/lib/notifications/member-email'
import { failedPaymentReasonText, type BankPaymentsTranslator } from './failed-payment-reason'
import { FAILED_PAYMENT_ORDER_STATUSES } from './failed-payments'
import { PAYMENTS_PAGE_PATH } from './page-path'
import type { PaymentOrderRow } from './types'

/** The notification_log type the migration admits (20261031224300). */
const PAYMENT_FAILED_NOTIFICATION_TYPE = 'payment_failed'

/**
 * How far back an ended payment is mailed about: long enough for every
 * retry of a refused send and for the hour before the migration lands,
 * short enough that a first run never mails about old history.
 */
export const NOTIFY_WINDOW_HOURS = 24

/**
 * Ended payments one run reads, oldest answer first. Their ids travel in the
 * GET query string of the reads after it (the worklist keeps an .in() under
 * 150 ids). Far above the volume: 15 payments ended rejected or failed in
 * all of October 2026.
 */
const ORDER_LIMIT = 100

type EndedOrder = Pick<
  PaymentOrderRow,
  | 'id'
  | 'company_id'
  | 'user_id'
  | 'approved_by'
  | 'submitted_by'
  | 'batch_id'
  | 'status'
  | 'supplier_invoice_id'
  | 'amount'
  | 'currency'
  | 'requested_execution_date'
  | 'payee_name'
  | 'provider_error_code'
  | 'provider_status_at'
>

export interface FailedPaymentMailResult {
  /** Payments that ended rejected or failed within the window. */
  considered: number
  /** Mails the provider took. */
  mailed: number
  /** Payments mailed about, counted once per person told. */
  notified: number
  /** Claims the database refused for another reason than a duplicate (before the migration: all of them). */
  claimRefused: number
  errors: number
}

/** The bank_payments texts in Swedish (the mail is), for failedPaymentReasonText. */
async function swedishBankPaymentsTexts(): Promise<BankPaymentsTranslator> {
  const mod = await import('@/messages/sv.json')
  const messages = ((mod as { default?: unknown }).default ?? mod) as Record<string, unknown>
  return createTranslator({ locale: 'sv', messages, namespace: 'bank_payments' }) as unknown as BankPaymentsTranslator
}

export async function notifyFailedPayments(writer: SupabaseClient, log: Logger, now: Date = new Date()): Promise<FailedPaymentMailResult> {
  const result: FailedPaymentMailResult = { considered: 0, mailed: 0, notified: 0, claimRefused: 0, errors: 0 }
  const since = new Date(now.getTime() - NOTIFY_WINDOW_HOURS * 3_600_000).toISOString()
  const { data, error } = await writer
    .from('payment_orders')
    .select(
      'id, company_id, user_id, approved_by, submitted_by, batch_id, status, supplier_invoice_id, amount, currency, requested_execution_date, payee_name, provider_error_code, provider_status_at',
    )
    .in('status', [...FAILED_PAYMENT_ORDER_STATUSES])
    .gte('provider_status_at', since)
    .order('provider_status_at', { ascending: true })
    .limit(ORDER_LIMIT)
  if (error) throw error
  const orders = (data ?? []) as unknown as EndedOrder[]
  result.considered = orders.length
  if (orders.length === 0) return result

  const email = await getEmailService()
  // Nothing is claimed without a way to send: a later run with one sends.
  if (!email.isConfigured()) {
    log.warn('email service not configured: payment failed mails skipped', { template: PAYMENT_FAILED_TEMPLATE, payments: orders.length })
    return result
  }

  const ids = orders.map((o) => o.id)
  const batchIds = [...new Set(orders.map((o) => o.batch_id).filter((id): id is string => Boolean(id)))]
  const [moves, batches, claims] = await Promise.all([
    writer.from('payment_order_events').select('payment_order_id, actor_user_id').in('payment_order_id', ids).in('to_status', [...FAILED_PAYMENT_ORDER_STATUSES]),
    batchIds.length > 0 ? writer.from('payment_order_batches').select('id, signer_user_id').in('id', batchIds) : Promise.resolve({ data: [], error: null }),
    writer.from('notification_log').select('user_id, reference_id').eq('notification_type', PAYMENT_FAILED_NOTIFICATION_TYPE).in('reference_id', ids),
  ])
  if (moves.error) throw moves.error
  if (batches.error) throw batches.error
  if (claims.error) throw claims.error

  // Who was on screen when the payment ended: they saw it there.
  const watcher = new Map<string, string>()
  for (const row of (moves.data ?? []) as Array<{ payment_order_id: string; actor_user_id: string | null }>) {
    if (row.actor_user_id && !watcher.has(row.payment_order_id)) watcher.set(row.payment_order_id, row.actor_user_id)
  }
  const signerOf = new Map(((batches.data ?? []) as Array<{ id: string; signer_user_id: string | null }>).map((b) => [b.id, b.signer_user_id]))
  // Already told (the claim exists): the fast path; the claim insert is the guarantee.
  const told = new Set(((claims.data ?? []) as Array<{ user_id: string; reference_id: string }>).map((c) => `${c.user_id}:${c.reference_id}`))

  const byCompany = new Map<string, Map<string, EndedOrder[]>>()
  for (const order of orders) {
    const people = new Set([order.user_id, order.approved_by, order.submitted_by, order.batch_id ? signerOf.get(order.batch_id) : null])
    people.delete(watcher.get(order.id) ?? null)
    for (const userId of people) {
      if (!userId || told.has(`${userId}:${order.id}`)) continue
      let company = byCompany.get(order.company_id)
      if (!company) byCompany.set(order.company_id, (company = new Map()))
      let list = company.get(userId)
      if (!list) company.set(userId, (list = []))
      list.push(order)
    }
  }
  if (byCompany.size === 0) return result

  const texts = await swedishBankPaymentsTexts()
  for (const [companyId, byUser] of byCompany) {
    try {
      await mailCompany(writer, log, email, texts, companyId, byUser, result)
    } catch (err) {
      result.errors += 1
      log.warn('payment failed mails not sent for one company', { companyId, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

/** The people of one company still to tell, and what about: one mail each. */
async function mailCompany(
  writer: SupabaseClient,
  log: Logger,
  email: EmailService,
  texts: BankPaymentsTranslator,
  companyId: string,
  byUser: Map<string, EndedOrder[]>,
  result: FailedPaymentMailResult,
): Promise<void> {
  const userIds = [...byUser.keys()]
  const invoiceIds = [...new Set([...byUser.values()].flat().map((o) => o.supplier_invoice_id).filter((id): id is string => Boolean(id)))]
  const [addressOf, settings, company, invoices] = await Promise.all([
    // Company mail goes to active members only, at their profile address.
    resolveMemberEmails(writer, companyId, userIds),
    writer.from('notification_settings').select('user_id, email_enabled').in('user_id', userIds),
    writer.from('companies').select('name').eq('id', companyId).maybeSingle(),
    invoiceIds.length > 0
      ? writer.from('supplier_invoices').select('id, supplier_invoice_number, arrival_number').eq('company_id', companyId).in('id', invoiceIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (settings.error) throw settings.error
  if (invoices.error) throw invoices.error
  if (company.error) throw company.error

  const mailOff = new Set(
    ((settings.data ?? []) as Array<{ user_id: string; email_enabled: boolean | null }>).filter((s) => s.email_enabled === false).map((s) => s.user_id),
  )
  const invoiceLabel = new Map<string, string>()
  for (const invoice of (invoices.data ?? []) as Array<{ id: string; supplier_invoice_number: string | null; arrival_number: number | null }>) {
    const name = invoice.supplier_invoice_number?.trim() || (invoice.arrival_number != null ? `#${invoice.arrival_number}` : null)
    if (name) invoiceLabel.set(invoice.id, `faktura ${name}`)
  }
  const companyName = (company.data as { name: string | null } | null)?.name?.trim() || 'Företaget'
  const sender = await getSenderForCompany(companyId)
  const baseUrl = getBaseUrlForBrand(sender.brand)

  for (const [userId, ended] of byUser) {
    const address = addressOf.get(userId)
    if (!address || mailOff.has(userId)) continue

    const won: EndedOrder[] = []
    for (const order of ended) {
      const claim = await claimNotice(writer, companyId, userId, order.id)
      if (claim === 'won') won.push(order)
      else if (claim === 'refused') result.claimRefused += 1
    }
    if (won.length === 0) continue

    won.sort((a, b) => a.requested_execution_date.localeCompare(b.requested_execution_date) || a.payee_name.localeCompare(b.payee_name, 'sv'))
    const payments: PaymentFailedEmailLine[] = won.map((order) => ({
      payee: order.payee_name,
      invoiceLabel: order.supplier_invoice_id ? (invoiceLabel.get(order.supplier_invoice_id) ?? null) : null,
      amount: Number(order.amount),
      currency: order.currency,
      executionDate: order.requested_execution_date,
      reason: failedPaymentReasonText(texts, order.status === 'rejected' ? 'rejected' : 'failed', order.provider_error_code),
    }))
    const data = { companyName, payments, paymentsUrl: `${baseUrl}${PAYMENTS_PAGE_PATH}`, appName: sender.brand?.appName }
    const orderIds = won.map((o) => o.id)
    let sent: Awaited<ReturnType<EmailService['sendEmail']>>
    try {
      sent = await email.sendEmail({
        to: address,
        subject: generatePaymentFailedEmailSubject(data),
        html: generatePaymentFailedEmailHtml(data),
        text: generatePaymentFailedEmailText(data),
        fromName: sender.fromName ?? undefined,
        fromAddress: sender.fromAddress ?? undefined,
        replyTo: sender.replyTo ?? undefined,
        idempotencyKey: `${PAYMENT_FAILED_TEMPLATE}:${createHash('sha256').update(`${userId}:${orderIds.join(',')}`).digest('hex')}`,
      })
    } catch (err) {
      sent = { success: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (sent.success) {
      result.mailed += 1
      result.notified += won.length
      await settleClaims(writer, userId, orderIds, 'sent', log)
      // The address is the recipient's: not logged.
      log.info('payment failed mail sent', { template: PAYMENT_FAILED_TEMPLATE, companyId, payments: won.length, messageId: sent.messageId })
    } else if (sent.outcomeUnknown === false) {
      // Refused by the provider: nothing went out, so the next run tries again.
      await settleClaims(writer, userId, orderIds, 'release', log)
      log.warn('payment failed mail refused by the provider', { template: PAYMENT_FAILED_TEMPLATE, companyId, error: sent.error })
    } else {
      // It may have gone out: the claim stays (never twice), marked failed for whoever looks.
      await settleClaims(writer, userId, orderIds, 'failed', log)
      log.error('payment failed mail outcome unknown', new Error(sent.error ?? 'unknown'), { template: PAYMENT_FAILED_TEMPLATE, companyId })
    }
  }
}

/**
 * Claim telling one person about one payment. 'won': this run sends;
 * 'taken': another run did (unique violation); 'refused': the database said
 * no for another reason (the type not admitted yet), so nothing is sent.
 */
async function claimNotice(writer: SupabaseClient, companyId: string, userId: string, orderId: string): Promise<'won' | 'taken' | 'refused'> {
  const { error } = await writer.from('notification_log').insert({
    user_id: userId,
    company_id: companyId,
    notification_type: PAYMENT_FAILED_NOTIFICATION_TYPE,
    reference_id: orderId,
    days_before: 0,
    delivery_status: 'pending',
  })
  if (!error) return 'won'
  return error.code === '23505' ? 'taken' : 'refused'
}

/** Mark the claims of one mail sent or failed, or remove them so a later run sends. Never throws. */
async function settleClaims(writer: SupabaseClient, userId: string, orderIds: string[], outcome: 'sent' | 'failed' | 'release', log: Logger): Promise<void> {
  try {
    const claims = writer.from('notification_log')
    const scoped =
      outcome === 'release' ? claims.delete() : claims.update({ delivery_status: outcome, sent_at: new Date().toISOString() })
    const { error } = await scoped.eq('user_id', userId).eq('notification_type', PAYMENT_FAILED_NOTIFICATION_TYPE).in('reference_id', orderIds)
    if (error) throw error
  } catch (err) {
    // A claim left pending only stops a retry of this one mail.
    log.warn('payment failed mail claims not settled', { outcome, payments: orderIds.length, message: err instanceof Error ? err.message : String(err) })
  }
}
