import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import type { Logger } from '@/lib/logger'
import { getDecisionReceipts } from './receipts'
import { bookingWhyUserIds, compactDecisions, type BookingWhyData, type BookingWhyEntry, type BookingWhyPerson } from './receipt-display'

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

  const people = await resolveBookingWhyPeople(options.profilesClient, companyId, bookingWhyUserIds(entry, decisions), options.log)
  return { entry, decisions, people }
}
