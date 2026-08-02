import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'

/**
 * Kept verbatim from the pre-unfreeze hardcoded 403: personal teams remain
 * uninvitable (WL-08), so their (theoretical) invitations stay untouchable.
 */
const PERSONAL_TEAM_MESSAGE = 'Teaminbjudningar är inaktiverade.'

/**
 * DELETE /api/team/invite/[id]
 * Revoke a pending byrå-team invitation (WL-08 invite unfreeze).
 *
 * Same gates as POST /api/team/invite: the invitation's team must be
 * kind='byra' and the caller must be team owner or admin. Revocation is a
 * status flip (not a row delete) so the (team, email) unique pair keeps its
 * history and a later re-invite reuses the row.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireAuth()
  if (error) return error

  const { id } = await params
  const serviceClient = createServiceClient()

  const { data: invitation } = await serviceClient
    .from('team_invitations')
    .select('id, team_id, status, teams:team_id(kind)')
    .eq('id', id)
    .maybeSingle()

  const invite = invitation as
    | { id: string; team_id: string; status: string; teams: { kind: string } | null }
    | null

  if (!invite) {
    return NextResponse.json({ error: 'Inbjudan hittades inte.' }, { status: 404 })
  }

  // Kind gate first: personal-team invitations are frozen surface, byrå only.
  if (invite.teams?.kind !== 'byra') {
    return NextResponse.json({ error: PERSONAL_TEAM_MESSAGE }, { status: 403 })
  }

  // Role gate: the caller must be owner/admin of the invitation's team.
  const { data: membership } = await serviceClient
    .from('team_members')
    .select('role')
    .eq('team_id', invite.team_id)
    .eq('user_id', user.id)
    .maybeSingle()

  const callerRole = (membership as { role: string } | null)?.role
  if (!callerRole || !['owner', 'admin'].includes(callerRole)) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  if (invite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 409 })
  }

  const { error: revokeError } = await serviceClient
    .from('team_invitations')
    .update({ status: 'revoked' })
    .eq('id', invite.id)

  if (revokeError) {
    return NextResponse.json({ error: 'Kunde inte återkalla inbjudan.' }, { status: 500 })
  }

  return NextResponse.json({ data: { id: invite.id, status: 'revoked' } })
}
