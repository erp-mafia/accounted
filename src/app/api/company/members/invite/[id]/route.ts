import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getMultiUserState } from '@/lib/entitlements/multi-user'
import { sendCompanyInviteMail } from '@/lib/email/send-company-invite'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'

// Loads the email extension so the re-send path gets the Resend
// implementation instead of the noop default (same as POST
// /api/company/members/invite).
ensureInitialized()

interface CompanyInviteRow {
  id: string
  company_id: string
  email: string
  role: string
  status: string
}

/**
 * Shared gate chain for acting on an existing company invitation (revoke and
 * re-send): the caller must be owner/admin of the active company, and the
 * invitation must belong to that company. Returns the invitation row or the
 * error response to bubble. The role gate runs first, so a caller without
 * the right cannot probe which invitation ids exist.
 */
async function loadInviteForManagement(
  serviceClient: ReturnType<typeof createServiceClient>,
  companyId: string,
  userId: string,
  inviteId: string,
): Promise<{ invitation: CompanyInviteRow } | { response: NextResponse }> {
  const { data: callerMembership } = await serviceClient
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .single()

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
    return { response: NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 }) }
  }

  const { data: invitation } = await serviceClient
    .from('company_invitations')
    .select('id, company_id, email, role, status')
    .eq('id', inviteId)
    .eq('company_id', companyId)
    .single()

  if (!invitation) {
    return { response: NextResponse.json({ error: 'Inbjudan hittades inte.' }, { status: 404 }) }
  }

  return { invitation: invitation as CompanyInviteRow }
}

/**
 * POST /api/company/members/invite/[id]
 * Re-send a pending company invitation (crm#241: an expired invitation could
 * only be replaced by revoking it and inviting the same person again).
 *
 * Same gates as DELETE. Only pending invitations can be re-sent; an expired
 * pending one is revived. The token and expiry are re-issued in place, which
 * also invalidates any previously mailed link. A company whose multi-user
 * seat is frozen cannot re-send either: reviving an invitation is inviting
 * again, and POST /api/company/members/invite refuses that in the same state.
 * The response mirrors that route so the client gets a fresh shareable
 * inviteUrl whether or not the mail went out.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company_members.resend_invite',
  async (request, ctx, { params }) => {
    const { companyId, user, log } = ctx
    const { id: inviteId } = await params
    const serviceClient = createServiceClient()

    const loaded = await loadInviteForManagement(serviceClient, companyId, user.id, inviteId)
    if ('response' in loaded) return loaded.response
    const { invitation } = loaded

    if (invitation.status !== 'pending') {
      return NextResponse.json({ error: 'Inbjudan är inte längre aktiv.' }, { status: 409 })
    }

    // Same envelope as the invite route's seat gate so the UI upsells the
    // same way.
    const multiUserAccess = await getMultiUserState(serviceClient, companyId)
    if (multiUserAccess.state === 'frozen') {
      return NextResponse.json(
        {
          error: 'Bjud in fler personer med betald plan.',
          error_en: 'Invite more people with a paid plan.',
          capability_blocked: true,
          capability: CAPABILITY.multi_user,
        },
        { status: 403 },
      )
    }

    const { data: company } = await serviceClient
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .single()

    // Resolved before the token is rotated: a failed brand lookup (retryable
    // 503) must not kill the link the invitee already holds without mailing
    // a new one.
    const appOrigin = await resolveRequestAppOrigin(request)

    const { token, hash } = generateInviteToken()
    const expiresAt = getInviteExpiry()

    const { error: updateError } = await serviceClient
      .from('company_invitations')
      .update({
        token_hash: hash,
        invited_by: user.id,
        expires_at: expiresAt.toISOString(),
      })
      .eq('id', invitation.id)
      .eq('company_id', companyId)

    if (updateError) {
      return NextResponse.json({ error: 'Kunde inte skicka om inbjudan.' }, { status: 500 })
    }

    const { inviteUrl, emailSent } = await sendCompanyInviteMail({
      companyId,
      companyName: company?.name,
      email: invitation.email,
      inviterEmail: user.email || '',
      token,
      appOrigin,
      log,
    })

    return NextResponse.json({
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
        email_sent: emailSent,
        // Always returned so the inviter can share the link directly when the
        // mail did not go out (or never arrives).
        inviteUrl,
      },
    })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/company/members/invite/[id]
 * Revoke a pending company invitation.
 * Only company owners and admins can revoke.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company_members.revoke_invite',
  async (_request, ctx, { params }) => {
    const { companyId, user } = ctx
    const { id: inviteId } = await params
    const serviceClient = createServiceClient()

    const loaded = await loadInviteForManagement(serviceClient, companyId, user.id, inviteId)
    if ('response' in loaded) return loaded.response
    const { invitation } = loaded

    if (invitation.status !== 'pending') {
      return NextResponse.json({ error: 'Inbjudan är inte väntande.' }, { status: 400 })
    }

    // Revoke the invitation
    const { error } = await serviceClient
      .from('company_invitations')
      .update({ status: 'revoked' })
      .eq('id', inviteId)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte återkalla inbjudan.' }, { status: 500 })
    }

    return NextResponse.json({ data: { revoked: inviteId } })
  },
  { requireWrite: true },
)
