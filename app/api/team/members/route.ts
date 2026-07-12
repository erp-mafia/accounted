import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'

/**
 * GET /api/team/members
 * Returns team members (single-user teams, no invitations).
 *
 * Team-scoped (not company-scoped): a brand-new user with no company must
 * still get a valid empty response (ownsCompany: false), so this uses
 * requireAuth() directly rather than withRouteContext, which would require an
 * active company context. requireAuth still enforces MFA (AAL2) on hosted.
 */
export async function GET() {
  const { user, error } = await requireAuth()
  if (error) return error

  const serviceClient = await createServiceClient()

  // Find the user's team membership
  const { data: myMembership } = await serviceClient
    .from('team_members')
    .select('team_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!myMembership) {
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
        teamName: null,
        teamId: null,
        isOwner: false,
        hasTeam: false,
        ownsCompany: !!ownedCompany,
      },
    })
  }

  const teamId = myMembership.team_id
  const isOwner = myMembership.role === 'owner'

  // Fetch team name
  const { data: team } = await serviceClient
    .from('teams')
    .select('name')
    .eq('id', teamId)
    .single()

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
      teamName: team?.name || null,
      teamId,
      isOwner,
      hasTeam: true,
    },
  })
}
