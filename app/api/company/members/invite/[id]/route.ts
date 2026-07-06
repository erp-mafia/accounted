import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

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
  const serviceClient = await createServiceClient()

  // Check caller has permission
  const { data: callerMembership } = await serviceClient
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .single()

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
    return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
  }

  // Look up the invitation
  const { data: invitation } = await serviceClient
    .from('company_invitations')
    .select('id, company_id, status')
    .eq('id', inviteId)
    .eq('company_id', companyId)
    .single()

  if (!invitation) {
    return NextResponse.json({ error: 'Inbjudan hittades inte.' }, { status: 404 })
  }

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
