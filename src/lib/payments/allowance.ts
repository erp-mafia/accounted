/**
 * The hard monthly cap on bank payments (product decision 2026-10-14): a
 * signing that would take the month past the company's allowance is refused
 * before anything is sent to the provider, and a person can ask for more.
 * Once payments above the allowance are offered at the unit price (usage.ts,
 * bankPaymentsBilled), the refusal at the allowance says so and points to
 * Begär fler; once an operator opens the charge for the company
 * (lib/usage/consent.ts) the cap is the safety ceiling and the allowance is
 * what the month includes.
 *
 * The cap is read where the counter is (usage.ts): the orders that reached
 * the provider this Stockholm month against the company's allowance
 * (company_bank_payment_allowances, else BANK_PAYMENTS_INCLUDED_PER_MONTH).
 * Payment files never come here: they do not go through the provider.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome } from '@/lib/operations/types'
import type { Logger } from '@/lib/logger'
import { getEmailService } from '@/lib/email/service'
import { getSupportRecipientEmail } from '@/lib/support'
import { getBranding } from '@/lib/branding/service'
import { formatOre, USAGE_PRICES } from '@/lib/usage/kinds'
import { currentUsagePeriod, getBankPaymentsUsage, readBankPaymentsMonth } from './usage'

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

/** What a refused signing carries, for the person's screen and for agents. */
export interface BankPaymentsAllowanceDetails {
  /** YYYY-MM in Stockholm time. */
  period: string
  /** Payments that reached the provider this month, outside this signing. */
  used: number
  /** What the month includes. */
  included: number
  /** The hard stop: included, or the safety ceiling once extra payments are accepted. */
  cap: number
  /** Whether payments above `included` can be asked for at unit_price_ore. */
  extra_offered: boolean
  /** Whether the charge is open for the company: payments above `included` are then billed instead of refused. */
  billed: boolean
  /** Whether more would be offered with a subscription of its own: the company has none (lib/usage/paying.ts). */
  subscription_required: boolean
  /** Whether more will be offered once the company's subscription, started during the trial, has its first charge. */
  subscription_starting: boolean
  /** Öre exkl. moms per payment above `included`. */
  unit_price_ore: number
  /** What this month still takes, up to the cap. */
  remaining: number
  /** The payments of this signing. */
  requested: number
}

const SV_MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december']

/** "oktober" for 2026-10: the month as the refusal names it. */
export function swedishMonthName(period: string): string {
  const month = Number(period.slice(5, 7))
  return SV_MONTHS[month - 1] ?? period
}

/** The Swedish refusal, composed with the numbers (thrown_message_sv on the code). */
export function allowanceExceededMessage(details: BankPaymentsAllowanceDetails): string {
  const month = swedishMonthName(details.period)
  const noun = details.remaining === 1 ? 'betalning' : 'betalningar'
  if (details.subscription_starting) {
    const head = `Ni har använt ${details.used} av ${details.included} betalningar som ingår i ${month}. Fler kostar ${formatOre(details.unit_price_ore)} st och går att begära efter abonnemangets första dragning.`
    return details.remaining <= 0 ? head : `${head} Välj högst ${details.remaining} ${noun}.`
  }
  if (details.subscription_required) {
    const head = `Ni har använt ${details.used} av ${details.included} betalningar som ingår i ${month}. Fler kostar ${formatOre(details.unit_price_ore)} st och kräver ett abonnemang.`
    return details.remaining <= 0
      ? `${head} Starta det under Inställningar, Abonnemang.`
      : `${head} Välj högst ${details.remaining} ${noun}, eller starta ett abonnemang under Inställningar, Abonnemang.`
  }
  if (details.extra_offered && !details.billed) {
    const head = `Ni har använt ${details.used} av ${details.included} betalningar som ingår i ${month}. Fler kostar ${formatOre(details.unit_price_ore)} st.`
    const where = 'under Inställningar, Kopplingar, Betalningar via banken, så öppnar vi.'
    return details.remaining <= 0 ? `${head} Begär fler ${where}` : `${head} Välj högst ${details.remaining} ${noun}, eller begär fler ${where}`
  }
  const head = details.billed
    ? `Ni har skickat ${details.used} betalningar i ${month}, och taket är ${details.cap} i månaden.`
    : `Ni har använt ${details.used} av ${details.included} betalningar som ingår i ${month}.`
  if (details.remaining <= 0) return `${head} Begär fler under Inställningar, Kopplingar, Betalningar via banken.`
  return `${head} Välj högst ${details.remaining} ${noun}, eller begär fler under Inställningar, Kopplingar, Betalningar via banken.`
}

/**
 * The refusal for a signing that would take the month past the allowance,
 * or null when it fits. `orderIds` are the orders the signing sends: an
 * order of it that already reached the provider this month (a restart, whose
 * payment waits at the bank unsigned) is counted once, as part of this
 * signing, never twice. A signing at the cap exactly passes.
 *
 * Read before the claim and outside it: two signings started at the same
 * moment can each see room and together pass the cap by a few payments.
 * Accepted for a beta cap; the counter then shows extra_payments.
 */
export async function bankPaymentsAllowanceRefusal(
  supabase: SupabaseClient,
  companyId: string,
  orderIds: readonly string[],
  period: string = currentUsagePeriod(),
): Promise<Refusal | null> {
  const month = await readBankPaymentsMonth(supabase, companyId, period)
  const mine = new Set(orderIds)
  const used = month.sent.filter((row) => !mine.has(row.id)).length
  const requested = mine.size
  const cap = month.cap_payments
  if (used + requested <= cap) return null
  const details: BankPaymentsAllowanceDetails = {
    period: month.period,
    used,
    included: month.included_payments,
    cap,
    extra_offered: month.extra_offered,
    billed: month.billed_above_included,
    subscription_required: month.subscription_required,
    subscription_starting: month.subscription_starting,
    unit_price_ore: USAGE_PRICES.bank_payment.unitPriceOre ?? 0,
    remaining: Math.max(0, cap - used),
    requested,
  }
  return { ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED', details: { ...details }, messageSv: allowanceExceededMessage(details) }
}

/** One open request per company per day: the operators answer by hand. */
export const ALLOWANCE_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000

export interface AllowanceRequestInput {
  /** Payments a month the company says it needs; null when not given. */
  monthlyPaymentsWanted: number | null
  message: string | null
}

export interface AllowanceRequestCreated {
  request_id: string
  created_at: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Begär fler betalningar: stores the request and mails support with what an
 * operator needs to decide (company, org number, who asked, this month's
 * usage, the number wanted and the message). Written as the service role:
 * a browser session cannot write the table. Refused while the company has
 * an open request younger than a day. When the mail cannot be sent the row
 * is removed again, so the person can try later instead of waiting on a
 * request nobody saw.
 */
export async function requestMoreBankPayments(
  service: SupabaseClient,
  actor: { companyId: string; userId: string; email: string | null; log: Logger },
  input: AllowanceRequestInput,
  now: Date = new Date(),
): Promise<OperationOutcome<AllowanceRequestCreated>> {
  const since = new Date(now.getTime() - ALLOWANCE_REQUEST_WINDOW_MS).toISOString()
  const { data: open, error: openError } = await service
    .from('bank_payment_allowance_requests')
    .select('id, created_at')
    .eq('company_id', actor.companyId)
    .is('handled_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
  if (openError) throw openError
  const pending = ((open ?? []) as Array<{ id: string; created_at: string }>)[0]
  if (pending) return { ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_OPEN', details: { requested_at: pending.created_at } }

  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    actor.log.warn('email service not configured: bank payment allowance request not sent')
    return { ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT' }
  }

  const usage = await getBankPaymentsUsage(service, actor.companyId)
  const { data: company } = await service.from('companies').select('name, org_number').eq('id', actor.companyId).maybeSingle()
  const companyRow = (company ?? null) as { name: string | null; org_number: string | null } | null

  const { data: inserted, error: insertError } = await service
    .from('bank_payment_allowance_requests')
    .insert({
      company_id: actor.companyId,
      requested_by: actor.userId,
      monthly_payments_wanted: input.monthlyPaymentsWanted,
      message: input.message,
    })
    .select('id, created_at')
    .single()
  if (insertError) throw insertError
  const row = inserted as { id: string; created_at: string }

  const lines: Array<[string, string]> = [
    ['Företag', companyRow?.name ?? '(namn saknas)'],
    ['Organisationsnummer', companyRow?.org_number ?? '(saknas)'],
    ['Företags-id', actor.companyId],
    ['Begärt av', actor.email ?? actor.userId],
    [`Använt ${usage.period}`, `${usage.payments_sent} av ${usage.included_payments}`],
    ['Önskat per månad', input.monthlyPaymentsWanted === null ? '(inte angivet)' : String(input.monthlyPaymentsWanted)],
    ['Förfrågan', row.id],
  ]
  const message = input.message ?? ''
  // While bank payments are billed per unit, the answer is to open the charge, not to raise the cap.
  const footer = usage.extra_offered
    ? 'Öppna styckavgiften för företaget och sätt handled_at på förfrågan: ' +
      `insert into usage_consents (company_id, kind, unit_price_ore, included, accepted_by) values ('${actor.companyId}', 'bank_payment', ${usage.unit_price_ore}, ${usage.included_payments}, '<din user id>');`
    : 'Höj taket i company_bank_payment_allowances och sätt handled_at på förfrågan.'
  const text = `${lines.map(([label, value]) => `${label}: ${value}`).join('\n')}${message ? `\n\nMeddelande:\n${message}` : ''}\n\n${footer}`
  const html = `${lines.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')}${
    message ? `<hr /><p><strong>Meddelande:</strong></p><p>${escapeHtml(message).replace(/\n/g, '<br />')}</p>` : ''
  }<hr /><p>${escapeHtml(footer)}</p>`

  const result = await emailService.sendEmail({
    to: getSupportRecipientEmail(),
    subject: `[${getBranding().appName.toLowerCase()} bankbetalningar] Fler betalningar: ${companyRow?.name ?? actor.companyId}`,
    html,
    text,
    replyTo: actor.email ?? undefined,
  })
  if (!result.success) {
    actor.log.error('bank payment allowance request mail failed', new Error(result.error ?? 'unknown'), { requestId: row.id })
    const { error: removeError } = await service.from('bank_payment_allowance_requests').delete().eq('id', row.id).eq('company_id', actor.companyId)
    if (removeError) actor.log.error('unsent bank payment allowance request could not be removed', removeError, { requestId: row.id })
    return { ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT' }
  }
  actor.log.info('bank payment allowance request sent', { requestId: row.id, messageId: result.messageId })
  return { ok: true, data: { request_id: row.id, created_at: row.created_at }, created: true }
}
