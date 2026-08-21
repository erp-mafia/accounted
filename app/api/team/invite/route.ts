import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { sendTeamInviteMail } from '@/lib/email/send-team-invite'

// Loads the email extension so getEmailService() returns the Resend
// implementation instead of the noop default (same reason as the company
// invite route: without this the invite mail silently no-ops in a fresh
// process).
ensureInitialized()

/**
 * Kept verbatim from the pre-unfreeze hardcoded 403: personal teams remain
 * uninvitable (WL-08), and this is the message their members still see.
 */
const PERSONAL_TEAM_MESSAGE = 'Teaminbjudningar är inaktiverade. Bjud in via enskilda företag.'

const InviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email('Ogiltig e-postadress.')),
  // Team invitations never mint owners: the schema is the first gate, and the
  // accept route re-checks (defense in depth against a hand-edited row).
  role: z.enum(['admin', 'member']).default('member'),
  // Optional explicit team target for users in several teams; validated
  // against the caller's own memberships below.
  teamId: z.string().uuid().optional(),
})

interface TeamMembershipRow {
  team_id: string
  role: string
  teams: { id: string; name: string; kind: string; created_at: string } | null
}

/**
 * POST /api/team/invite
 * Invite a consultant to a byrå team (WL-08 invite unfreeze).
 *
 * Gates, in order:
 *   - authenticated (MFA enforced by requireAuth on hosted)
 *   - the target team is kind='byra' (personal teams keep the legacy 403)
 *   - the caller is team owner or admin
 *
 * Team-scoped rather than company-scoped (requireAuth, not withRouteContext):
 * a byrå admin's active company is irrelevant to team membership, mirroring
 * GET /api/team/members.
 *
 * The invitation email is sent in the byrå team's brand (WL-13): sender
 * identity via getSenderForBrand(resolveBrandForTeam(teamId)) and the accept
 * link on the brand's home domain, canonical for brandless teams. A send
 * failure never fails the invite (email_sent: false + the link is returned,
 * so the inviter can always share it directly).
 */
export async function POST(request: NextRequest) {
  const { user, error } = await requireAuth()
  if (error) return error

  const validation = await validateBody(request, InviteSchema, {
    operation: 'team.invite',
  })
  if (!validation.success) return validation.response
  const { email, role, teamId: requestedTeamId } = validation.data

  const serviceClient = createServiceClient()

  // All of the caller's team memberships, with the team kind: the one-team-
  // per-user assumption is gone (a consultant sits in their own personal team
  // AND the byrå team).
  const { data: memberships } = await serviceClient
    .from('team_members')
    .select('team_id, role, teams:team_id(id, name, kind, created_at)')
    .eq('user_id', user.id)

  const rows = (memberships ?? []) as unknown as TeamMembershipRow[]

  let target: TeamMembershipRow | undefined
  if (requestedTeamId) {
    target = rows.find((m) => m.team_id === requestedTeamId)
    if (!target) {
      return NextResponse.json({ error: 'Team hittades inte.' }, { status: 404 })
    }
  } else {
    // Default target: the caller's byrå team when one exists. Deterministic
    // tie-break by team creation time for the (unexpected) multi-byrå case.
    target = rows
      .filter((m) => m.teams?.kind === 'byra')
      .sort((a, b) => (a.teams?.created_at ?? '').localeCompare(b.teams?.created_at ?? ''))[0]
  }

  // Kind gate: invites exist for byrå teams only. A personal-team target (or
  // no byrå membership at all) gets the exact legacy message.
  if (!target || target.teams?.kind !== 'byra') {
    return NextResponse.json({ error: PERSONAL_TEAM_MESSAGE }, { status: 403 })
  }

  // Role gate: team owner/admin may invite; members may not.
  if (!['owner', 'admin'].includes(target.role)) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  const teamId = target.team_id

  // Already a member? (profiles.email is lowercased like the schema output.)
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (profile) {
    const { data: existingMember } = await serviceClient
      .from('team_members')
      .select('id')
      .eq('team_id', teamId)
      .eq('user_id', (profile as { id: string }).id)
      .maybeSingle()
    if (existingMember) {
      return NextResponse.json({ error: 'Denna person är redan medlem.' }, { status: 409 })
    }
  }

  // Existing invitation for (team, email): a live pending one blocks; a
  // spent or expired one is re-issued in place (unique constraint on the pair).
  const { data: existingInvite } = await serviceClient
    .from('team_invitations')
    .select('id, status, expires_at')
    .eq('team_id', teamId)
    .eq('email', email)
    .maybeSingle()

  const existing = existingInvite as
    | { id: string; status: string; expires_at: string }
    | null

  if (
    existing &&
    existing.status === 'pending' &&
    new Date(existing.expires_at) > new Date()
  ) {
    return NextResponse.json(
      { error: 'En inbjudan har redan skickats till denna e-post.' },
      { status: 409 },
    )
  }

  const { token, hash } = generateInviteToken()
  const expiresAt = getInviteExpiry()

  let invitationId: string
  if (existing) {
    const { data: updated, error: updateError } = await serviceClient
      .from('team_invitations')
      .update({
        role,
        token_hash: hash,
        invited_by: user.id,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })
      .eq('id', existing.id)
      .select('id')
      .single()
    if (updateError || !updated) {
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
    invitationId = (updated as { id: string }).id
  } else {
    const { data: inserted, error: insertError } = await serviceClient
      .from('team_invitations')
      .insert({
        team_id: teamId,
        email,
        role,
        token_hash: hash,
        invited_by: user.id,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single()
    if (insertError || !inserted) {
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
    invitationId = (inserted as { id: string }).id
  }

  // Brand mail (WL-13) via the shared helper: the byrå team's brand drives
  // sender identity and the accept link's base URL; a brandless team gets the
  // canonical URL and the platform sender exactly as before. Non-blocking: a
  // failed send leaves the invitation valid and surfaces email_sent: false so
  // the inviter knows to share the link directly.
  const { inviteUrl, emailSent } = await sendTeamInviteMail({
    teamId,
    email,
    inviterEmail: user.email || '',
    token,
  })

  return NextResponse.json({
    data: {
      id: invitationId,
      teamId,
      email,
      role,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
      email_sent: emailSent,
      // The accept link is always returned so the inviter can share it
      // directly, e.g. when the mail bounced or the service is unconfigured.
      inviteUrl,
    },
  })
}
