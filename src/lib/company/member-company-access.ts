import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { chunk } from '@/lib/utils'

/**
 * Which client companies a byrå team member reaches (migration
 * 20261028110000): every company of the team (team_members.all_companies,
 * the default), or only the chosen ones. Owners and admins always have every
 * company; only a member can be limited.
 */

/** Upper bound on one choice; a byrå's whole client list fits well inside it. */
export const MAX_CHOSEN_COMPANIES = 1000

/** Max ids per PostgREST .in() filter (mirrors lib/worklist IN_CLAUSE_CHUNK). */
const IN_CLAUSE_CHUNK = 150

/**
 * The chosen companies in a request body: at least one, duplicates dropped.
 * Choosing no company is not a state; removing the member is.
 */
export const ChosenCompanyIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_CHOSEN_COMPANIES)
  .transform((ids) => [...new Set(ids)])

/** The route message when a chosen company is not one of the team's clients. */
export const COMPANIES_OUTSIDE_TEAM_MESSAGE = 'Ett eller flera bolag hör inte till byrån.'

/** The route message when someone tries to limit an owner or admin. */
export const MANAGERS_HAVE_ALL_COMPANIES_MESSAGE =
  'Ägare och administratörer når alltid alla bolag.'

/**
 * The ids that are non-archived client companies of the team, in input order.
 * Pass the service-role client: the question is the team's client list, not
 * what the caller's own RLS view happens to show.
 */
export async function filterTeamClientCompanyIds(
  serviceClient: SupabaseClient,
  teamId: string,
  companyIds: string[],
): Promise<string[]> {
  const found = new Set<string>()
  for (const ids of chunk(companyIds, IN_CLAUSE_CHUNK)) {
    const { data, error } = await serviceClient
      .from('companies')
      .select('id')
      .eq('team_id', teamId)
      .is('archived_at', null)
      .in('id', ids)
    if (error) throw error
    for (const row of (data ?? []) as { id: string }[]) found.add(row.id)
  }
  return companyIds.filter((id) => found.has(id))
}
