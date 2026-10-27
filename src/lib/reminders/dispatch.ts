import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getBaseUrlForCompany, getSenderForCompany } from '@/lib/email/brand-sender'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import { loadArchivedInvoicePdf } from '@/lib/invoices/archived-invoice-pdf'
import { remindersActiveFor, REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { resolveInvoiceEmailRecipients, resolveInvoiceReplyTo } from '@/lib/invoices/email-recipients'
import { createLogger, type Logger } from '@/lib/logger'
import { checkReminderBank } from './bank'
import { ReminderChannelError, type ReminderChannel, type ReminderMessage } from './channel'
import { loadReminderContext } from './facts'
import { decideReminder, reminderSchedule, sendsAutomatically, type ReminderLevel, type ReminderSkipReason } from './policy'
import { FINAL_REMINDER_PAY_WITHIN_DAYS, renderReminderEmail } from './templates'

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
 *      Automatic mode sends only for an invoice issued and delivered from
 *      Accounted; any other waits for a person's approval.
 *   3. The bank check: a possible payment in the bank stops it; a bank not
 *      synced in 24 hours stops it unless a person approved it with that
 *      shown (never in automatic mode).
 *   4. The row is reserved before the send: one row per invoice and level,
 *      so a second attempt finds it and sends nothing. The one exception is
 *      a row whose send the provider refused (nothing went out): it is
 *      taken back, compare-and-set, for this attempt.
 *   5. Sent or failed is recorded on the row, with whether a failure's
 *      outcome is unknown. Unknown stops the ladder for a person to look; a
 *      send interrupted before anything was recorded leaves the row
 *      reserved, and the daily run sweeps it to failed, unknown
 *      (gather.ts). Each attempt carries its own idempotency key, so the
 *      provider never sends one attempt twice.
 *
 * Nothing sends while REMINDERS_SENDING_ENABLED is false.
 */

export type ReminderMode = 'approved' | 'automatic' | 'manual'

export interface DispatchReminderInput {
  companyId: string
  invoiceId: string
  /**
   * The level the batch or the person approved; a different decision today
   * skips as changed. A person's pick from the invoice may leave it out: the
   * level the policy decides is sent.
   */
  level?: ReminderLevel
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
  /** The invoice PDF to attach; defaults to the archived copy the customer was first emailed (none: no attachment). */
  invoicePdf?: (companyId: string, invoiceId: string) => Promise<{ filename: string; content: Buffer } | null>
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

/**
 * Automatic mode only, so never the answer to a person's pick: the invoice
 * was not issued and delivered from Accounted, and a person approves it
 * (the daily run stages it, gather.ts).
 */
export type AutomaticSkipReason = 'needs_person'

export type DispatchReminderOutcome =
  | {
      status: 'sent'
      reminderId: string
      level: ReminderLevel
      providerMessageId: string | null
      /** The send went out but the row could not be marked sent: it stays reserved, which stops the ladder. */
      recorded: boolean
    }
  | { status: 'skipped'; reason: DispatchSkipReason | AutomaticSkipReason }
  | { status: 'failed'; reminderId: string; code: string; outcomeUnknown: boolean }

const defaultLog = createLogger('reminders/dispatch')

function skipped(reason: DispatchSkipReason | AutomaticSkipReason): DispatchReminderOutcome {
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
  if (input.level !== undefined && decision.level !== input.level) return skipped('changed')
  if (input.mode === 'automatic' && !sendsAutomatically(ctx.facts)) return skipped('needs_person')
  const level = decision.level
  const { customer } = ctx
  const recipient = ctx.facts.recipient
  // The policy has refused a missing address already; this narrows the types.
  if (!customer || !recipient) return skipped('no_email')

  // 3. The bank.
  const bank = await checkReminderBank(db, ctx, { companyId: input.companyId, today, now })
  if (bank.outcome === 'candidates') return skipped('possible_payment')
  if (bank.outcome !== 'pass' && !(input.mode !== 'automatic' && input.bankAttested === true)) return skipped('bank_not_fresh')

  // 4. What the mail needs from the database, read before the row is
  // reserved: a read that fails here leaves no row behind to stop the ladder.
  const baseUrl = await (deps.baseUrl ?? getBaseUrlForCompany)(input.companyId)
  const sender = await (deps.sender ?? ((companyId, name) => defaultSender(db, companyId, name)))(input.companyId, ctx.company.company_name ?? null)
  const replyTo = resolveInvoiceReplyTo(ctx.company)

  // 5. Reserve the row: the one place a second send of this level is refused.
  const recipients = resolveInvoiceEmailRecipients({
    to: recipient,
    configuredCc: ctx.company.invoice_email_cc_addresses,
    configuredBcc: ctx.company.invoice_email_bcc_addresses,
    customerCc: customer.invoice_email_cc_addresses,
    customerBcc: customer.invoice_email_bcc_addresses,
  })
  const reminder = await reserveAttempt(db, input, level, {
    user_id: input.actorUserId,
    email_to: recipients.to.join(', '),
    mode: input.mode,
    status: 'reserved',
    reserved_at: now.toISOString(),
  })
  if (!reminder) return skipped('already_sent')

  // 6. Render, send, record.
  let mail
  try {
    mail = renderReminderEmail({
      level,
      invoice: ctx.invoice,
      customer,
      company: ctx.company,
      amount: ctx.amount,
      remaining: ctx.facts.remaining,
      payBy: addDaysIso(today, FINAL_REMINDER_PAY_WITHIN_DAYS),
      overdueDays: daysBetweenIso(ctx.invoice.due_date, today),
      actionUrl: `${baseUrl}/invoice-action/${reminder.action_token}`,
      replyTo,
    })
  } catch (error) {
    // Nothing went out: a known outcome, so the next attempt takes the row back.
    const failure = new ReminderChannelError('RENDER_ERROR', { outcomeUnknown: false, cause: error })
    await recordFailure(db, input.companyId, reminder.id, now, failure, null, log)
    return { status: 'failed', reminderId: reminder.id, code: failure.code, outcomeUnknown: false }
  }
  // The invoice itself rides along when the archive has it. Without it the
  // reminder still carries the amount and the payment rows, so it goes anyway.
  let pdf: { filename: string; content: Buffer } | null = null
  try {
    pdf = await (deps.invoicePdf ?? ((companyId, invoiceId) => archivedPdf(db, companyId, invoiceId, input.actorUserId, log)))(
      input.companyId,
      input.invoiceId,
    )
  } catch (error) {
    log.warn('reminder goes without the invoice PDF', { reminderId: reminder.id, reason: error instanceof Error ? error.message : String(error) })
  }

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
      ...(pdf ? { attachments: [{ filename: pdf.filename, content: pdf.content, contentType: 'application/pdf' }] } : {}),
      // This attempt's own key: a row taken back after a refusal is a new
      // attempt, and the provider would answer a reused key with the old
      // refusal (or a conflict, the body having changed).
      idempotencyKey: `reminder-${reminder.id}-${now.getTime()}`,
    })
  } catch (error) {
    const failure =
      error instanceof ReminderChannelError ? error : new ReminderChannelError('SEND_ERROR', { outcomeUnknown: true, cause: error })
    await recordFailure(db, input.companyId, reminder.id, now, failure, mail.subject, log)
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
  if (sentError) {
    log.error('reminder sent but not recorded as sent', sentError, { reminderId: reminder.id })
    // The mail went out: keep at least the provider's id on the row, so the
    // answer link in it opens (answer.ts) and a bounce for it can be recorded.
    const { error: idError } = await db
      .from('invoice_reminders')
      .update({ provider: receipt.provider, provider_message_id: receipt.providerMessageId })
      .eq('id', reminder.id)
      .eq('company_id', input.companyId)
    if (idError) log.error('sent reminder has no provider id on record', idError, { reminderId: reminder.id })
  }
  return { status: 'sent', reminderId: reminder.id, level, providerMessageId: receipt.providerMessageId, recorded: !sentError }
}

/**
 * Record a failed attempt on its row. Unrecorded, the row stays reserved: the
 * ladder stops until the daily run sweeps it to failed with an unknown outcome.
 */
async function recordFailure(
  db: SupabaseClient,
  companyId: string,
  reminderId: string,
  now: Date,
  failure: ReminderChannelError,
  subject: string | null,
  log: Logger,
): Promise<void> {
  const { error: failError } = await db
    .from('invoice_reminders')
    .update({
      status: 'failed',
      failed_at: now.toISOString(),
      error_code: failure.code,
      subject,
      outcome_unknown: failure.outcomeUnknown,
    })
    .eq('id', reminderId)
    .eq('company_id', companyId)
  if (failError) log.error('reminder failure not recorded', failError, { reminderId })
  log.warn('reminder send failed', { reminderId, code: failure.code, outcomeUnknown: failure.outcomeUnknown })
}

/**
 * The row this attempt sends under, or null when the level is on record and
 * may not go again. A new level is inserted; the unique (invoice, level)
 * index refuses a second. A row whose send the provider refused (failed,
 * outcome known) is taken back instead, by an update that matches it once,
 * so two attempts never both send.
 */
async function reserveAttempt(
  db: SupabaseClient,
  input: DispatchReminderInput,
  level: ReminderLevel,
  attempt: { user_id: string; email_to: string; mode: ReminderMode; status: 'reserved'; reserved_at: string },
): Promise<{ id: string; action_token: string } | null> {
  const { data: reserved, error: reserveError } = await db
    .from('invoice_reminders')
    .insert({
      user_id: attempt.user_id,
      email_to: attempt.email_to,
      mode: attempt.mode,
      status: attempt.status,
      reserved_at: attempt.reserved_at,
      invoice_id: input.invoiceId,
      company_id: input.companyId,
      reminder_level: level,
    })
    .select('id, action_token')
    .single()
  if (!reserveError) return reserved as { id: string; action_token: string }
  if (reserveError.code !== '23505') throw new Error(`reminder reservation failed: ${reserveError.message}`)

  const { data: retaken, error: retakeError } = await db
    .from('invoice_reminders')
    .update({
      user_id: attempt.user_id,
      email_to: attempt.email_to,
      mode: attempt.mode,
      status: attempt.status,
      reserved_at: attempt.reserved_at,
      failed_at: null,
      error_code: null,
      outcome_unknown: null,
    })
    .eq('company_id', input.companyId)
    .eq('invoice_id', input.invoiceId)
    .eq('reminder_level', level)
    .eq('status', 'failed')
    .eq('outcome_unknown', false)
    .select('id, action_token')
    .maybeSingle()
  if (retakeError) throw new Error(`reminder reservation failed: ${retakeError.message}`)
  return (retaken as { id: string; action_token: string } | null) ?? null
}

/** Read as the service role for the person the reminder is sent for: the session reader refuses a caller without auth.uid(). */
async function archivedPdf(
  db: SupabaseClient,
  companyId: string,
  invoiceId: string,
  actorUserId: string,
  log: Logger,
): Promise<{ filename: string; content: Buffer } | null> {
  const archive = await loadArchivedInvoicePdf(db, companyId, invoiceId, log, { serviceActorUserId: actorUserId })
  return archive.ok ? { filename: archive.value.filename, content: Buffer.from(archive.value.bytes) } : null
}

async function defaultSender(
  db: SupabaseClient,
  companyId: string,
  companyName: string | null,
): Promise<Pick<ReminderMessage, 'from' | 'fromAddress'>> {
  const [own, brand] = await Promise.all([resolveInvoiceSender(db, companyId, companyName), getSenderForCompany(companyId)])
  return { from: own, fromAddress: brand.fromAddress ?? undefined }
}
