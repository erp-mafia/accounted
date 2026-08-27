import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

/**
 * Kept verbatim from the pre-unfreeze hardcoded 403: personal teams remain
 * single-user shells (WL-08), and this is the message their members still see.
 */
const PERSONAL_TEAM_MESSAGE = 'Team har bara en ägare och kan inte ändras.'

const RoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
})

interface TargetRow {
  id: string
  team_id: string
  user_id: string
  role: string
  teams: { kind: string } | null
}

/**
 * Shared gates for both verbs. Returns the target row and the caller's team
 * role, or the error response to short-circuit with:
 *   - 404 when the membership row does not exist
 *   - 403 (legacy message) when the row's team is not a byrå team
 *   - 403 when the caller is not owner/admin of that team
 */
async function resolveTargetAndCaller(
  serviceClient: ReturnType<typeof createServiceClient>,
  memberId: string,
  callerUserId: string,
): Promise<
  | { error: NextResponse; target?: undefined; callerRole?: undefined }
  | { error?: undefined; target: TargetRow; callerRole: 'owner' | 'admin' }
> {
  const { data } = await serviceClient
    .from('team_members')
    .select('id, team_id, user_id, role, teams:team_id(kind)')
    .eq('id', memberId)
    .maybeSingle()

  const target = data as unknown as TargetRow | null
  if (!target) {
    return { error: NextResponse.json({ error: 'Medlem hittades inte.' }, { status: 404 }) }
  }

  // Kind gate first: personal teams keep the exact legacy 403 (WL-08).
  if (target.teams?.kind !== 'byra') {
    return { error: NextResponse.json({ error: PERSONAL_TEAM_MESSAGE }, { status: 403 }) }
  }

  const { data: membership } = await serviceClient
    .from('team_members')
    .select('role')
    .eq('team_id', target.team_id)
    .eq('user_id', callerUserId)
    .maybeSingle()

  const callerRole = (membership as { role: string } | null)?.role
  if (callerRole !== 'owner' && callerRole !== 'admin') {
    return { error: NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 }) }
  }

  return { target, callerRole }
}

/** Count of owner rows in the team: the last-owner protections read this. */
async function countTeamOwners(
  serviceClient: ReturnType<typeof createServiceClient>,
  teamId: string,
): Promise<number> {
  const { count } = await serviceClient
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('team_id', teamId)
    .eq('role', 'owner')
  return count ?? 0
}

/**
 * PATCH /api/team/members/[id]
 * Change a byrå team member's role (WL-08 gap fix: the last frozen surface).
 *
 * Gates, in order: authenticated + MFA (withRouteContext), the membership's
 * team is kind='byra' (personal teams keep the legacy 403 verbatim), caller
 * is team owner/admin. Owner-role protections on top:
 *   - the owner role is only granted by an owner
 *   - an owner's role is only changed by an owner
 *   - the last owner can never be demoted (409)
 *
 * The route only writes team_members.role. Propagating the new role into
 * every client company's company_members rows is the job of the AFTER UPDATE
 * trigger team_member_sync_role_update (migration 20260826130100): same
 * owner/admin -> admin, member -> member mapping as the INSERT sync, and it
 * never mints a company owner. Deliberately not duplicated here.
 *
 * No requireWrite: that option gates on the caller's role in the ACTIVE
 * COMPANY, which is the wrong dimension for a team-scoped mutation (a byrå
 * owner may have any company active). The team owner/admin gate above is the
 * authorization.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'team_members.update_role',
  async (request, ctx, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RoleSchema, {
      operation: 'team_members.update_role',
    })
    if (!validation.success) return validation.response
    const { role: newRole } = validation.data

    const serviceClient = createServiceClient()
    const resolved = await resolveTargetAndCaller(serviceClient, id, ctx.user.id)
    if (resolved.error) return resolved.error
    const { target, callerRole } = resolved

    // Owner role is only granted by an owner.
    if (newRole === 'owner' && callerRole !== 'owner') {
      return NextResponse.json(
        { error: 'Endast en ägare kan utse en annan ägare.' },
        { status: 403 },
      )
    }

    // An owner's role is only changed by an owner (an admin must not be able
    // to demote the byrå's owners).
    if (target.role === 'owner' && callerRole !== 'owner') {
      return NextResponse.json(
        { error: 'Endast en ägare kan ändra en ägares roll.' },
        { status: 403 },
      )
    }

    // Demoting an owner: the team must keep at least one owner.
    if (target.role === 'owner' && newRole !== 'owner') {
      const owners = await countTeamOwners(serviceClient, target.team_id)
      if (owners <= 1) {
        return NextResponse.json(
          { error: 'Teamet måste ha minst en ägare.' },
          { status: 409 },
        )
      }
    }

    if (target.role === newRole) {
      // No-op: skip the write (and the re-sync cascade it would fire).
      return NextResponse.json({
        data: { id: target.id, user_id: target.user_id, team_id: target.team_id, role: newRole },
      })
    }

    const { error } = await serviceClient
      .from('team_members')
      .update({ role: newRole })
      .eq('id', target.id)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte ändra rollen.' }, { status: 500 })
    }

    return NextResponse.json({
      data: { id: target.id, user_id: target.user_id, team_id: target.team_id, role: newRole },
    })
  },
)

/**
 * DELETE /api/team/members/[id]
 * Remove a member from a byrå team (WL-08 gap fix).
 *
 * Same gates as PATCH. Protections: an owner is only removed by an owner, and
 * the last owner can never be removed (409).
 *
 * The route only deletes the team_members row. Cleaning the member out of
 * every client company is the job of the BEFORE DELETE trigger
 * team_member_sync_delete / remove_team_member_from_companies (migration
 * 20260331010000): it deletes the company_members rows with source='team' for
 * the team's companies and leaves source='direct' memberships untouched.
 * Deliberately not duplicated here.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'team_members.remove',
  async (_request, ctx, { params }) => {
    const { id } = await params

    const serviceClient = createServiceClient()
    const resolved = await resolveTargetAndCaller(serviceClient, id, ctx.user.id)
    if (resolved.error) return resolved.error
    const { target, callerRole } = resolved

    if (target.role === 'owner') {
      // Owners are only removed by owners; the last owner is never removed.
      if (callerRole !== 'owner') {
        return NextResponse.json(
          { error: 'Endast en ägare kan ta bort en ägare.' },
          { status: 403 },
        )
      }
      const owners = await countTeamOwners(serviceClient, target.team_id)
      if (owners <= 1) {
        return NextResponse.json(
          { error: 'Teamet måste ha minst en ägare.' },
          { status: 409 },
        )
      }
    }

    const { error } = await serviceClient
      .from('team_members')
      .delete()
      .eq('id', target.id)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte ta bort medlemmen.' }, { status: 500 })
    }

    return NextResponse.json({ data: { id: target.id, removed: true } })
  },
)
