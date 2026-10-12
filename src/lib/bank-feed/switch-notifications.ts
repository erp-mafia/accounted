/**
 * The switch campaign's mail: who gets it, when, and the log that keeps any
 * mail from going twice (bank_switch_notifications, service role only).
 *
 *   - The daily cron (runBankSwitchReminderCron) sends every pending company
 *     the announcement once, then one reminder per threshold (14, 7, 3 and 1
 *     days before the deadline; a run that missed a day sends the reminder
 *     of the threshold it is now inside, never two in one day). After the
 *     deadline the 1-day reminder, if it never went, says the feed stopped.
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
import { getEmailService } from '@/lib/email/service'
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

export type BankSwitchMailKind = 'announcement' | 'reminder_14' | 'reminder_7' | 'reminder_3' | 'reminder_1' | 'byra_nudge'

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
      kind: kind === 'announcement' || kind === 'byra_nudge' ? ('announcement' as const) : ('reminder' as const),
      bankNames: state.pending.map((p) => p.bank_name).filter(Boolean),
      deadline: state.deadline,
      daysLeft: state.days_left,
      switchUrl: switchLinkFor(state, getBaseUrlForBrand(sender.brand)),
      companyName: ((settings.data as { company_name?: string | null } | null)?.company_name ?? '').trim(),
      byraManaged,
    }
    const result = await emailService.sendEmail({
      to: recipients,
      subject: generateBankSwitchEmailSubject(data),
      html: generateBankSwitchEmailHtml(data),
      text: generateBankSwitchEmailText(data),
      ...(sender.fromName ? { fromName: sender.fromName } : {}),
      ...(sender.fromAddress ? { fromAddress: sender.fromAddress } : {}),
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    })
    if (!result.success) {
      log?.warn('bank switch mail not sent', { companyId, kind, reason: result.error })
      return { outcome: 'failed', recipients: recipients.length, reason: result.error }
    }
    const { error } = await service.from('bank_switch_notifications').insert({ company_id: companyId, kind, recipient_count: recipients.length })
    if (error) log?.error('bank switch mail sent but not logged', { companyId, kind, message: error.message })
    return { outcome: 'sent', recipients: recipients.length }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log?.error('bank switch mail failed', { companyId, kind, message: reason })
    return { outcome: 'failed', recipients: 0, reason }
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

export interface BankSwitchCronResult {
  /** The campaign is on (OPENPAYMENTS_SWITCH_DEADLINE set). */
  campaign: boolean
  /** Mail may go out (OPENPAYMENTS_SWITCH_MAILS=true). */
  mails: boolean
  deadline: string | null
  days_left: number | null
  companies: { pending: number; uncovered: number; done: number }
  sent: { announcement: number; reminder: number }
  skipped: { no_recipient: number; not_configured: number; already: number }
  failed: number
  /** The founders' counter, when the RPC answered. */
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
  options: { now?: Date; env?: BankFeedEnv } = {},
): Promise<BankSwitchCronResult> {
  const now = options.now ?? new Date()
  const campaign = switchCampaign(options.env)
  const result: BankSwitchCronResult = {
    campaign: campaign.on,
    mails: campaign.on && switchMailsEnabled(options.env),
    deadline: campaign.deadline,
    days_left: null,
    companies: { pending: 0, uncovered: 0, done: 0 },
    sent: { announcement: 0, reminder: 0 },
    skipped: { no_recipient: 0, not_configured: 0, already: 0 },
    failed: 0,
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
  for (const [companyId, state] of pending) {
    const sent = sentByCompany.get(companyId) ?? new Set<string>()
    const kind: BankSwitchMailKind | null = sent.has('announcement') ? reminderKindDue(state.days_left, sent) : 'announcement'
    if (!kind) {
      result.skipped.already++
      continue
    }
    const outcome = await sendBankSwitchMail(service, { companyId, kind, state, log })
    if (outcome.outcome === 'sent') {
      if (kind === 'announcement') result.sent.announcement++
      else result.sent.reminder++
    } else if (outcome.outcome === 'no_recipient') result.skipped.no_recipient++
    else if (outcome.outcome === 'not_configured') result.skipped.not_configured++
    else result.failed++
  }
  return result
}
