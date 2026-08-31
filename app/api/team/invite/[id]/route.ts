import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { sendTeamInviteMail } from '@/lib/email/send-team-invite'

// Loads the email extension so the re-send path gets the Resend
// implementation instead of the noop default (same as POST /api/team/invite).
ensureInitialized()

/**
 * Kept verbatim from the pre-unfreeze hardcoded 403: personal teams remain
 * uninvitable (WL-08), so their (theoretical) invitations stay untouchable.
 */
const PERSONAL_TEAM_MESSAGE = 'Teaminbjudningar är inaktiverade.'

interface InviteRow {
  id: string
  team_id: string
  email: string
  role: string
  status: string
  teams: { kind: string } | null
}

/**
 * Shared gate chain for acting on an existing invitation: it must exist, its
 * team must be kind='byra' (personal-team invitations are frozen surface),
 * and the caller must be owner/admin of that team. Returns the invitation row
 * or the error response to bubble.
 */
async function loadInviteForManagement(
  serviceClient: ReturnType<typeof createServiceClient>,
  inviteId: string,
  userId: string,
): Promise<{ invite: InviteRow } | { response: NextResponse }> {
  const { data: invitation } = await serviceClient
    .from('team_invitations')
    .select('id, team_id, email, role, status, teams:team_id(kind)')
    .eq('id', inviteId)
    .maybeSingle()

  const invite = invitation as unknown as InviteRow | null

  if (!invite) {
    return { response: NextResponse.json({ error: 'Inbjudan hittades inte.' }, { status: 404 }) }
  }

  // Kind gate first: personal-team invitations are frozen surface, byrå only.
  if (invite.teams?.kind !== 'byra') {
    return { response: NextResponse.json({ error: PERSONAL_TEAM_MESSAGE }, { status: 403 }) }
  }

  // Role gate: the caller must be owner/admin of the invitation's team.
  const { data: membership } = await serviceClient
    .from('team_members')
    .select('role')
    .eq('team_id', invite.team_id)
    .eq('user_id', userId)
    .maybeSingle()

  const callerRole = (membership as { role: string } | null)?.role
  if (!callerRole || !['owner', 'admin'].includes(callerRole)) {
    return { response: NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 }) }
  }

  return { invite }
}

/**
 * POST /api/team/invite/[id]
 * Re-send a pending byrå-team invitation (WL-08 follow-up: the Arbore case,
 * where the original mail never reached the invitee and the inviter had no
 * recovery path).
 *
 * Same gates as DELETE. Only pending invitations can be re-sent (an expired
 * pending one is revived: the token and expiry are re-issued in place, which
 * also invalidates any previously mailed link). The response mirrors POST
 * /api/team/invite so the client gets a fresh shareable inviteUrl regardless
 * of whether the mail went out.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireAuth()
  if (error) return error

  const { id } = await params
  const serviceClient = createServiceClient()

  const loaded = await loadInviteForManagement(serviceClient, id, user.id)
  if ('response' in loaded) return loaded.response
  const { invite } = loaded

  if (invite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 409 })
  }

  const { token, hash } = generateInviteToken()
  const expiresAt = getInviteExpiry()

  const { error: updateError } = await serviceClient
    .from('team_invitations')
    .update({
      token_hash: hash,
      invited_by: user.id,
      expires_at: expiresAt.toISOString(),
    })
    .eq('id', invite.id)

  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte skicka om inbjudan.' }, { status: 500 })
  }

  const { inviteUrl, emailSent } = await sendTeamInviteMail({
    teamId: invite.team_id,
    email: invite.email,
    inviterEmail: user.email || '',
    token,
  })

  return NextResponse.json({
    data: {
      id: invite.id,
      teamId: invite.team_id,
      email: invite.email,
      role: invite.role,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
      email_sent: emailSent,
      // Always returned so the inviter can share the link directly when the
      // mail did not go out (or never arrives).
      inviteUrl,
    },
  })
}

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

  const loaded = await loadInviteForManagement(serviceClient, id, user.id)
  if ('response' in loaded) return loaded.response
  const { invite } = loaded

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
