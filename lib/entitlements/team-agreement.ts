import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * WL-10 billing honesty: a company attached to a byrå team whose team holds
 * an active manual (partner-agreement) grant is covered by the byrå's
 * agreement. The billing surface shows an "Ingår i <byråns namn>s avtal"
 * state instead of the upgrade pitch for these companies.
 */
export interface TeamAgreement {
  teamName: string
}

/**
 * Resolve whether `companyId` is covered by a byrå-team agreement.
 *
 * The v1 partner deal is manual team-scoped grant rows: source='manual',
 * team_id set, expires_at = contract end or NULL (WL-10 resolution). Any such
 * unexpired row on the company's team counts; grace handling is simply ops
 * setting expires_at, after which this returns null and the company falls
 * back to the standard non-paying behavior.
 *
 * MUST be called with the SERVICE client: end clients are never members of
 * the byrå team (WL-08), so RLS hides both the team row and the team-scoped
 * grant rows from their session. The caller is responsible for having
 * authorized companyId (requireCompanyId) before passing it here.
 */
export async function getTeamAgreement(
  serviceClient: SupabaseClient,
  companyId: string,
): Promise<TeamAgreement | null> {
  const { data: company } = await serviceClient
    .from('companies')
    .select('team_id')
    .eq('id', companyId)
    .maybeSingle()

  const teamId = (company as { team_id: string | null } | null)?.team_id ?? null
  if (!teamId) return null

  const { data: team } = await serviceClient
    .from('teams')
    .select('name, kind')
    .eq('id', teamId)
    .maybeSingle()

  const teamRow = team as { name: string; kind: string } | null
  if (!teamRow || teamRow.kind !== 'byra') return null

  const { data: grants, error: grantsError } = await serviceClient
    .from('capability_grants')
    .select('expires_at')
    .eq('team_id', teamId)
    .eq('source', 'manual')

  // Fail-closed on a read error: no fabricated agreement state.
  if (grantsError) return null

  const now = Date.now()
  const active = ((grants ?? []) as { expires_at: string | null }[]).some(
    (g) => g.expires_at === null || new Date(g.expires_at).getTime() > now,
  )

  return active ? { teamName: teamRow.name } : null
}
