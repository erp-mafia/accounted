import { createServiceClient } from '@/lib/supabase/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'

/**
 * Invite-recovery helpers for the onboarding surfaces.
 *
 * An invited user is supposed to be attached to the company by one of the
 * client flows (invite page one-click join, login/register/mfa cookie
 * handling) or by the auth callback. When all of those miss (confirmation
 * link opened on another device, cookie expired, transient failure), the
 * user lands on /onboarding or /select-company as an apparent first-timer.
 * These helpers let those pages heal the miss instead of funneling a
 * confused invitee into creating a company.
 */

interface AuthUserLike {
  id: string
  email?: string | null
}

/**
 * Retry invite acceptance from a raw `gnubok-invite-token` cookie value.
 * Mirrors the acceptance in POST /api/team/accept: requires a pending,
 * unexpired invitation whose email matches the authenticated user.
 * Returns true when the user is now a member of the invited company
 * (including the already-a-member case, which it settles by marking the
 * invitation accepted). Never throws; failures return false and leave the
 * normal onboarding flow to render.
 */
export async function acceptPendingInviteByToken(
  user: AuthUserLike,
  token: string,
): Promise<boolean> {
  if (!user.email) return false

  try {
    const serviceClient = createServiceClient()
    const tokenHash = hashInviteToken(token)

    const { data: invite } = await serviceClient
      .from('company_invitations')
      .select('id, company_id, email, role, status, expires_at')
      .eq('token_hash', tokenHash)
      .single()

    if (
      !invite ||
      invite.status !== 'pending' ||
      new Date(invite.expires_at) < new Date() ||
      user.email.toLowerCase() !== invite.email.toLowerCase()
    ) {
      // Not a (valid) company invite for this token: it may be a byrå-team
      // invite. Trying the team path here is what lets /onboarding and
      // /select-company heal a byrå invitee who reached them without
      // membership, instead of funneling them into creating a company.
      const teamOutcome = await acceptPendingTeamInviteByToken(user, token)
      return teamOutcome.status === 'accepted' || teamOutcome.status === 'already_member'
    }

    const { error: memberError } = await serviceClient.from('company_members').insert({
      company_id: invite.company_id,
      user_id: user.id,
      role: invite.role,
      source: 'direct',
    })

    // 23505 = already a member: the invitation is fulfilled, settle it below.
    if (memberError && memberError.code !== '23505') {
      console.error('[pending-invites] membership insert failed', memberError)
      return false
    }

    // Non-fatal on failure: middleware falls back to the membership.
    const { error: prefError } = await serviceClient
      .from('user_preferences')
      .upsert(
        { user_id: user.id, active_company_id: invite.company_id },
        { onConflict: 'user_id' },
      )
    if (prefError) {
      console.error('[pending-invites] failed to set active company', prefError)
    }

    await serviceClient
      .from('company_invitations')
      .update({ status: 'accepted' })
      .eq('id', invite.id)

    return true
  } catch (err) {
    console.error('[pending-invites] acceptance retry failed', err)
    return false
  }
}

/**
 * Outcome of a byrå-team invite acceptance attempt. The route maps each to an
 * HTTP status; the callback and the onboarding recovery treat `accepted` and
 * `already_member` as success (the user is in the team either way).
 */
export type TeamInviteAcceptOutcome =
  | { status: 'accepted'; teamId: string; teamName: string | null }
  | { status: 'already_member' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'wrong_email' }
  | { status: 'error' }

/**
 * Accept a pending byrå-team invitation from a raw `gnubok-invite-token`.
 *
 * The single server-side implementation of team-invite acceptance, shared by
 * POST /api/team/accept, the auth callback, and the onboarding/select-company
 * recovery nets. Before this existed, only the route understood
 * `team_invitations`, so a byrå staffer who signed up with email+password
 * (hosted requires email confirmation, so the register page never gets a
 * session to run its client-side accept) had their invite accepted by no
 * server path before the dashboard, and landed on /onboarding as an apparent
 * first-timer.
 *
 * Mirrors the company-invite acceptance above: requires a pending, unexpired
 * invitation on a team whose `kind='byra'`, whose email matches the
 * authenticated user. Inserts `team_members` with the capped role (invites
 * never mint owners), points a company-less user at the team's first
 * non-archived company, and marks the invite accepted. Never throws.
 */
export async function acceptPendingTeamInviteByToken(
  user: AuthUserLike,
  token: string,
): Promise<TeamInviteAcceptOutcome> {
  if (!user.email) return { status: 'invalid' }

  try {
    const serviceClient = createServiceClient()
    const tokenHash = hashInviteToken(token)

    const { data: inviteRaw } = await serviceClient
      .from('team_invitations')
      .select('id, team_id, email, role, status, expires_at, teams:team_id(name, kind)')
      .eq('token_hash', tokenHash)
      .single()

    const invite = inviteRaw as unknown as {
      id: string
      team_id: string
      email: string
      role: string
      status: string
      expires_at: string
      teams: { name: string; kind: string } | null
    } | null

    // Kind gate mirrors the route: invitations exist for byrå teams only. A
    // personal-team token (or a team reverted after issue) is indistinguishable
    // from an invalid token on purpose.
    if (!invite || invite.teams?.kind !== 'byra' || invite.status !== 'pending') {
      return { status: 'invalid' }
    }

    if (new Date(invite.expires_at) < new Date()) {
      await serviceClient
        .from('team_invitations')
        .update({ status: 'expired' })
        .eq('id', invite.id)
      return { status: 'expired' }
    }

    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return { status: 'wrong_email' }
    }

    // Invitations never mint team owners (the invite route's schema forbids it;
    // re-checked here against hand-edited rows).
    const memberRole = invite.role === 'admin' ? 'admin' : 'member'

    const { error: memberError } = await serviceClient.from('team_members').insert({
      team_id: invite.team_id,
      user_id: user.id,
      role: memberRole,
    })

    if (memberError) {
      // 23505 = already a member. Left unsettled to preserve the route's
      // long-standing 409 contract; the caller still treats it as success
      // because the membership exists.
      if (memberError.code === '23505') return { status: 'already_member' }
      console.error('[pending-invites] team membership insert failed', memberError)
      return { status: 'error' }
    }

    // Point a company-less user at one of the team's companies so their first
    // dashboard load resolves. A consultant with their own firma keeps their
    // active company untouched: joining a byrå must never hijack the context.
    const { data: prefs } = await serviceClient
      .from('user_preferences')
      .select('active_company_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!(prefs as { active_company_id: string | null } | null)?.active_company_id) {
      const { data: firstCompany } = await serviceClient
        .from('companies')
        .select('id')
        .eq('team_id', invite.team_id)
        .is('archived_at', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (firstCompany) {
        const { error: prefError } = await serviceClient
          .from('user_preferences')
          .upsert(
            { user_id: user.id, active_company_id: (firstCompany as { id: string }).id },
            { onConflict: 'user_id' },
          )
        if (prefError) {
          console.error('[pending-invites] failed to set active company', prefError)
        }
      }
    }

    await serviceClient
      .from('team_invitations')
      .update({ status: 'accepted' })
      .eq('id', invite.id)

    return {
      status: 'accepted',
      teamId: invite.team_id,
      teamName: invite.teams?.name ?? null,
    }
  } catch (err) {
    console.error('[pending-invites] team acceptance retry failed', err)
    return { status: 'error' }
  }
}

/**
 * True when a pending, unexpired invitation exists for this email, in EITHER
 * the company or the byrå-team invite table. Invitation emails are lowercased
 * at creation (invite route Zod schema), so the lowercase equality match is
 * exact. Used to tell an invitee who arrived without the invite token ("go
 * open the link in the email") apart from a genuine first-time user. Never
 * throws.
 */
export async function hasPendingInviteForEmail(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const nowIso = new Date().toISOString()
  try {
    const serviceClient = createServiceClient()

    const { data: companyInvites } = await serviceClient
      .from('company_invitations')
      .select('id')
      .eq('email', normalized)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .limit(1)

    if ((companyInvites ?? []).length > 0) return true

    // Byrå-team invites are the other kind an invitee can arrive on: without
    // this a tokenless byrå invitee is misread as a first-timer and funneled
    // into creating a company.
    const { data: teamInvites } = await serviceClient
      .from('team_invitations')
      .select('id')
      .eq('email', normalized)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .limit(1)

    return (teamInvites ?? []).length > 0
  } catch (err) {
    console.error('[pending-invites] pending lookup failed', err)
    return false
  }
}
