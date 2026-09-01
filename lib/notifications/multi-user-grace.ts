import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPABILITY } from '@/lib/entitlements/keys'
import {
  computeMultiUserState,
  MULTI_USER_GRACE_DAYS,
  type MultiUserGrantRow,
} from '@/lib/entitlements/multi-user-state'
import { isMultiUserEnforced } from '@/lib/entitlements/multi-user'
import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import { getBranding } from '@/lib/branding/service'
import { formatDate } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const logger = createLogger('notifications/multi-user-grace')

/**
 * Multi-user grace reminders: mails company OWNERS when the 20-day grace
 * window opens (their extra members will pause) and again on its last day.
 *
 * Windowing keeps the daily cron idempotent without a sent-log: with the
 * newest multi_user expiry E and grace end G = E + 20d,
 *   "start" mail : E in (now - 24h, now]   (the lapse happened since the
 *                                           previous daily run)
 *   "final" mail : G in (now, now + 24h]   (the freeze lands before the
 *                                           next daily run)
 * The two windows can only both hit for a sub-24h grace, which the 20-day
 * constant rules out. Companies with no non-owner members are skipped:
 * single-person companies must never hear about the seat gate.
 *
 * The launch cohort's mail is sent by hand (founder decision 2026-09-01);
 * this cron owns every FUTURE lapse: trial ends, subscription cancellations.
 */

const DAY_MS = 86_400_000

export interface MultiUserGraceSummary {
  companiesInGrace: number
  startMails: number
  finalMails: number
  errors: number
  skipped?: 'not_enforced' | 'email_not_configured'
}

interface GrantRow {
  company_id: string | null
  team_id: string | null
  expires_at: string | null
  metadata: Record<string, unknown> | null
}

interface TrackedGrant extends MultiUserGrantRow {
  metadata: Record<string, unknown> | null
}

export async function runMultiUserGraceReminders(
  supabase: SupabaseClient,
  now: Date,
): Promise<MultiUserGraceSummary> {
  const summary: MultiUserGraceSummary = {
    companiesInGrace: 0,
    startMails: 0,
    finalMails: 0,
    errors: 0,
  }
  if (!isMultiUserEnforced()) {
    summary.skipped = 'not_enforced'
    return summary
  }
  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    summary.skipped = 'email_not_configured'
    return summary
  }

  // All multi_user grants in one read: the key has at most a handful of rows
  // per company, and the whole-table scan on one capability_key is what the
  // idx_capability_grants_key index exists for.
  const { data: grantRows, error: grantsError } = await supabase
    .from('capability_grants')
    .select('company_id, team_id, expires_at, metadata')
    .eq('capability_key', CAPABILITY.multi_user)
  if (grantsError) {
    throw new Error(`multi-user grace: grants read failed: ${grantsError.message}`)
  }
  const grants = (grantRows ?? []) as GrantRow[]

  const companyGrants = new Map<string, TrackedGrant[]>()
  const teamGrants = new Map<string, TrackedGrant[]>()
  for (const g of grants) {
    if (g.company_id) {
      const list = companyGrants.get(g.company_id) ?? []
      list.push({ expires_at: g.expires_at, metadata: g.metadata })
      companyGrants.set(g.company_id, list)
    }
    if (g.team_id) {
      const list = teamGrants.get(g.team_id) ?? []
      list.push({ expires_at: g.expires_at, metadata: g.metadata })
      teamGrants.set(g.team_id, list)
    }
  }

  if (companyGrants.size === 0 && teamGrants.size === 0) return summary

  // Candidate companies: company-scoped grant holders PLUS every company of
  // a team that holds grants (a byrå whose team agreement lapses has client
  // companies with zero company-scoped rows, and their owners must be mailed
  // like anyone else's).
  const companies = new Map<string, { id: string; name: string; team_id: string | null }>()
  const companyIds = [...companyGrants.keys()]
  for (let i = 0; i < companyIds.length; i += 200) {
    const chunk = companyIds.slice(i, i + 200)
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, team_id, archived_at')
      .in('id', chunk)
      .is('archived_at', null)
    if (error) throw new Error(`multi-user grace: companies read failed: ${error.message}`)
    for (const c of (data ?? []) as { id: string; name: string; team_id: string | null }[]) {
      companies.set(c.id, c)
    }
  }
  const teamIds = [...teamGrants.keys()]
  for (let i = 0; i < teamIds.length; i += 200) {
    const chunk = teamIds.slice(i, i + 200)
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, team_id, archived_at')
      .in('team_id', chunk)
      .is('archived_at', null)
    if (error) throw new Error(`multi-user grace: team companies read failed: ${error.message}`)
    for (const c of (data ?? []) as { id: string; name: string; team_id: string | null }[]) {
      companies.set(c.id, c)
    }
  }

  const nowMs = now.getTime()
  for (const company of companies.values()) {
    const rows = [
      ...(companyGrants.get(company.id) ?? []),
      ...(company.team_id ? (teamGrants.get(company.team_id) ?? []) : []),
    ]
    const access = computeMultiUserState(rows, nowMs)
    if (access.state !== 'grace' || !access.graceEndsAt) continue
    summary.companiesInGrace += 1

    const graceEndMs = new Date(access.graceEndsAt).getTime()
    const lapseMs = graceEndMs - MULTI_USER_GRACE_DAYS * DAY_MS
    // The launch cohort's start mail is sent by hand (founder decision
    // 2026-09-01): the grandfather backfill row expires at deploy time, so
    // without this check the first cron run after deploy would re-mail the
    // whole cohort. The day-19 final reminder still goes out.
    const anchorIsGrandfather = rows.some(
      (r) =>
        r.expires_at !== null &&
        new Date(r.expires_at).getTime() === lapseMs &&
        (r.metadata as { reason?: string } | null)?.reason === 'multi_user_grandfather',
    )
    const isStart = !anchorIsGrandfather && lapseMs > nowMs - DAY_MS && lapseMs <= nowMs
    const isFinal = graceEndMs > nowMs && graceEndMs <= nowMs + DAY_MS
    if (!isStart && !isFinal) continue

    try {
      const sent = await sendGraceMail(supabase, {
        companyId: company.id,
        companyName: company.name,
        kind: isFinal ? 'final' : 'start',
        graceEndsAt: access.graceEndsAt,
      })
      if (sent === 0) continue
      if (isFinal) summary.finalMails += sent
      else summary.startMails += sent
    } catch (err) {
      summary.errors += 1
      logger.error('multi-user grace mail failed', err as Error, { companyId: company.id })
    }
  }

  return summary
}

async function sendGraceMail(
  supabase: SupabaseClient,
  args: { companyId: string; companyName: string; kind: 'start' | 'final'; graceEndsAt: string },
): Promise<number> {
  // Sandbox/demo companies have no billing: never mail them.
  const { data: settings } = await supabase
    .from('company_settings')
    .select('is_sandbox, company_name')
    .eq('company_id', args.companyId)
    .maybeSingle()
  if ((settings as { is_sandbox?: boolean } | null)?.is_sandbox === true) return 0
  const companyName =
    (settings as { company_name?: string | null } | null)?.company_name || args.companyName

  const { data: members } = await supabase
    .from('company_members')
    .select('user_id, role')
    .eq('company_id', args.companyId)
  const memberRows = (members ?? []) as { user_id: string; role: string }[]
  const affected = memberRows.filter((m) => m.role !== 'owner')
  // Single-person companies never hear about the seat gate.
  if (affected.length === 0) return 0
  const owners = memberRows.filter((m) => m.role === 'owner')
  if (owners.length === 0) return 0

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email')
    .in('id', memberRows.map((m) => m.user_id))
  const emailById = new Map(
    ((profiles ?? []) as { id: string; email: string | null }[]).map((p) => [p.id, p.email]),
  )
  const ownerEmails = owners.map((o) => emailById.get(o.user_id)).filter((e): e is string => !!e)
  const affectedEmails = affected
    .map((a) => emailById.get(a.user_id))
    .filter((e): e is string => !!e)
  if (ownerEmails.length === 0) return 0

  const sender = await getSenderForCompany(args.companyId)
  const appUrl = sender.brand ? getBaseUrlForBrand(sender.brand) : getBranding().appUrl
  const billingUrl = `${appUrl}/settings/billing`
  const freezeDate = formatDate(args.graceEndsAt)
  const affectedList = affectedEmails.join(', ')

  const subject =
    args.kind === 'final'
      ? `Imorgon pausas fler användare i ${companyName}`
      : `Fler användare i ${companyName} kräver betald plan`
  const intro =
    args.kind === 'final'
      ? `Imorgon (${freezeDate}) pausas följande konton från ${companyName}: ${affectedList}.`
      : `Från och med den ${freezeDate} ingår flera användare endast i den betalda planen. Då pausas följande konton från ${companyName}: ${affectedList}.`
  const outro =
    'Ingen data försvinner och inga användare tas bort. Uppgraderar ni, nu eller senare, ' +
    'får alla tillbaka sin åtkomst direkt.'
  const body = `Hej!\n\n${intro}\n\n${outro}\n\nUppgradera här: ${billingUrl}\n`
  const html =
    `<p>Hej!</p><p>${intro}</p><p>${outro}</p>` +
    `<p><a href="${billingUrl}">Uppgradera till betald plan</a></p>`

  const emailService = getEmailService()
  let sent = 0
  for (const to of ownerEmails) {
    const result = await emailService.sendEmail({
      to,
      subject,
      html,
      text: body,
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
    })
    if (result.success) sent += 1
    else logger.warn('multi-user grace mail send failed', { companyId: args.companyId })
  }
  return sent
}
