import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { resolveBrandsForTeams } from '@/lib/branding/team-brands'
import { isCockpitLandingRole, resolveLandingPath } from '@/lib/company/home-domain'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

interface ByraMembershipRow {
  team_id: string
  role: string
}

/**
 * Post-login landing decision (WL-14), callable server-side without an HTTP
 * round-trip: byrå owners/admins land in the cockpit ('/clients') when `host`
 * is their byrå's home domain: the byrå's brand domain, or the canonical
 * domain for a byrå without white label (WL-01). Plain byrå members and
 * everyone else get '/' so their flow stays byte-identical (role gate
 * 2026-08-27, see isCockpitLandingRole).
 *
 * `supabase` must be authenticated as `userId` (RLS scopes the membership
 * query). Callers that redirect on the result should degrade to '/' on any
 * thrown error: the rule is a convenience, never a gate.
 */
export async function resolveLandingDestination(
  supabase: SupabaseClient,
  userId: string,
  host: string,
): Promise<'/clients' | '/'> {
  const hostBrand = host ? await resolveBrandByHost(host) : null

  let memberships: ByraMembershipRow[]
  try {
    memberships = await fetchAllRows<ByraMembershipRow>(({ from, to }) =>
      supabase
        .from('team_members')
        .select('team_id, role, teams:team_id!inner(kind)')
        .eq('user_id', userId)
        .eq('teams.kind', 'byra')
        .order('team_id', { ascending: true })
        .range(from, to),
    )
  } catch (err) {
    // Degrading to '/' is safe but must not be silent: a persistent query
    // failure would otherwise look identical to "no byrå membership".
    console.error('[landing-server] byra membership query failed:', err)
    return '/'
  }

  const byraTeamIds = memberships
    .filter((m) => isCockpitLandingRole(m.role as string))
    .map((m) => m.team_id as string)
  if (byraTeamIds.length === 0) return '/'

  const brandByTeam = await resolveBrandsForTeams(byraTeamIds)
  return resolveLandingPath({
    hostBrandTeamId: hostBrand?.teamId ?? null,
    byraTeams: byraTeamIds.map((id) => ({ teamId: id, hasBrand: brandByTeam.has(id) })),
  })
}
