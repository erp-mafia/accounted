import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { resolveBrandsForTeams } from '@/lib/branding/team-brands'
import { resolveLandingPath } from '@/lib/company/home-domain'

/**
 * GET /api/clients/landing
 *
 * Post-login landing decision (WL-14): byrå staff land in the cockpit
 * ('/clients') when the current host is their byrå's home domain: the byrå's
 * brand domain, or the canonical domain for a byrå without white label
 * (WL-01). Everyone else gets '/' so their flow stays byte-identical. Called
 * by the login and MFA-verify pages when no explicit destination was
 * requested; any failure degrades to '/' at the caller.
 */
export const GET = withRouteContext('clients.landing', async (request, ctx) => {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const hostBrand = host ? await resolveBrandByHost(host) : null

  const { data: memberships } = await ctx.supabase
    .from('team_members')
    .select('team_id, teams:team_id!inner(kind)')
    .eq('user_id', ctx.user.id)
    .eq('teams.kind', 'byra')

  const byraTeamIds = (memberships ?? []).map((m) => m.team_id as string)
  if (byraTeamIds.length === 0) {
    return NextResponse.json({ data: { destination: '/' } })
  }

  const brandByTeam = await resolveBrandsForTeams(byraTeamIds)
  const destination = resolveLandingPath({
    hostBrandTeamId: hostBrand?.teamId ?? null,
    byraTeams: byraTeamIds.map((id) => ({ teamId: id, hasBrand: brandByTeam.has(id) })),
  })

  return NextResponse.json({ data: { destination } })
})
