import type { SupabaseClient } from '@supabase/supabase-js'
import { codedRefusal } from '@/lib/errors/refusal'

/**
 * The team a company attaches to when it is created without a cookie session
 * (POST /api/v1/companies, the MCP tools gnubok_create_company and
 * gnubok_formation) and the caller names no team: the owner's PERSONAL team.
 *
 * Never a byrå team (WL-08): picking the first membership regardless of kind
 * attached a consultant's private company to their byrå team, exposing their
 * books to the whole byrå and suppressing the trial. Cockpit flows pass the
 * byrå team explicitly, and create_company_for_user authorizes an explicit
 * team in the database.
 *
 * It is the team ensure_user_team picks for a cookie session (migration
 * 20260826130100): kind 'personal', the earliest teams.created_at, then the
 * lowest teams.id. That RPC reads auth.uid(), which a service-role door does
 * not have, so these doors read it here.
 *
 * null when the owner has no personal team: create_company_for_user then
 * leaves team_id NULL. A failed read throws COMPANY_CREATE_FAILED: it is not
 * an answer that the owner has no personal team, and a company created on it
 * loses its team without a word, so the door refuses before anything is
 * written and a retry is safe.
 */
export async function defaultTeamForNewCompany(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('team_members')
    // PostgREST orders by an embedded column only when the embed selects it:
    // the ORDER BY names the embed's own alias. Without id in the embed every
    // lookup failed with 42703 (team_members_teams_1.id does not exist).
    .select('team_id, teams!inner(id, kind, created_at)')
    .eq('user_id', ownerId)
    .eq('teams.kind', 'personal')
    .order('teams(created_at)', { ascending: true })
    .order('teams(id)', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw codedRefusal(
      'COMPANY_CREATE_FAILED',
      `The owner's personal team could not be read, so no company was created (${error.message}). Retry the call.`,
    )
  }
  return (data?.team_id as string | undefined) ?? null
}
