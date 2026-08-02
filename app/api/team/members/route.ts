import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'

/**
 * GET /api/team/members
 * Returns the member roster for one of the caller's teams.
 *
 * Multi-team model (WL-08): a user may belong to several teams (their own
 * personal shell AND a byrå team), so the old `.limit(1)` single-membership
 * read is gone. Selection:
 *   - `?teamId=` targets an explicit team, validated against the caller's own
 *     memberships (404 otherwise)
 *   - default: the caller's byrå team when one exists, else the personal team
 *
 * Team-scoped (not company-scoped): a brand-new user with no company must
 * still get a valid empty response (ownsCompany: false), so this uses
 * requireAuth() directly rather than withRouteContext, which would require an
 * active company context. requireAuth still enforces MFA (AAL2) on hosted.
 *
 * Read-only: team role changes are re-synced to company_members by the
 * DB trigger (team_member_sync_role_update); this route just reflects the
 * current rows and never writes roles.
 */
export async function GET(request: NextRequest) {
  const { user, error } = await requireAuth()
  if (error) return error

  const serviceClient = createServiceClient()

  // Every team membership the user holds, with each team's name and kind.
  const { data: myMemberships } = await serviceClient
    .from('team_members')
    .select('team_id, role, teams:team_id(id, name, kind, created_at)')
    .eq('user_id', user.id)

  const memberships = (myMemberships ?? []) as unknown as {
    team_id: string
    role: string
    teams: { id: string; name: string; kind: string; created_at: string } | null
  }[]

  if (memberships.length === 0) {
    // User is not in any team: check if they own a company (could start a team)
    const { data: ownedCompany } = await serviceClient
      .from('company_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()

    return NextResponse.json({
      data: {
        members: [],
        invitations: [],
        teamName: null,
        teamId: null,
        teamKind: null,
        isOwner: false,
        hasTeam: false,
        canInvite: false,
        teams: [],
        ownsCompany: !!ownedCompany,
      },
    })
  }

  const requestedTeamId = request.nextUrl.searchParams.get('teamId')

  let myMembership: (typeof memberships)[number] | undefined
  if (requestedTeamId) {
    myMembership = memberships.find((m) => m.team_id === requestedTeamId)
    if (!myMembership) {
      return NextResponse.json({ error: 'Team hittades inte.' }, { status: 404 })
    }
  } else {
    // Default: byrå team first (that is the roster a consultant cares about),
    // else the personal team. Deterministic tie-break on team creation time.
    const byCreated = (a: (typeof memberships)[number], b: (typeof memberships)[number]) =>
      (a.teams?.created_at ?? '').localeCompare(b.teams?.created_at ?? '')
    myMembership =
      memberships.filter((m) => m.teams?.kind === 'byra').sort(byCreated)[0] ??
      [...memberships].sort(byCreated)[0]
  }

  const teamId = myMembership.team_id
  const teamKind = myMembership.teams?.kind ?? 'personal'
  const isOwner = myMembership.role === 'owner'
  const canInvite = teamKind === 'byra' && ['owner', 'admin'].includes(myMembership.role)

  // Team name from the joined row; fall back to a direct read when the join
  // is absent (defensive: service role bypasses RLS so it should be present).
  let teamName = myMembership.teams?.name ?? null
  if (!teamName) {
    const { data: team } = await serviceClient
      .from('teams')
      .select('name')
      .eq('id', teamId)
      .single()
    teamName = (team as { name: string } | null)?.name ?? null
  }

  // Fetch all team members (owner is a real row now)
  const { data: members, error: membersError } = await serviceClient
    .from('team_members')
    .select('id, team_id, user_id, role, joined_at')
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true })

  if (membersError) {
    return NextResponse.json({ error: 'Kunde inte hämta teammedlemmar.' }, { status: 500 })
  }

  // Fetch emails from profiles
  const userIds = (members || []).map((m) => m.user_id)
  const { data: profiles } = await serviceClient
    .from('profiles')
    .select('id, email')
    .in('id', userIds)

  const emailMap = new Map((profiles || []).map((p) => [p.id, p.email]))

  // Pending invitations: only meaningful (and only shown) on byrå teams for
  // callers who may manage invites; everyone else gets an empty list so the
  // payload shape stays constant. Revoked/accepted rows are history, not
  // roster state, so only status='pending' is returned (the client derives
  // "expired" from expires_at).
  let invitations: {
    id: string
    email: string
    role: string
    status: string
    created_at: string
    expires_at: string
  }[] = []
  if (canInvite) {
    const { data: inviteRows } = await serviceClient
      .from('team_invitations')
      .select('id, email, role, status, created_at, expires_at')
      .eq('team_id', teamId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    invitations = (inviteRows ?? []) as typeof invitations
  }

  return NextResponse.json({
    data: {
      members: (members || []).map((m) => ({
        id: m.id,
        user_id: m.user_id,
        email: emailMap.get(m.user_id) || '',
        role: m.role,
        joined_at: m.joined_at,
        is_current_user: m.user_id === user.id,
      })),
      invitations,
      teamName,
      teamId,
      teamKind,
      isOwner,
      hasTeam: true,
      canInvite,
      // All of the caller's teams, so the client can offer a team switcher.
      teams: memberships.map((m) => ({
        id: m.team_id,
        name: m.teams?.name ?? null,
        kind: m.teams?.kind ?? 'personal',
        role: m.role,
      })),
    },
  })
}
