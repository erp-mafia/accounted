/**
 * The one-time announcement that a company can now appoint the app as its
 * ombud at Skatteverket: who gets it, and the daily run that sends it.
 *
 * A company is in the audience when all of these hold:
 *   - it used the Skatteverket integration in the last USAGE_WINDOW_DAYS days:
 *     a skatteverket_api_audit_log row for it, whoever made the call (a
 *     member's BankID session, a cron on that session, the deep link). Every
 *     company with a recent skatteverket_tokens row also has audit rows, and
 *     the audit log also keeps companies whose BankID token row has since gone;
 *   - it is live and entitled to the integration (getCompanyIdsWithCapability,
 *     the bulk form of the gate on the deep link route; an archived company is
 *     entitled to nothing);
 *   - the button would work for it: system auth is on (isSystemReadActive, what
 *     Hem and the settings page offer the button on), its org number reads as
 *     the deep link route reads it, and the org-number claim rule lets it hold
 *     the connection (ombudClaimStanding: not contested without BankID proof);
 *   - it has not appointed the app already (ombudAppointment 'appointed'), and
 *     did not disconnect it itself (status 'revoked'). A company that opened
 *     the deep link and never finished signing ('waiting') does get it.
 *
 * Recipients are the company's owners and admins (resolveCompanyAdminRecipients).
 * A person gets one mail per brand, naming every company of theirs that is
 * due, not one mail per company: a byrå consultant who administers forty
 * client companies would otherwise get forty identical mails in one morning.
 * Each (person, company) pair is logged in company_announcement_mails before
 * the mail goes, so nobody is ever told twice about the same company; a pair
 * is released again only when the provider definitely refused the mail, so a
 * refusal is retried the next day and an unknown outcome never is.
 *
 * Nothing is sent unless SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS=true. Without
 * it the run answers the same counts (companies due, people, mails, skipped
 * by reason) and sends nothing, so the audience can be checked first.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import { getBranding } from '@/lib/branding/service'
import { parseEntityType } from '@/lib/company/entity-type'
import { resolveBrandResultForCompany } from '@/lib/branding/resolve'
import { getBaseUrlForBrand, getSenderForBrand, type BrandSender } from '@/lib/email/brand-sender'
import { getEmailService } from '@/lib/email/service'
import {
  generateSkvOmbudAnnouncementHtml,
  generateSkvOmbudAnnouncementText,
  SKV_OMBUD_ANNOUNCEMENT_SUBJECT,
} from '@/lib/email/skatteverket-ombud-announcement-templates'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { Logger } from '@/lib/logger'
import { resolveCompanyAdminRecipients } from '@/lib/notifications/member-email'
import { mailLogo, resolveSigningLogo, type MailLogo } from '@/lib/signing/logo'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { ombudAppointment, type OmbudConnectionFacts } from '@/lib/skatteverket/ombud-appointment'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { getOmbudClaimStandings, type OmbudClaimStanding } from './connection-store'
import { currentSkvEnvironment, isSystemReadActive } from './resolve-auth'

/** The announcement's key in company_announcement_mails. */
export const OMBUD_ANNOUNCEMENT = 'skatteverket_ombud'

/** A company counts as using the integration with an audit row this recent. */
export const USAGE_WINDOW_DAYS = 30

/** Where the button is: Inställningar, Skatteverket. */
export const OMBUD_SETTINGS_PATH = '/settings/skatteverket'

/** Max ids per PostgREST .in() filter. */
const IN_CHUNK = 150

/** The mails go out only with this set to exactly 'true'; anything else counts and sends nothing. */
export function ombudAnnouncementMailsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS === 'true'
}

export type OmbudAnnouncementSkip =
  | 'not_entitled'
  | 'already_appointed'
  | 'disconnected'
  | 'no_org_number'
  | 'org_number_contested'
  | 'no_recipient'
  | 'already_sent'
  | 'brand_unreadable'

/** What decides whether a company that used the integration is offered the button. */
export interface OmbudAnnouncementFacts {
  /** Live and entitled to the Skatteverket integration. */
  entitled: boolean
  /** Its skatteverket_company_connections row in this environment, or null. */
  connection: OmbudConnectionFacts | null
  /** Its org number in 12-digit form, as the deep link route reads it; null when missing or unreadable. */
  orgNumber: string | null
  /** ombudClaimStanding on that org number. */
  claim: OmbudClaimStanding | null
}

/** Why a company is not in the audience, or null when it is (recipients aside). */
export function ombudAnnouncementSkip(facts: OmbudAnnouncementFacts): OmbudAnnouncementSkip | null {
  if (!facts.entitled) return 'not_entitled'
  if (facts.connection?.status === 'revoked') return 'disconnected'
  if (ombudAppointment(facts.connection).state === 'appointed') return 'already_appointed'
  if (!facts.orgNumber) return 'no_org_number'
  if (facts.claim !== 'clear') return 'org_number_contested'
  return null
}

export interface OmbudAnnouncementResult {
  /** The button works in this installation (the integration and system auth are on). */
  ombud_enabled: boolean
  /** SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS=true: mail may go out. */
  mails: boolean
  /** Companies with Skatteverket activity in the window. */
  used_recently: number
  /** Companies with at least one owner or admin still to be told. */
  eligible_companies: number
  /** Distinct people still to be told. */
  recipients: number
  /** Mails due: one per person and brand. */
  mails_due: number
  skipped: Record<OmbudAnnouncementSkip, number>
  sent: number
  failed: number
  /** Mails left for the next run when this one ran out of time. */
  deferred: number
  /** Mail was switched on but no email provider is configured. */
  not_configured: boolean
}

interface DueCompany {
  companyId: string
  companyName: string
}

interface MailGroup {
  userId: string
  email: string
  sender: BrandSender
  companies: DueCompany[]
}

function emptyResult(mails: boolean): OmbudAnnouncementResult {
  return {
    ombud_enabled: false,
    mails,
    used_recently: 0,
    eligible_companies: 0,
    recipients: 0,
    mails_due: 0,
    skipped: {
      not_entitled: 0,
      already_appointed: 0,
      disconnected: 0,
      no_org_number: 0,
      org_number_contested: 0,
      no_recipient: 0,
      already_sent: 0,
      brand_unreadable: 0,
    },
    sent: 0,
    failed: 0,
    deferred: 0,
    not_configured: false,
  }
}

/** Companies with a Skatteverket audit row since `since`. A failed read throws. */
async function companiesUsingSkatteverket(service: SupabaseClient, since: Date): Promise<string[]> {
  const rows = await fetchAllRows<{ company_id: string | null }>(({ from, to }) =>
    service
      .from('skatteverket_api_audit_log')
      .select('company_id')
      .gte('created_at', since.toISOString())
      .not('company_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
  )
  return [...new Set(rows.map((r) => r.company_id).filter((id): id is string => Boolean(id)))]
}

/**
 * The connection rows of these companies in this environment. A failed read
 * throws: reading it as "no row" would announce to companies that appointed
 * the app already.
 */
async function connectionsFor(
  service: SupabaseClient,
  companyIds: readonly string[],
): Promise<Map<string, OmbudConnectionFacts>> {
  const result = new Map<string, OmbudConnectionFacts>()
  const environment = currentSkvEnvironment()
  for (const ids of chunk([...companyIds], IN_CHUNK)) {
    const { data, error } = await service
      .from('skatteverket_company_connections')
      .select('company_id, status, lasombud_status, moms_ombud_status, last_probe_detail')
      .eq('environment', environment)
      .in('company_id', ids)
    if (error) throw new Error(`skatteverket connections unreadable: ${error.message}`)
    for (const row of (data ?? []) as Array<OmbudConnectionFacts & { company_id: string }>) result.set(row.company_id, row)
  }
  return result
}

type SettingsRow = { company_id: string; org_number: string | null; entity_type: string | null; company_name: string | null }

async function settingsFor(service: SupabaseClient, companyIds: readonly string[]): Promise<Map<string, SettingsRow>> {
  const result = new Map<string, SettingsRow>()
  for (const ids of chunk([...companyIds], IN_CHUNK)) {
    const { data, error } = await service
      .from('company_settings')
      .select('company_id, org_number, entity_type, company_name')
      .in('company_id', ids)
    if (error) throw new Error(`company settings unreadable: ${error.message}`)
    for (const row of (data ?? []) as SettingsRow[]) result.set(row.company_id, row)
  }
  return result
}

/** The org number as the deep link route reads it: company_settings, in 12-digit form; null when it does not read. */
function redovisare(settings: SettingsRow | undefined): string | null {
  if (!settings?.org_number) return null
  try {
    return formatRedovisare(settings.org_number, parseEntityType(settings.entity_type))
  } catch {
    // A number that does not convert is no number to the deep link route
    // either; the run counts the company under skipped.no_org_number.
    return null
  }
}

/**
 * The (company, person) pairs already told, as `${companyId}:${userId}`. A
 * failed read throws. A log table not migrated yet (the code deploys before
 * the migration runs) has told nobody, so the count still answers; sending
 * cannot happen without it, since every mail is logged before it goes.
 */
async function toldPairs(service: SupabaseClient, companyIds: readonly string[]): Promise<Set<string>> {
  const result = new Set<string>()
  for (const ids of chunk([...companyIds], IN_CHUNK)) {
    let rows: Array<{ company_id: string; user_id: string }>
    try {
      // Paged: a byrå's companies times their admins passes 1000 rows.
      rows = await fetchAllRows<{ company_id: string; user_id: string }>(({ from, to }) =>
        service
          .from('company_announcement_mails')
          .select('company_id, user_id')
          .eq('announcement', OMBUD_ANNOUNCEMENT)
          .in('company_id', ids)
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      if (isMissingTableError(error as { code?: string })) return result
      throw new Error(`announcement log unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const row of rows) result.add(`${row.company_id}:${row.user_id}`)
  }
  return result
}

/**
 * Who is due the mail, grouped one mail per person and brand. Counts the
 * audience into `result` as it goes.
 */
export async function planOmbudAnnouncement(
  service: SupabaseClient,
  result: OmbudAnnouncementResult,
  now: Date,
): Promise<MailGroup[]> {
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * 86_400_000)
  const used = await companiesUsingSkatteverket(service, since)
  result.used_recently = used.length
  if (used.length === 0) return []

  const [entitled, connections, settings] = await Promise.all([
    getCompanyIdsWithCapability(service, used, CAPABILITY.skatteverket),
    connectionsFor(service, used),
    settingsFor(service, used),
  ])
  const orgNumbers = new Map(used.map((id) => [id, redovisare(settings.get(id))]))
  const standings = await getOmbudClaimStandings(
    used.flatMap((companyId) => {
      const orgNumber = orgNumbers.get(companyId)
      return entitled.has(companyId) && orgNumber ? [{ companyId, orgNumber }] : []
    }),
  )

  const due: DueCompany[] = []
  for (const companyId of used) {
    const skip = ombudAnnouncementSkip({
      entitled: entitled.has(companyId),
      connection: connections.get(companyId) ?? null,
      orgNumber: orgNumbers.get(companyId) ?? null,
      claim: standings.get(companyId) ?? null,
    })
    if (skip) result.skipped[skip]++
    else due.push({ companyId, companyName: (settings.get(companyId)?.company_name ?? '').trim() })
  }
  if (due.length === 0) return []

  const told = await toldPairs(service, due.map((c) => c.companyId))
  const groups = new Map<string, MailGroup>()
  for (const company of due) {
    const recipients = await resolveCompanyAdminRecipients(service, company.companyId)
    if (recipients.length === 0) {
      result.skipped.no_recipient++
      continue
    }
    const untold = recipients.filter((r) => !told.has(`${company.companyId}:${r.userId}`))
    if (untold.length === 0) {
      result.skipped.already_sent++
      continue
    }
    // A failed brand read must not send a white-label company the platform's
    // mail, which could never be taken back: the company waits for a read
    // that answers.
    const { brand, lookupFailed } = await resolveBrandResultForCompany(company.companyId)
    if (lookupFailed) {
      result.skipped.brand_unreadable++
      continue
    }
    result.eligible_companies++
    const sender = getSenderForBrand(brand)
    for (const recipient of untold) {
      const key = `${recipient.userId}:${sender.brand?.id ?? ''}`
      const group = groups.get(key)
      if (group) group.companies.push(company)
      else groups.set(key, { userId: recipient.userId, email: recipient.email, sender, companies: [company] })
    }
  }
  result.recipients = new Set([...groups.values()].map((g) => g.userId)).size
  result.mails_due = groups.size
  return [...groups.values()]
}

/**
 * Log the pairs of this mail before it goes. Answers the companies this run
 * holds; a pair another run logged first is left to that run.
 */
async function claimPairs(service: SupabaseClient, group: MailGroup): Promise<Set<string>> {
  const { data, error } = await service
    .from('company_announcement_mails')
    .upsert(
      group.companies.map((c) => ({ announcement: OMBUD_ANNOUNCEMENT, company_id: c.companyId, user_id: group.userId })),
      { onConflict: 'announcement,company_id,user_id', ignoreDuplicates: true },
    )
    .select('company_id')
  if (error) throw new Error(`announcement log not written: ${error.message}`)
  return new Set(((data ?? []) as Array<{ company_id: string }>).map((r) => r.company_id))
}

async function releasePairs(service: SupabaseClient, userId: string, companyIds: readonly string[]): Promise<void> {
  const { error } = await service
    .from('company_announcement_mails')
    .delete()
    .eq('announcement', OMBUD_ANNOUNCEMENT)
    .eq('user_id', userId)
    .in('company_id', [...companyIds])
  if (error) throw new Error(`announcement log not released: ${error.message}`)
}

/** The brand's logo for the mail, read once per brand per run; a logo that cannot be read writes the name instead. */
function logoReader(log: Logger): (sender: BrandSender) => Promise<MailLogo | null> {
  const cache = new Map<string, Promise<MailLogo | null>>()
  return (sender) => {
    const brand = sender.brand
    if (!brand?.logoUrl) return Promise.resolve(null)
    let logo = cache.get(brand.id)
    if (!logo) {
      logo = resolveSigningLogo(brand.logoUrl)
        .then((resolved) => mailLogo(brand.logoUrl, resolved))
        .catch((error: unknown) => {
          log.warn('brand logo unavailable, mailing the name', { brandId: brand.id, message: error instanceof Error ? error.message : String(error) })
          return null
        })
      cache.set(brand.id, logo)
    }
    return logo
  }
}

/**
 * The daily run (vercel.json, 07:15 UTC): the audience, counted, and when
 * the mails are switched on, one mail per person and brand. `deadline`
 * (epoch ms) stops the sending in time for the route's limit; what is left
 * goes on the next run.
 */
export async function runOmbudAnnouncementCron(
  service: SupabaseClient,
  log: Logger,
  options: { now?: Date; env?: NodeJS.ProcessEnv; deadline?: number } = {},
): Promise<OmbudAnnouncementResult> {
  const now = options.now ?? new Date()
  const result = emptyResult(ombudAnnouncementMailsEnabled(options.env))
  if (!isSkatteverketEnabled() || !isSystemReadActive()) return result
  result.ombud_enabled = true

  const groups = await planOmbudAnnouncement(service, result, now)
  if (!result.mails || groups.length === 0) return result

  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    result.not_configured = true
    return result
  }
  const platform = getBranding()
  const logoFor = logoReader(log)

  for (const group of groups) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      result.deferred++
      continue
    }
    const claimed = await claimPairs(service, group)
    const companies = group.companies.filter((c) => claimed.has(c.companyId))
    if (companies.length === 0) continue

    const brand = group.sender.brand
    const appName = brand?.appName ?? platform.appName
    const supportEmail = brand?.supportEmail || platform.supportEmail
    const data = {
      appName,
      companyNames: companies.map((c) => c.companyName).filter(Boolean),
      settingsUrl: `${getBaseUrlForBrand(brand)}${OMBUD_SETTINGS_PATH}`,
      logo: await logoFor(group.sender),
      supportEmail,
      // The founder signs the platform's own mail; a white-label brand's mail
      // is signed by the brand, as the bank switch mails are.
      signature: brand ? ('brand' as const) : ('founder' as const),
    }
    const sent = await emailService
      .sendEmail({
        to: group.email,
        subject: SKV_OMBUD_ANNOUNCEMENT_SUBJECT,
        html: generateSkvOmbudAnnouncementHtml(data),
        text: generateSkvOmbudAnnouncementText(data),
        replyTo: group.sender.replyTo ?? supportEmail,
        ...(group.sender.fromName ? { fromName: group.sender.fromName } : {}),
        ...(group.sender.fromAddress ? { fromAddress: group.sender.fromAddress } : {}),
      })
      .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error), outcomeUnknown: true }))
    if (sent.success) {
      result.sent++
      continue
    }
    result.failed++
    log.warn('ombud announcement not sent', { userId: group.userId, companies: companies.length, reason: sent.error })
    // Refused for certain: nothing went out, so the next run tries again. An
    // unknown outcome keeps the log: a second copy is worse than none.
    if (sent.outcomeUnknown === false) await releasePairs(service, group.userId, companies.map((c) => c.companyId))
  }
  return result
}
