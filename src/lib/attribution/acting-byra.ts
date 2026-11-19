import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The byrå a user acts through for a company: the name of the company's team
 * when that team is a byrå (teams.kind = 'byra') and the user is a member of
 * it, else null. Every user also owns a personal team (kind 'personal', named
 * "Personal"), and a company they created sits in it; that name says nothing
 * about who asks, so it never counts.
 */
export async function actingByraName(service: SupabaseClient, teamId: string | null | undefined, userId: string): Promise<string | null> {
  if (!teamId) return null
  const { data: membership } = await service
    .from('team_members')
    .select('team_id, teams(name, kind)')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle()
  type TeamJoin = { name?: string | null; kind?: string | null }
  const joined = (membership as { teams?: TeamJoin | TeamJoin[] | null } | null)?.teams
  const team = Array.isArray(joined) ? joined[0] : joined
  if (team?.kind !== 'byra') return null
  return team.name?.trim() || null
}
