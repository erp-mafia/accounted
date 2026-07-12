import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * DELETE /api/company/members/[id]
 * Remove a member from the current company.
 * Only company owners and admins can remove members.
 * Cannot remove team-sourced members (they must be removed from the team).
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company_members.remove',
  async (_request, ctx, { params }) => {
  const { companyId, user } = ctx
  const { id: memberId } = await params
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

  // Look up the member (source column may not exist if migration not yet applied)
  let member: { id: string; user_id: string; role: string; source?: string } | null = null

  const { data: memberWithSource } = await serviceClient
    .from('company_members')
    .select('id, user_id, role, source')
    .eq('id', memberId)
    .eq('company_id', companyId)
    .single()

  if (memberWithSource) {
    member = memberWithSource
  } else {
    const { data: memberFallback } = await serviceClient
      .from('company_members')
      .select('id, user_id, role')
      .eq('id', memberId)
      .eq('company_id', companyId)
      .single()
    member = memberFallback ? { ...memberFallback, source: 'direct' } : null
  }

  if (!member) {
    return NextResponse.json({ error: 'Medlem hittades inte.' }, { status: 404 })
  }

  if (member.user_id === user.id) {
    return NextResponse.json({ error: 'Du kan inte ta bort dig själv.' }, { status: 400 })
  }

  if (member.role === 'owner') {
    return NextResponse.json({ error: 'Ägaren kan inte tas bort.' }, { status: 400 })
  }

  if (member.source === 'team') {
    return NextResponse.json({
      error: 'Denna medlem läggs till via teamet. Ta bort från teamet istället.',
    }, { status: 400 })
  }

  const { error } = await serviceClient
    .from('company_members')
    .delete()
    .eq('id', memberId)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: 'Kunde inte ta bort medlem.' }, { status: 500 })
  }

  return NextResponse.json({ data: { removed: memberId } })
  },
  { requireWrite: true },
)
