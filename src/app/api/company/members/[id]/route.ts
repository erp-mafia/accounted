import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CompanyRoleChangeSchema } from '@/lib/company/member-roles'
import { COMPANY_ADMIN_ROLES } from '@/lib/operations/access'

interface CompanyMemberRow {
  id: string
  user_id: string
  role: string
  source?: string
  /** Set when the row was read without its source column (the fallback lookup). */
  source_unknown?: boolean
}

/**
 * Shared gate chain for acting on one member of the active company (remove
 * and role change): the caller must hold one of `callerRoles` in the company
 * (owner or admin to remove, owner to change a role), and the member must
 * belong to it. Returns the member row or the error response to
 * bubble. The role gate runs first, so a caller without the right cannot
 * probe which member ids exist.
 */
async function loadMemberForManagement(
  serviceClient: ReturnType<typeof createServiceClient>,
  companyId: string,
  userId: string,
  memberId: string,
  callerRoles: readonly string[] = ['owner', 'admin'],
): Promise<{ member: CompanyMemberRow } | { response: NextResponse }> {
  const { data: callerMembership } = await serviceClient
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .single()

  if (!callerMembership || !callerRoles.includes(callerMembership.role)) {
    return { response: NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 }) }
  }

  // Look up the member (source column may not exist if migration not yet applied)
  let member: CompanyMemberRow | null = null

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
    member = memberFallback ? { ...memberFallback, source: 'direct', source_unknown: true } : null
  }

  if (!member) {
    return { response: NextResponse.json({ error: 'Medlem hittades inte.' }, { status: 404 }) }
  }

  return { member }
}

/**
 * PATCH /api/company/members/[id]
 * Change the role of a member of the current company, to one of the roles an
 * invitation can grant (lib/company/member-roles.ts). Only the company's
 * owner may change a member's role, the rule the BEFORE UPDATE trigger
 * enforce_company_member_role_transitions holds for a user's own session
 * ("Only owners can change member roles"); the member must belong to the
 * company. An admin still removes and invites as before.
 *
 * Refused:
 *   - a role outside the grantable ones, owner included (400): no grant
 *     reaches above admin, so nobody raises a member above their own role
 *   - the caller's own row (400)
 *   - the owner's row (400): the owner role is not changed here
 *   - a team-sourced row (400): its role follows the team role
 *     (team_member_sync_role_update), so it is changed in the team
 *   - demoting the company's last owner or admin (409)
 *
 * The write goes through the service client, as remove does, so the route
 * holds the trigger's owner-only rule itself (the trigger lets service-role
 * writes through).
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company_members.update_role',
  async (request, ctx, { params }) => {
    const { companyId, user, log } = ctx
    const { id: memberId } = await params
    const validation = await validateBody(request, CompanyRoleChangeSchema, {
      log,
      operation: 'company_members.update_role',
    })
    if (!validation.success) return validation.response
    const { role: newRole } = validation.data

    const serviceClient = createServiceClient()
    const loaded = await loadMemberForManagement(serviceClient, companyId, user.id, memberId, ['owner'])
    if ('response' in loaded) return loaded.response
    const { member } = loaded

    if (member.user_id === user.id) {
      return NextResponse.json({ error: 'Du kan inte ändra din egen roll.' }, { status: 400 })
    }

    if (member.role === 'owner') {
      return NextResponse.json({ error: 'Ägarens roll kan inte ändras här.' }, { status: 400 })
    }

    if (member.source === 'team') {
      return NextResponse.json({
        error: 'Denna medlem läggs till via teamet. Ändra rollen i teamet istället.',
      }, { status: 400 })
    }
    // A row whose source could not be read (the lookup's fallback) might be a
    // team row, whose role the team sync would overwrite: refuse, fail closed.
    if (member.source_unknown) {
      return NextResponse.json({ error: 'Kunde inte ändra rollen.' }, { status: 500 })
    }

    const result = { data: { id: member.id, user_id: member.user_id, role: newRole } }
    // No-op: nothing to write.
    if (member.role === newRole) return NextResponse.json(result)

    // An admin leaving the admin role: someone must still manage the company.
    if (member.role === 'admin') {
      const { count, error: countError } = await serviceClient
        .from('company_members')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('role', [...COMPANY_ADMIN_ROLES])
      if (countError || count === null) {
        return NextResponse.json({ error: 'Kunde inte ändra rollen.' }, { status: 500 })
      }
      if (count <= 1) {
        return NextResponse.json(
          { error: 'Företaget måste ha minst en ägare eller administratör.' },
          { status: 409 },
        )
      }
    }

    const { error } = await serviceClient
      .from('company_members')
      .update({ role: newRole })
      .eq('id', member.id)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte ändra rollen.' }, { status: 500 })
    }

    log.info('company member role changed', { memberId: member.id, fromRole: member.role, toRole: newRole })
    return NextResponse.json(result)
  },
  { requireWrite: true, uuidParams: { id: 'NOT_FOUND' } },
)

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

  const loaded = await loadMemberForManagement(serviceClient, companyId, user.id, memberId)
  if ('response' in loaded) return loaded.response
  const { member } = loaded

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
