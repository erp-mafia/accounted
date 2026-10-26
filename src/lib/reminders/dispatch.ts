import type { SupabaseClient } from '@supabase/supabase-js'
import { runBankCheck } from '@/lib/collections/bank-check'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getBaseUrlForCompany, getSenderForCompany } from '@/lib/email/brand-sender'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import { remindersActiveFor, REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { resolveInvoiceEmailRecipients, resolveInvoiceReplyTo } from '@/lib/invoices/email-recipients'
import { createLogger, type Logger } from '@/lib/logger'
import { ReminderChannelError, type ReminderChannel, type ReminderMessage } from './channel'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, type ReminderLevel, type ReminderSkipReason } from './policy'
import { renderReminderEmail } from './templates'

/**
 * Send one reminder, the only path that does (accounted#104). Every caller,
 * the daily batch's commit, the automatic batch and a pick on the invoice
 * page, comes through here, and every send re-decides from fresh facts:
 *
 *   1. The product switch, then the company: never an archived, reset or
 *      sandbox company, and the ladder only where the company turned
 *      reminders on (a manual pick needs only the product switch).
 *   2. The policy (policy.ts) must still say this level today: a batch
 *      approved yesterday sends nothing when the invoice was paid since.
 *   3. The bank check: a possible payment in the bank stops it; a bank not
 *      synced in 24 hours stops it unless a person approved it with that
 *      shown (never in automatic mode).
 *   4. The row is reserved before the send: one row per invoice and level,
 *      so a second attempt finds it and sends nothing.
 *   5. Sent or failed is recorded on the row. A failure, or a send whose
 *      outcome is unknown, stops the ladder for a person to look.
 *
 * Nothing sends while REMINDERS_SENDING_ENABLED is false.
 */

export type ReminderMode = 'approved' | 'automatic' | 'manual'

export interface DispatchReminderInput {
  companyId: string
  invoiceId: string
  /** The level the batch or the person approved; a different decision today skips as changed. */
  level: ReminderLevel
  /** Recorded on the row: who approved, picked, or turned automatic sending on. */
  actorUserId: string
  mode: ReminderMode
  /** A person saw that the bank was not synced in 24 hours and approved anyway (never automatic). */
  bankAttested?: boolean
}

export interface DispatchReminderDeps {
  /** Service role: reads and writes, always filtered by company. */
  db: SupabaseClient
  channel: ReminderChannel
  now?: () => Date
  /** REMINDERS_SENDING_ENABLED; a parameter only so tests can pin both states. */
  sendingEnabled?: boolean
  /** Base URL for the customer's answer page; defaults to the company's brand URL. */
  baseUrl?: (companyId: string) => Promise<string>
  /** From identity; defaults to the company's own verified sender and the brand's address. */
  sender?: (companyId: string, companyName: string | null) => Promise<Pick<ReminderMessage, 'from' | 'fromAddress'>>
  log?: Logger
}

/** Why a reminder was not sent: a policy reason, or one this path adds. */
export type DispatchSkipReason =
  | ReminderSkipReason
  | 'sending_off'
  | 'company_inactive'
  | 'reminders_off'
  | 'changed'
  | 'possible_payment'
  | 'bank_not_fresh'
  | 'already_sent'

export type DispatchReminderOutcome =
  | {
      status: 'sent'
      reminderId: string
      providerMessageId: string | null
      /** The send went out but the row could not be marked sent: it stays reserved, which stops the ladder. */
      recorded: boolean
    }
  | { status: 'skipped'; reason: DispatchSkipReason }
  | { status: 'failed'; reminderId: string; code: string; outcomeUnknown: boolean }

const defaultLog = createLogger('reminders/dispatch')

function skipped(reason: DispatchSkipReason): DispatchReminderOutcome {
  return { status: 'skipped', reason }
}

export async function dispatchReminder(deps: DispatchReminderDeps, input: DispatchReminderInput): Promise<DispatchReminderOutcome> {
  const log = deps.log ?? defaultLog
  const sendingEnabled = deps.sendingEnabled ?? REMINDERS_SENDING_ENABLED
  if (!sendingEnabled) return skipped('sending_off')

  const now = deps.now ? deps.now() : new Date()
  const today = todayIsoStockholm(now)
  const { db } = deps

  // 1. May this company remind anyone.
  const ctx = await loadReminderContext(db, input.companyId, input.invoiceId)
  if (ctx.companyInactive) return skipped('company_inactive')
  if (input.mode !== 'manual' && !remindersActiveFor(ctx.company.send_invoice_reminders, sendingEnabled)) {
    return skipped('reminders_off')
  }

  // 2. Does the policy still say this level today.
  const decision = decideReminder({
    today,
    schedule: reminderSchedule(ctx.company),
    enabledAt: ctx.company.reminders_enabled_at ?? null,
    invoice: ctx.facts,
    history: ctx.history,
    picked: input.mode === 'manual',
  })
  if (decision.kind === 'skip') return skipped(decision.reason)
  if (decision.level !== input.level) return skipped('changed')
  const { customer } = ctx
  const recipient = ctx.facts.recipient
  // The policy has refused a missing address already; this narrows the types.
  if (!customer || !recipient) return skipped('no_email')

  // 3. The bank.
  const bank = await runBankCheck(db, {
    companyId: input.companyId,
    invoice: {
      id: ctx.invoice.id,
      invoice_number: ctx.invoice.invoice_number,
      invoice_date: ctx.invoice.invoice_date,
      currency: ctx.invoice.currency,
      payment_cash_account_id: ctx.invoice.payment_cash_account_id ?? null,
    },
    customerName: customer.name ?? null,
    remaining: ctx.facts.remaining,
    dismissedTransactionIds: [],
    today,
    now,
  })
  if (bank.outcome === 'candidates') return skipped('possible_payment')
  if (bank.outcome !== 'pass' && !(input.mode !== 'automatic' && input.bankAttested === true)) return skipped('bank_not_fresh')

  // 4. Reserve the row: the one place a second send of this level is refused.
  const recipients = resolveInvoiceEmailRecipients({
    to: recipient,
    configuredCc: ctx.company.invoice_email_cc_addresses,
    configuredBcc: ctx.company.invoice_email_bcc_addresses,
    customerCc: customer.invoice_email_cc_addresses,
    customerBcc: customer.invoice_email_bcc_addresses,
  })
  const { data: reserved, error: reserveError } = await db
    .from('invoice_reminders')
    .insert({
      invoice_id: input.invoiceId,
      company_id: input.companyId,
      user_id: input.actorUserId,
      reminder_level: input.level,
      email_to: recipients.to.join(', '),
      mode: input.mode,
      status: 'reserved',
    })
    .select('id, action_token')
    .single()
  if (reserveError) {
    if (reserveError.code === '23505') return skipped('already_sent')
    throw new Error(`reminder reservation failed: ${reserveError.message}`)
  }
  const reminder = reserved as { id: string; action_token: string }

  // 5. Render, send, record.
  const baseUrl = await (deps.baseUrl ?? getBaseUrlForCompany)(input.companyId)
  const replyTo = resolveInvoiceReplyTo(ctx.company)
  const mail = renderReminderEmail({
    level: input.level,
    invoice: ctx.invoice,
    customer,
    company: ctx.company,
    remaining: ctx.facts.remaining,
    overdueDays: daysBetweenIso(ctx.invoice.due_date, today),
    actionUrl: `${baseUrl}/invoice-action/${reminder.action_token}`,
    replyTo,
  })
  const sender = await (deps.sender ?? ((companyId, name) => defaultSender(db, companyId, name)))(input.companyId, ctx.company.company_name ?? null)

  let receipt
  try {
    receipt = await deps.channel.send({
      companyId: input.companyId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      replyTo,
      fromName: ctx.company.company_name ?? '',
      ...sender,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    })
  } catch (error) {
    const failure =
      error instanceof ReminderChannelError ? error : new ReminderChannelError('SEND_ERROR', { outcomeUnknown: true, cause: error })
    const { error: failError } = await db
      .from('invoice_reminders')
      .update({ status: 'failed', failed_at: now.toISOString(), error_code: failure.code, subject: mail.subject })
      .eq('id', reminder.id)
      .eq('company_id', input.companyId)
    // Unrecorded, the row stays reserved: the ladder stops just the same.
    if (failError) log.error('reminder failure not recorded', failError, { reminderId: reminder.id })
    log.warn('reminder send failed', { reminderId: reminder.id, code: failure.code, outcomeUnknown: failure.outcomeUnknown })
    return { status: 'failed', reminderId: reminder.id, code: failure.code, outcomeUnknown: failure.outcomeUnknown }
  }

  const { error: sentError } = await db
    .from('invoice_reminders')
    .update({
      status: 'sent',
      sent_at: now.toISOString(),
      subject: mail.subject,
      provider: receipt.provider,
      provider_message_id: receipt.providerMessageId,
    })
    .eq('id', reminder.id)
    .eq('company_id', input.companyId)
  if (sentError) log.error('reminder sent but not recorded as sent', sentError, { reminderId: reminder.id })
  return { status: 'sent', reminderId: reminder.id, providerMessageId: receipt.providerMessageId, recorded: !sentError }
}

async function defaultSender(
  db: SupabaseClient,
  companyId: string,
  companyName: string | null,
): Promise<Pick<ReminderMessage, 'from' | 'fromAddress'>> {
  const [own, brand] = await Promise.all([resolveInvoiceSender(db, companyId, companyName), getSenderForCompany(companyId)])
  return { from: own, fromAddress: brand.fromAddress ?? undefined }
}
