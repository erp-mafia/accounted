import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import { filterTeamClientCompanyIds } from '@/lib/company/member-company-access'

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

type InvitationTable = 'company_invitations' | 'team_invitations'

/** What a membership insert answers: its row when one was asked for, or its error. */
interface MembershipInsertResult {
  data: unknown
  error: { code?: string } | null
}

/**
 * What spending an invitation came to.
 *
 * - `accepted`        this call claimed the invitation and created the membership.
 * - `already_member`  this call claimed it and the membership already existed
 *                     (23505): the invitation is fulfilled and stays spent.
 * - `gone`            the claim found nothing to take: the invitation was
 *                     accepted, revoked or expired after it was read. Nothing
 *                     was created.
 * - `error`           the claim or the membership insert failed. Nothing was
 *                     created, and a claim that was taken has been given back.
 */
type InvitationRedeemOutcome =
  | { status: 'accepted'; membership: unknown }
  | { status: 'already_member' }
  | { status: 'gone' }
  | { status: 'error' }

/**
 * Claim a pending invitation: the one write that spends its token.
 *
 * An invitation link is an out-of-band verifier, and a verifier is used once
 * (CASA 1.3.2). Every acceptance path used to read the row, see `pending`,
 * create the membership and only then write `accepted`, with nothing tying
 * the last write to the first read: two requests carrying the same token both
 * passed the read, and only the unique membership constraint kept the second
 * from doing anything. The transition is now the gate itself. One UPDATE
 * moves the row from `pending` to `accepted` only while it is still pending
 * and unexpired, and returns the row it moved; Postgres lets exactly one of
 * two concurrent statements match. No row back means there was nothing left
 * to spend, and the caller creates nothing.
 */
async function claimPendingInvitation(
  serviceClient: SupabaseClient,
  table: InvitationTable,
  invitationId: string,
): Promise<'claimed' | 'gone' | 'error'> {
  try {
    const { data, error } = await serviceClient
      .from(table)
      .update({ status: 'accepted' })
      .eq('id', invitationId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .select('id')

    if (error) {
      console.error('[pending-invites] invitation claim failed', { table, invitationId, error })
      return 'error'
    }
    return Array.isArray(data) && data.length > 0 ? 'claimed' : 'gone'
  } catch (err) {
    console.error('[pending-invites] invitation claim failed', { table, invitationId, error: err })
    return 'error'
  }
}

/**
 * Give a claim back: the membership it was taken for could not be created, so
 * the invitation is pending again and its link still works. Only the row this
 * request moved to `accepted` is touched; an invitation re-issued in between
 * is already pending and matches nothing.
 *
 * The claim and the membership are two statements, so this is a compensation,
 * not a rollback. If it fails too, the invitation is left spent with no
 * membership: logged as an error, and healed by the inviter inviting the
 * address again (both invite routes re-issue a spent invitation in place).
 */
async function releaseInvitationClaim(
  serviceClient: SupabaseClient,
  table: InvitationTable,
  invitationId: string,
): Promise<void> {
  try {
    const { error } = await serviceClient
      .from(table)
      .update({ status: 'pending' })
      .eq('id', invitationId)
      .eq('status', 'accepted')
    if (!error) return
    console.error(
      '[pending-invites] could not give the invitation claim back: it is spent without a membership',
      { table, invitationId, error },
    )
  } catch (err) {
    console.error(
      '[pending-invites] could not give the invitation claim back: it is spent without a membership',
      { table, invitationId, error: err },
    )
  }
}

/**
 * Spend an invitation on one membership: claim it, create the membership, and
 * give the claim back if the membership could not be created.
 *
 * The order is the point. Claiming first is what makes a second use of the
 * token create nothing; giving the claim back on a failed insert is what
 * keeps a failure from stranding the invitation as accepted with nobody
 * joined. A membership that already exists (23505) fulfils the invitation,
 * so the claim stands. Never throws.
 */
async function redeemInvitation(
  serviceClient: SupabaseClient,
  table: InvitationTable,
  invitationId: string,
  insertMembership: () => PromiseLike<MembershipInsertResult>,
): Promise<InvitationRedeemOutcome> {
  const claim = await claimPendingInvitation(serviceClient, table, invitationId)
  if (claim === 'gone') return { status: 'gone' }
  if (claim === 'error') return { status: 'error' }

  let inserted: MembershipInsertResult
  try {
    inserted = await insertMembership()
  } catch (err) {
    // Thrown instead of answered: a failed insert all the same.
    console.error('[pending-invites] membership insert failed', err)
    await releaseInvitationClaim(serviceClient, table, invitationId)
    return { status: 'error' }
  }

  if (!inserted.error) return { status: 'accepted', membership: inserted.data }
  if (inserted.error.code === '23505') return { status: 'already_member' }

  console.error('[pending-invites] membership insert failed', inserted.error)
  await releaseInvitationClaim(serviceClient, table, invitationId)
  return { status: 'error' }
}

/**
 * Redeem a company invitation for a user: the single claim-then-join used by
 * POST /api/team/accept, the auth callback and the onboarding recovery below.
 * The caller has already checked what only it can answer (the invitation is
 * pending and unexpired, and its address is the signed-in user's); this
 * spends the token and creates the direct membership, or does neither.
 */
export async function redeemCompanyInvitation(
  serviceClient: SupabaseClient,
  userId: string,
  invite: { id: string; company_id: string; role: string },
): Promise<InvitationRedeemOutcome['status']> {
  const outcome = await redeemInvitation(serviceClient, 'company_invitations', invite.id, () =>
    serviceClient.from('company_members').insert({
      company_id: invite.company_id,
      user_id: userId,
      role: invite.role,
      source: 'direct',
    }),
  )
  return outcome.status
}

/**
 * Retry invite acceptance from a raw `gnubok-invite-token` cookie value.
 * Mirrors the acceptance in POST /api/team/accept: requires a pending,
 * unexpired invitation whose email matches the authenticated user, and
 * spends it through the same claim (redeemCompanyInvitation).
 * Returns true when the user is now a member of the invited company
 * (including the already-a-member case, which settles the invitation as
 * accepted). Never throws; failures, and a claim another request won, return
 * false and leave the normal onboarding flow to render.
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

    // Claim, then join. An existing membership fulfils the invitation and
    // counts as success; a lost claim or a failed insert created nothing.
    const outcome = await redeemCompanyInvitation(serviceClient, user.id, invite)
    if (outcome !== 'accepted' && outcome !== 'already_member') return false

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
 * authenticated user. Claims the invitation (the same single-use claim as a
 * company invitation), inserts `team_members` with the capped role (invites
 * never mint owners), grants the invitation's chosen companies when it names
 * some, and points a company-less user at the first company they can reach.
 * A claim another request won reads as `invalid`, the answer for any
 * invitation that is no longer pending. Never throws.
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
      .select('id, team_id, email, role, status, expires_at, company_ids, teams:team_id(name, kind)')
      .eq('token_hash', tokenHash)
      .single()

    const invite = inviteRaw as unknown as {
      id: string
      team_id: string
      email: string
      role: string
      status: string
      expires_at: string
      company_ids: string[] | null
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
    // Chosen companies apply to members only (owners and admins always have
    // every company); NULL means all, as before.
    const chosenIds =
      memberRole === 'member' && invite.company_ids && invite.company_ids.length > 0
        ? invite.company_ids
        : null

    // Claim, then join. The claim is what spends the token: a second use of
    // it finds nothing to claim and inserts nothing.
    const redeemed = await redeemInvitation(serviceClient, 'team_invitations', invite.id, () =>
      serviceClient
        .from('team_members')
        .insert({
          team_id: invite.team_id,
          user_id: user.id,
          role: memberRole,
          all_companies: chosenIds === null,
        })
        .select('id')
        .single(),
    )

    // Lost claim: the invitation is no longer pending.
    if (redeemed.status === 'gone') return { status: 'invalid' }
    if (redeemed.status === 'error') return { status: 'error' }
    // 23505 = already a member: the invitation is fulfilled and stays spent.
    // Reported on its own to keep the route's long-standing 409 contract; the
    // caller still treats it as success because the membership exists.
    if (redeemed.status === 'already_member') return { status: 'already_member' }
    const memberRow = redeemed.membership

    // The chosen companies still on the team: one archived or moved since the
    // invitation was sent is dropped rather than failing the acceptance. A
    // failed grant leaves the member in the byrå without companies, which the
    // byrå sees and can fix: it never falls back to every company.
    let grantedIds: string[] | null = null
    if (chosenIds) {
      grantedIds = []
      try {
        const stillOnTeam = await filterTeamClientCompanyIds(serviceClient, invite.team_id, chosenIds)
        const memberId = (memberRow as { id: string } | null)?.id
        if (!memberId) throw new Error('team membership insert returned no id')
        if (stillOnTeam.length > 0) {
          const { error: grantError } = await serviceClient.rpc('set_team_member_companies', {
            p_team_member_id: memberId,
            p_company_ids: stillOnTeam,
          })
          if (grantError) throw grantError
          grantedIds = stillOnTeam
        }
      } catch (err) {
        console.error('[pending-invites] granting the chosen companies failed', err)
      }
    }

    // Point a company-less user at one of the companies they can reach so
    // their first dashboard load resolves. A consultant with their own firma
    // keeps their active company untouched: joining a byrå must never hijack
    // the context.
    const { data: prefs } = await serviceClient
      .from('user_preferences')
      .select('active_company_id')
      .eq('user_id', user.id)
      .maybeSingle()

    const hasActiveCompany = !!(prefs as { active_company_id: string | null } | null)?.active_company_id
    if (!hasActiveCompany && grantedIds?.length !== 0) {
      let firstCompanyQuery = serviceClient
        .from('companies')
        .select('id')
        .eq('team_id', invite.team_id)
        .is('archived_at', null)
      if (grantedIds) firstCompanyQuery = firstCompanyQuery.in('id', grantedIds)
      const { data: firstCompany } = await firstCompanyQuery
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
