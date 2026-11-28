import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import type { Logger } from '@/lib/logger'
import {
  COUNTERPARTY_PREFIX,
  formatCounterpartyName,
  isCounterpartyTemplateId,
} from '@/lib/bookkeeping/counterparty-template-format'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getDecisionReceipts } from './receipts'
import {
  bookingWhyUserIds,
  compactDecisions,
  MAX_SAME_REQUEST_VOUCHERS,
  type BookingWhyData,
  type BookingWhyDecisions,
  type BookingWhyEntry,
  type BookingWhyPerson,
  type BookingWhyRule,
  type BookingWhySameRequest,
} from './receipt-display'

/**
 * What the "Därför bokades den så" view needs for one verifikat, read in one
 * place for the verifikat page and the Inkorg: the entry's commit actor, its
 * decisions (the newest receipt in full, the others compacted to a short
 * list and a count: the view renders nothing more, and a samlingsverifikat
 * can carry a hundred), and the people the view names. Read-only.
 *
 * Best-effort past the entry itself: a failed receipt read answers null
 * (unknown, so the view falls back to the entry alone, never to "nothing was
 * decided"), and a failed people lookup leaves names out.
 */

type ProfilesClient = Pick<SupabaseClient, 'from'>

/**
 * Names for the user ids, and whether each reaches the company through its
 * byrå team (company_members.source 'team' on a company whose team is a
 * byrå). `profiles` RLS is self-only, so the caller passes a service-role
 * client; every query is scoped to exactly these ids and this company.
 */
export async function resolveBookingWhyPeople(
  profilesClient: () => ProfilesClient,
  companyId: string,
  userIds: string[],
  log?: Pick<Logger, 'warn'>,
): Promise<Record<string, BookingWhyPerson>> {
  const people: Record<string, BookingWhyPerson> = {}
  if (userIds.length === 0) return people
  try {
    const client = profilesClient()
    const [profiles, members, company] = await Promise.all([
      client.from('profiles').select('id, email, full_name').in('id', userIds),
      client.from('company_members').select('user_id, source').eq('company_id', companyId).in('user_id', userIds),
      client.from('companies').select('team_id, teams:team_id(name, kind)').eq('id', companyId).maybeSingle(),
    ])
    const embedded = (company.data as { teams?: unknown } | null)?.teams
    const team = (Array.isArray(embedded) ? embedded[0] : embedded) as { name?: unknown; kind?: unknown } | null | undefined
    const byraName = team?.kind === 'byra' && typeof team.name === 'string' && team.name.trim() ? team.name.trim() : null
    const viaTeam = new Set(
      ((members.data ?? []) as { user_id: string; source: string | null }[])
        .filter((m) => m.source === 'team')
        .map((m) => m.user_id),
    )
    for (const p of (profiles.data ?? []) as { id: string; email: string | null; full_name: string | null }[]) {
      const byra = team?.kind === 'byra' && viaTeam.has(p.id)
      // A person by name: the full name when they gave one, else the e-mail.
      people[p.id] = { name: p.full_name?.trim() || p.email || null, byra, byra_name: byra ? byraName : null }
    }
  } catch (err) {
    log?.warn('booking-why people lookup failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return people
}

/** Null when the entry is not the company's. */
export async function getBookingWhyData(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
  options: { profilesClient: () => ProfilesClient; log?: Pick<Logger, 'warn'> },
): Promise<BookingWhyData | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, status, source_type, committed_at, committed_actor_type, committed_actor_label, commit_method, user_id')
    .eq('company_id', companyId)
    .eq('id', journalEntryId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) return null
  const entry = data as BookingWhyEntry

  let decisions: BookingWhyData['decisions']
  try {
    decisions = compactDecisions(await getDecisionReceipts(supabase, companyId, { journalEntryId }))
  } catch (err) {
    options.log?.warn('booking-why receipts lookup failed', { journalEntryId, error: err instanceof Error ? err.message : String(err) })
    decisions = null
  }

  const [people, rule, same_request] = await Promise.all([
    resolveBookingWhyPeople(options.profilesClient, companyId, bookingWhyUserIds(entry, decisions), options.log),
    readDecisionRule(supabase, companyId, decisions, options.log),
    readSameRequest(supabase, companyId, journalEntryId, options.log),
  ])
  return { entry, decisions, people, rule, same_request }
}

/**
 * The counterpart rule the latest decision's chosen suggestion came from,
 * named as the Regler page names it. Null without one, when the rule is gone,
 * or when it could not be read.
 */
export async function readDecisionRule(
  supabase: Pick<SupabaseClient, 'from'>,
  companyId: string,
  decisions: BookingWhyDecisions | null,
  log?: Pick<Logger, 'warn'>,
): Promise<BookingWhyRule | null> {
  const chosen = decisions?.latest?.chosen
  if (!chosen || chosen.source !== 'counterparty_template' || !isCounterpartyTemplateId(chosen.source_id)) return null
  const id = chosen.source_id.slice(COUNTERPARTY_PREFIX.length)
  try {
    const { data, error } = await supabase
      .from('categorization_templates')
      .select('id, counterparty_name')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    const row = data as { id: string; counterparty_name: string } | null
    return row ? { id: row.id, name: formatCounterpartyName(row.counterparty_name) } : null
  } catch (err) {
    log?.warn('booking-why rule lookup failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * The window around a verifikat's commit in which the other commits of the
 * same request are looked for: a request runs for minutes at most, and the
 * window keeps the read on audit_log's created_at index.
 */
const SAME_REQUEST_WINDOW_MS = 15 * 60 * 1000

/** At most this many of the request's other commits are read; a larger request is counted as this many. */
const SAME_REQUEST_READ_LIMIT = 200

/** Postgres: the column does not exist (migration 20261128110000 has not run here yet). */
const UNDEFINED_COLUMN = '42703'

/**
 * The other verifikat committed by the request that committed this one: the
 * COMMIT audit rows that carry the same trace id (migration 20261128110000).
 * Null when the commit carries no trace (before it was recorded, or outside a
 * request), when the request committed nothing else, or when it could not be
 * read.
 */
export async function readSameRequest(
  supabase: Pick<SupabaseClient, 'from'>,
  companyId: string,
  journalEntryId: string,
  log?: Pick<Logger, 'warn'>,
): Promise<BookingWhySameRequest | null> {
  try {
    const own = await supabase
      .from('audit_log')
      .select('trace_id, created_at')
      .eq('company_id', companyId)
      .eq('table_name', 'journal_entries')
      .eq('record_id', journalEntryId)
      .eq('action', 'COMMIT')
      .not('trace_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
    if (own.error) {
      if (own.error.code === UNDEFINED_COLUMN) return null
      throw own.error
    }
    const commit = (own.data ?? [])[0] as { trace_id: string; created_at: string } | undefined
    if (!commit) return null

    const at = Date.parse(commit.created_at)
    const others = await supabase
      .from('audit_log')
      .select('record_id')
      .eq('company_id', companyId)
      .eq('table_name', 'journal_entries')
      .eq('action', 'COMMIT')
      .eq('trace_id', commit.trace_id)
      .gte('created_at', new Date(at - SAME_REQUEST_WINDOW_MS).toISOString())
      .lte('created_at', new Date(at + SAME_REQUEST_WINDOW_MS).toISOString())
      .neq('record_id', journalEntryId)
      .limit(SAME_REQUEST_READ_LIMIT)
    if (others.error) throw others.error
    const ids = [...new Set(((others.data ?? []) as { record_id: string | null }[]).map((r) => r.record_id).filter((id): id is string => !!id))]
    if (ids.length === 0) return null

    const entries = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', ids)
    if (entries.error) throw entries.error
    const vouchers = ((entries.data ?? []) as { voucher_series: string | null; voucher_number: number | null }[])
      .filter((e) => (e.voucher_number ?? 0) > 0)
      .sort((a, b) => (a.voucher_series ?? '').localeCompare(b.voucher_series ?? '') || (a.voucher_number ?? 0) - (b.voucher_number ?? 0))
      .slice(0, MAX_SAME_REQUEST_VOUCHERS)
      .map((e) => formatVoucher(e))
    return { vouchers, total: ids.length }
  } catch (err) {
    log?.warn('booking-why same request lookup failed', { journalEntryId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}
