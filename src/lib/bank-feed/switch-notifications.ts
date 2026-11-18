/**
 * The switch campaign's mail: who gets it, when, and the log that keeps any
 * mail from going twice (bank_switch_notifications, service role only). The
 * log row is written before the mail is handed to the provider and removed
 * only when the provider refused it (sendBankSwitchMail).
 *
 *   - The daily cron (runBankSwitchReminderCron) sends every pending company
 *     the announcement once, then one reminder per threshold (14, 7, 3 and 1
 *     days before the deadline; a run that missed a day sends the reminder
 *     of the threshold it is now inside, never two in one day). On the
 *     first run after the deadline day, the day the Enable Banking feed
 *     stops (switch-campaign.ts enableBankingSunset), one final mail,
 *     `sunset`, says that from today the old connection fetches nothing:
 *     once per company, whatever reminders went before, and nothing after
 *     it. The deadline day itself keeps its "i dag är sista dagen" reminder,
 *     since the feed still runs that day.
 *   - A byrå nudges one client (sendByraNudge): the announcement mail to the
 *     client's own owners and admins, at most once per 7 days per client.
 *   - Nothing is sent unless BOTH the campaign is on and
 *     OPENPAYMENTS_SWITCH_MAILS=true. The cron still answers the counts, so
 *     the campaign can be watched before the mails are switched on.
 *
 * Recipients are the company's owners and admins who are still members
 * (lib/notifications/member-email.ts), in the company's brand (sender and
 * link base from lib/email/brand-sender.ts). Failures are logged and counted,
 * never thrown past one company: a bad address must not stop the run.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateBankSwitchEmailHtml, generateBankSwitchEmailSubject, generateBankSwitchEmailText } from '@/lib/email/bank-switch-templates'
import { getBaseUrlForBrand, getSenderForCompany } from '@/lib/email/brand-sender'
import { getEmailService, type SendEmailOptions, type SendEmailResult } from '@/lib/email/service'
import type { Logger } from '@/lib/logger'
import { resolveCompanyAdminEmails } from '@/lib/notifications/member-email'
import { chunk } from '@/lib/utils'
import type { BankFeedEnv } from './door'
import {
  bankSwitchProgressTotals,
  switchCampaign,
  switchLinkFor,
  switchMailsEnabled,
  SWITCH_REMINDER_DAYS,
  switchStatesForCompanies,
  type BankSwitchProgressTotals,
  type CompanySwitchState,
} from './switch-campaign'

export type BankSwitchMailKind = 'announcement' | 'reminder_14' | 'reminder_7' | 'reminder_3' | 'reminder_1' | 'sunset' | 'byra_nudge'

/** A byrå may nudge the same client again after this many days. */
export const BYRA_NUDGE_COOLDOWN_DAYS = 7

export type BankSwitchSendOutcome = 'sent' | 'no_recipient' | 'not_configured' | 'failed'

export interface BankSwitchSendResult {
  outcome: BankSwitchSendOutcome
  recipients: number
  reason?: string
}

/**
 * Which reminder a pending company is due, given the days left and the mails
 * it already got: the smallest threshold the day is inside whose reminder
 * never went. Null when none is due (more than 14 days left, or every
 * reminder up to the current threshold has gone).
 */
export function reminderKindDue(daysLeft: number, sent: ReadonlySet<string>): BankSwitchMailKind | null {
  const due = SWITCH_REMINDER_DAYS.filter((threshold) => daysLeft <= threshold)
  if (due.length === 0) return null
  const kind = `reminder_${Math.min(...due)}` as BankSwitchMailKind
  return sent.has(kind) ? null : kind
}

/**
 * Which campaign mail a pending company is due today, given the days left
 * and the mails it already got. Once the deadline day has gone by (the old
 * feed has stopped: enableBankingSunset), the one final `sunset` mail and
 * nothing else, once; until then, the announcement first, then the reminder
 * of the threshold the day is inside (reminderKindDue), the deadline day
 * included. Null when nothing is due.
 */
export function campaignMailDue(daysLeft: number, sent: ReadonlySet<string>): BankSwitchMailKind | null {
  if (daysLeft < 0) return sent.has('sunset') ? null : 'sunset'
  return sent.has('announcement') ? reminderKindDue(daysLeft, sent) : 'announcement'
}

/** Whether the company belongs to a byrå team: the mail then says the client's own BankID signs the switch. */
export async function isByraManaged(service: SupabaseClient, companyId: string): Promise<boolean> {
  const { data: company } = await service.from('companies').select('team_id').eq('id', companyId).maybeSingle()
  const teamId = (company as { team_id?: string | null } | null)?.team_id
  if (!teamId) return false
  const { data: team } = await service.from('teams').select('kind').eq('id', teamId).maybeSingle()
  return (team as { kind?: string } | null)?.kind === 'byra'
}

/**
 * Send one campaign mail to a company's owners and admins and log it. The
 * caller has already decided that the mail is due; this never checks the
 * flags, so the cron and the byrå route keep that decision in one place each.
 *
 * The log row is what the next run reads to know the mail went, so it is
 * written first: written after the send, as it was, a run killed or started
 * again between the two sent the same mail to the same people the next time.
 * After the send:
 *   - sent: the row stays;
 *   - refused (SendEmailResult.outcomeUnknown false: nothing went out): the
 *     row comes off and the next run tries again;
 *   - no clear answer, or a throw while the request was out: asked once more
 *     at once with the same idempotency key, which the provider answers with
 *     the first request's result, so the second ask never sends a second
 *     mail. Still unclear, the mail may or may not have gone. The
 *     announcement and the reminders at 14, 7 and 3 days keep the row (never
 *     twice; a later mail of the campaign follows). The reminder of the last
 *     day and the sunset mail lose it and go again on the next run: nothing
 *     follows them, and a mail twice costs less than a company never told its
 *     bank feed stops. A byrå's nudge loses it too, or the byrå could not ask
 *     again for a week after a send that may have failed.
 *
 * Two runs at the very same moment both read the log before either writes
 * it; the table has no unique key on (company_id, kind) to stop the second
 * row. The idempotency key covers that case at the provider: the same
 * company, kind and day is one mail there.
 */
export async function sendBankSwitchMail(
  service: SupabaseClient,
  input: { companyId: string; kind: BankSwitchMailKind; state: CompanySwitchState; log?: Logger },
): Promise<BankSwitchSendResult> {
  const { companyId, kind, state, log } = input
  try {
    const emailService = await getEmailService()
    if (!emailService.isConfigured()) return { outcome: 'not_configured', recipients: 0 }
    const recipients = await resolveCompanyAdminEmails(service, companyId)
    if (recipients.length === 0) return { outcome: 'no_recipient', recipients: 0 }

    const [sender, byraManaged, settings] = await Promise.all([
      getSenderForCompany(companyId),
      isByraManaged(service, companyId),
      service.from('company_settings').select('company_name').eq('company_id', companyId).maybeSingle(),
    ])
    const data = {
      kind: kind === 'sunset' ? ('sunset' as const) : kind === 'announcement' || kind === 'byra_nudge' ? ('announcement' as const) : ('reminder' as const),
      bankNames: state.pending.map((p) => p.bank_name).filter(Boolean),
      deadline: state.deadline,
      daysLeft: state.days_left,
      switchUrl: switchLinkFor(state, getBaseUrlForBrand(sender.brand)),
      companyName: ((settings.data as { company_name?: string | null } | null)?.company_name ?? '').trim(),
      byraManaged,
    }
    const { data: logged, error: logError } = await service
      .from('bank_switch_notifications')
      .insert({ company_id: companyId, kind, recipient_count: recipients.length })
      .select('id')
      .single()
    if (logError) {
      // Without the row nothing would stop the next run from sending again.
      log?.error('bank switch mail not sent: its log row could not be written', { companyId, kind, message: logError.message })
      return { outcome: 'failed', recipients: recipients.length, reason: logError.message }
    }

    const mail = {
      to: recipients,
      subject: generateBankSwitchEmailSubject(data),
      html: generateBankSwitchEmailHtml(data),
      text: generateBankSwitchEmailText(data),
      ...(sender.fromName ? { fromName: sender.fromName } : {}),
      ...(sender.fromAddress ? { fromAddress: sender.fromAddress } : {}),
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      idempotencyKey: `bank-switch:${companyId}:${kind}:${state.days_left}`,
    }
    let answer: SendAnswer = { outcome: 'unclear', reason: undefined }
    for (let attempt = 1; attempt <= SEND_ATTEMPTS && answer.outcome === 'unclear'; attempt++) {
      answer = await sendOnce(emailService, mail)
    }
    if (answer.outcome === 'sent') return { outcome: 'sent', recipients: recipients.length }

    if (answer.outcome === 'refused' || UNLOGGED_WHEN_UNCLEAR.has(kind)) {
      // Nothing went out (refused), or the mail is one a later run must send
      // again rather than miss: the row comes off.
      const { error: removeError } = await service
        .from('bank_switch_notifications')
        .delete()
        .eq('id', (logged as { id: string }).id)
      if (removeError) {
        log?.error('bank switch mail not sent but stays logged as sent; it will not be tried again', { companyId, kind, message: removeError.message })
      }
    }
    if (answer.outcome === 'refused') {
      log?.warn('bank switch mail not sent', { companyId, kind, reason: answer.reason })
    } else if (UNLOGGED_WHEN_UNCLEAR.has(kind)) {
      log?.error('bank switch mail got no clear answer twice; the next run sends it again, so it may arrive twice', { companyId, kind, reason: answer.reason })
    } else {
      log?.error('bank switch mail got no clear answer twice; it stays logged as sent so it never goes twice, and a later mail of the campaign follows', { companyId, kind, reason: answer.reason })
    }
    return { outcome: 'failed', recipients: recipients.length, reason: answer.reason }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log?.error('bank switch mail failed', { companyId, kind, message: reason })
    return { outcome: 'failed', recipients: 0, reason }
  }
}

/** Asks per mail: the second, on an unclear answer, carries the same idempotency key. */
const SEND_ATTEMPTS = 2

/**
 * Mails whose log row comes off when the provider's answer stays unclear
 * (see sendBankSwitchMail): nothing follows the last day's reminder or the
 * sunset mail, and a nudge kept logged would block the byrå for a week.
 */
const UNLOGGED_WHEN_UNCLEAR: ReadonlySet<BankSwitchMailKind> = new Set(['reminder_1', 'sunset', 'byra_nudge'])

type SendAnswer = { outcome: 'sent' | 'refused' | 'unclear'; reason: string | undefined }

/** One ask of the provider, read as sent, refused (nothing went out) or unclear (it may have). */
async function sendOnce(
  emailService: { sendEmail: (options: SendEmailOptions) => Promise<SendEmailResult> },
  mail: SendEmailOptions,
): Promise<SendAnswer> {
  try {
    const result = await emailService.sendEmail(mail)
    if (result.success) return { outcome: 'sent', reason: undefined }
    return { outcome: result.outcomeUnknown === false ? 'refused' : 'unclear', reason: result.error }
  } catch (error) {
    // Thrown while the request was out: the provider may have taken it.
    return { outcome: 'unclear', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** When the byrå last nudged this client, or null. */
export async function lastByraNudgeAt(service: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await service
    .from('bank_switch_notifications')
    .select('sent_at')
    .eq('company_id', companyId)
    .eq('kind', 'byra_nudge')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as { sent_at?: string } | null)?.sent_at ?? null
}

/** Whether a byrå may nudge the client now: not within BYRA_NUDGE_COOLDOWN_DAYS of the last nudge. */
export function byraNudgeAllowed(lastSentAt: string | null, now: Date = new Date()): boolean {
  if (!lastSentAt) return true
  const last = new Date(lastSentAt).getTime()
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= BYRA_NUDGE_COOLDOWN_DAYS * 86_400_000
}

export type ByraNudgeOutcome = BankSwitchSendOutcome | 'recently_sent' | 'not_pending'

/**
 * A byrå's "Be kunden koppla" for one client: the announcement to the client's
 * owners and admins, logged as byra_nudge, refused inside the cooldown. The
 * caller has checked the byrå's right to act on the client and that the
 * mails are switched on.
 */
export async function sendByraNudge(
  service: SupabaseClient,
  input: { companyId: string; state: CompanySwitchState | null; now?: Date; log?: Logger },
): Promise<{ outcome: ByraNudgeOutcome; recipients: number; last_sent_at: string | null }> {
  const { companyId, state, now = new Date(), log } = input
  if (!state || state.state !== 'pending') return { outcome: 'not_pending', recipients: 0, last_sent_at: null }
  const lastSentAt = await lastByraNudgeAt(service, companyId)
  if (!byraNudgeAllowed(lastSentAt, now)) return { outcome: 'recently_sent', recipients: 0, last_sent_at: lastSentAt }
  const result = await sendBankSwitchMail(service, { companyId, kind: 'byra_nudge', state, log })
  return { ...result, last_sent_at: lastSentAt }
}

/**
 * No company's mail is started later than this into the run, counted from
 * the start of the route (maxDuration 300 s): a minute is left for the one
 * started last, its second ask included. A kill between writing the log row
 * and handing the mail over would lose that mail without a trace.
 */
export const SWITCH_REMINDER_RUN_BUDGET_MS = 240_000

export interface BankSwitchCronResult {
  /** The campaign is on (OPENPAYMENTS_SWITCH_DEADLINE set). */
  campaign: boolean
  /** Mail may go out (OPENPAYMENTS_SWITCH_MAILS=true). */
  mails: boolean
  deadline: string | null
  days_left: number | null
  companies: { pending: number; uncovered: number; done: number }
  sent: { announcement: number; reminder: number; sunset: number }
  skipped: { no_recipient: number; not_configured: number; already: number }
  failed: number
  /** Pending companies the time budget did not reach; tomorrow's run sends what is then due. */
  not_reached: number
  /** The operators' counter, when the RPC answered. */
  totals: BankSwitchProgressTotals | null
}

/** Max company ids per PostgREST .in() filter. */
const IN_CLAUSE_CHUNK = 150

async function sentKindsByCompany(service: SupabaseClient, companyIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  for (const ids of chunk(companyIds, IN_CLAUSE_CHUNK)) {
    const { data, error } = await service.from('bank_switch_notifications').select('company_id, kind').in('company_id', ids)
    if (error) throw error
    for (const row of (data ?? []) as Array<{ company_id: string; kind: string }>) {
      const set = result.get(row.company_id)
      if (set) set.add(row.kind)
      else result.set(row.company_id, new Set([row.kind]))
    }
  }
  return result
}

/**
 * The daily run (vercel.json, 06:30 UTC): where every admitted company
 * stands, then the announcement or the due reminder for each pending one,
 * when the mails are switched on. Answers a summary an operator can read.
 */
export async function runBankSwitchReminderCron(
  service: SupabaseClient,
  log: Logger,
  options: {
    now?: Date
    env?: BankFeedEnv
    /** When the route started (ctx.startedAt): the time budget counts from here. */
    startedAt?: number
  } = {},
): Promise<BankSwitchCronResult> {
  const deadlineMs = (options.startedAt ?? Date.now()) + SWITCH_REMINDER_RUN_BUDGET_MS
  const now = options.now ?? new Date()
  const campaign = switchCampaign(options.env)
  const result: BankSwitchCronResult = {
    campaign: campaign.on,
    mails: campaign.on && switchMailsEnabled(options.env),
    deadline: campaign.deadline,
    days_left: null,
    companies: { pending: 0, uncovered: 0, done: 0 },
    sent: { announcement: 0, reminder: 0, sunset: 0 },
    skipped: { no_recipient: 0, not_configured: 0, already: 0 },
    failed: 0,
    not_reached: 0,
    totals: null,
  }
  if (!campaign.on) return result

  const states = await switchStatesForCompanies(service, null, { now, env: options.env })
  const pending: Array<[string, CompanySwitchState]> = []
  for (const [companyId, state] of states) {
    result.companies[state.state]++
    if (state.state === 'pending') {
      pending.push([companyId, state])
      result.days_left = state.days_left
    }
  }
  try {
    result.totals = await bankSwitchProgressTotals(service)
  } catch (error) {
    log.warn('bank switch progress totals unavailable', { message: error instanceof Error ? error.message : String(error) })
  }
  if (!result.mails || pending.length === 0) return result

  const sentByCompany = await sentKindsByCompany(service, pending.map(([id]) => id))
  for (const [index, [companyId, state]] of pending.entries()) {
    if (Date.now() >= deadlineMs) {
      result.not_reached = pending.length - index
      // Their mail waits a day: tomorrow's run sends what is due then.
      log.error('bank switch reminders ran out of time before every company was reached', {
        notReached: result.not_reached,
        reached: index,
      })
      break
    }
    const sent = sentByCompany.get(companyId) ?? new Set<string>()
    const kind = campaignMailDue(state.days_left, sent)
    if (!kind) {
      result.skipped.already++
      continue
    }
    const outcome = await sendBankSwitchMail(service, { companyId, kind, state, log })
    if (outcome.outcome === 'sent') {
      if (kind === 'announcement') result.sent.announcement++
      else if (kind === 'sunset') result.sent.sunset++
      else result.sent.reminder++
    } else if (outcome.outcome === 'no_recipient') result.skipped.no_recipient++
    else if (outcome.outcome === 'not_configured') result.skipped.not_configured++
    else result.failed++
  }
  return result
}
