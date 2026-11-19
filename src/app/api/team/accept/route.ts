import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import {
  acceptPendingTeamInviteByToken,
  redeemCompanyInvitation,
} from '@/lib/company/pending-invites'
import { readPreparedProfile } from '@/lib/company/client-profile'
import type { InviteGoneReason } from '@/lib/auth/invite-gone'
import { INVITE_TOKEN_HEADER } from '@/lib/auth/invite-token-header'

interface TeamInviteRow {
  id: string
  team_id: string
  email: string
  role: string
  status: string
  expires_at: string
  teams: { name: string; kind: string } | null
}

// One sentence per reason (lib/auth/invite-gone.ts); the invite page shows
// its own localized text and reads only `reason`.
const INVITE_GONE_MESSAGE: Record<InviteGoneReason, string> = {
  used: 'Inbjudan har redan använts. Var det du som tackade ja kan du logga in.',
  used_other_account:
    'Inbjudan har redan använts, och kontot du är inloggad med är inte med. Logga in med kontot som tackade ja eller be om en ny inbjudan.',
  revoked: 'Inbjudan har dragits tillbaka. Be den som bjöd in dig att skicka en ny.',
  expired: 'Inbjudan har gått ut. Be den som bjöd in dig att skicka en ny.',
}

function inviteGone(reason: InviteGoneReason) {
  return NextResponse.json({ error: INVITE_GONE_MESSAGE[reason], reason }, { status: 410 })
}

/**
 * The answer for an invitation whose status is no longer 'pending'. This
 * used to be one sentence, "Inbjudan har redan använts", for a revoked and
 * an expired invitation too, and it sent the person who had already joined
 * off to ask for a new one (for #206).
 *
 * The endpoint is public, so the answer carries the invitation's own state
 * and nothing about other people: no e-mail, no name, and what is being
 * joined only to the signed-in member the invitation made. Whether the
 * caller is that member is read from their own session: an invitation is
 * only ever accepted by the address it was sent to (POST checks it), so a
 * signed-in caller with that address who still holds the membership has
 * already joined, which is not an error.
 */
async function answerSettledInvite(
  serviceClient: ReturnType<typeof createServiceClient>,
  invite: { status: string; email: string },
  membership: { table: 'company_members' | 'team_members'; column: 'company_id' | 'team_id'; id: string },
  joined: { type: 'company' | 'team'; name: string },
) {
  if (invite.status === 'revoked') return inviteGone('revoked')
  if (invite.status === 'expired') return inviteGone('expired')

  // 'accepted'. An unreadable session is an anonymous caller: the answer
  // then says the least.
  const { user } = await requireAuth()
  if (!user) return inviteGone('used')

  if (user.email?.toLowerCase() === invite.email.toLowerCase()) {
    const { data: member } = await serviceClient
      .from(membership.table)
      .select('user_id')
      .eq(membership.column, membership.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (member) {
      return NextResponse.json({
        data: { type: joined.type, alreadyMember: true, companyName: joined.name },
      })
    }
  }
  return inviteGone('used_other_account')
}

/**
 * GET /api/team/accept, with the token in the X-Invite-Token header
 * Validates an invite token and returns invite info (for the invite page).
 * The token is read from the header only (lib/auth/invite-token-header.ts):
 * a request that carries `token` in its query string is refused, so the
 * token never lands in a URL this application serves (CASA 2.1.1). Every
 * answer is no-store: the URL is the same for every invitation now, so a
 * cache keyed on it must never keep one invitation's answer for the next.
 * Handles both company invitations and byrå-team invitations (WL-08 invite
 * unfreeze). Team invitations resolve only for teams with kind='byra':
 * personal teams are uninvitable, so a token pointing at one is invalid.
 * No auth required: this is a public endpoint. An invitation that is no
 * longer pending is answered by answerSettledInvite: 410 with a `reason`, or
 * 200 `alreadyMember` for the signed-in person who already joined.
 */
export async function GET(request: NextRequest) {
  const response = await describeInvitation(request)
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('Vary', INVITE_TOKEN_HEADER)
  return response
}

async function describeInvitation(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.searchParams.has('token')) {
    return NextResponse.json(
      { error: 'Ogiltig förfrågan: inbjudans kod skickas inte i adressen.' },
      { status: 400 },
    )
  }
  const token = request.headers.get(INVITE_TOKEN_HEADER)?.trim()
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  const { data: companyInvite } = await serviceClient
    .from('company_invitations')
    .select('id, email, status, expires_at, company_id, invited_by, companies:company_id(name)')
    .eq('token_hash', tokenHash)
    .single()

  if (companyInvite) {
    const companyName = (companyInvite.companies as unknown as { name: string })?.name || 'Företag'
    if (companyInvite.status !== 'pending') {
      return answerSettledInvite(
        serviceClient,
        companyInvite,
        { table: 'company_members', column: 'company_id', id: companyInvite.company_id },
        { type: 'company', name: companyName },
      )
    }

    const expired = new Date(companyInvite.expires_at) < new Date()

    // The profile the client's byrå prepared (Profiles and Suggestions), read
    // on its own so a failed read only leaves the line off the page.
    const [{ data: alreadyHasAccount }, preparedProfile] = await Promise.all([
      serviceClient.rpc('check_email_exists', { email_to_check: companyInvite.email }),
      readPreparedProfile(serviceClient, companyInvite.company_id, companyInvite.invited_by),
    ])

    return NextResponse.json({
      data: {
        type: 'company',
        companyName,
        email: companyInvite.email,
        expired,
        alreadyHasAccount,
        preparedProfile,
      },
    })
  }

  // No company invitation for this token: try byrå-team invitations.
  const { data: teamInviteRaw } = await serviceClient
    .from('team_invitations')
    .select('id, team_id, email, role, status, expires_at, teams:team_id(name, kind)')
    .eq('token_hash', tokenHash)
    .single()

  const teamInvite = teamInviteRaw as unknown as TeamInviteRow | null

  // Kind gate: invitations exist for byrå teams only. A personal-team token
  // (or a team whose kind was reverted after issue) is indistinguishable from
  // an invalid token on purpose.
  if (!teamInvite || teamInvite.teams?.kind !== 'byra') {
    return NextResponse.json({ error: 'Inbjudan hittades inte eller är ogiltig.' }, { status: 404 })
  }

  const teamName = teamInvite.teams?.name || 'Team'
  if (teamInvite.status !== 'pending') {
    return answerSettledInvite(
      serviceClient,
      teamInvite,
      { table: 'team_members', column: 'team_id', id: teamInvite.team_id },
      { type: 'team', name: teamName },
    )
  }

  const expired = new Date(teamInvite.expires_at) < new Date()

  const { data: alreadyHasAccount } = await serviceClient.rpc('check_email_exists', {
    email_to_check: teamInvite.email,
  })

  return NextResponse.json({
    data: {
      type: 'team',
      // companyName doubles as "what you are joining" for the invite page,
      // which renders it for every invite type: kept for compatibility.
      companyName: teamName,
      teamName,
      email: teamInvite.email,
      expired,
      alreadyHasAccount,
    },
  })
}

/**
 * POST /api/team/accept
 * Accepts a company or byrå-team invite after the user has signed up.
 *
 * An invitation is used once. Both kinds are spent through the same claim
 * (lib/company/pending-invites.ts): one conditional UPDATE moves the row from
 * pending to accepted and only the request that moved it creates a
 * membership. A second accept of the same token, concurrent or later, finds
 * nothing to claim, is refused as an invitation that is no longer pending,
 * and creates nothing.
 *
 * Team acceptance inserts a team_members row; the DB sync trigger
 * (sync_team_member_to_companies) then grants membership in every company
 * attached to the team, or the shared helper grants the invitation's chosen
 * companies, so no company_members writes happen here.
 */
export async function POST(request: NextRequest) {
  const { user, error } = await requireAuth()
  if (error) return error

  const body = await request.json()
  const token = body.token as string
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  const { data: companyInvite, error: companyLookupError } = await serviceClient
    .from('company_invitations')
    .select('id, company_id, email, role, status, expires_at')
    .eq('token_hash', tokenHash)
    .single()

  if (companyLookupError && companyLookupError.code !== 'PGRST116') {
    console.error('[team/accept] company lookup error:', companyLookupError.message)
  }

  if (companyInvite) {
    return acceptCompanyInvite(serviceClient, user, companyInvite)
  }

  // No company invitation for this token: try byrå-team invitations. The
  // acceptance itself lives in the shared helper (lib/company/pending-invites)
  // so the callback and onboarding recovery accept team invites the same way;
  // this route only maps the outcome onto its long-standing HTTP contract.
  const outcome = await acceptPendingTeamInviteByToken(user, token)
  switch (outcome.status) {
    case 'accepted':
      return NextResponse.json({
        data: { type: 'team', teamId: outcome.teamId, teamName: outcome.teamName },
      })
    case 'already_member':
      return NextResponse.json({ error: 'Du är redan medlem.' }, { status: 409 })
    case 'expired':
      return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
    case 'wrong_email':
      return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
    case 'error':
      return NextResponse.json({ error: 'Kunde inte lägga till medlem.' }, { status: 500 })
    case 'invalid':
    default:
      return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }
}

/**
 * Company-invite acceptance. The checks only this request can answer come
 * first (still pending, not expired, the signed-in account is the invited
 * address); then the invitation is claimed and the membership created, or
 * neither.
 */
async function acceptCompanyInvite(
  serviceClient: ReturnType<typeof createServiceClient>,
  user: { id: string; email?: string | null },
  companyInvite: {
    id: string
    company_id: string
    email: string
    role: string
    status: string
    expires_at: string
  },
) {
  if (companyInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }

  if (new Date(companyInvite.expires_at) < new Date()) {
    await serviceClient
      .from('company_invitations')
      .update({ status: 'expired' })
      .eq('id', companyInvite.id)
    return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
  }

  if (user.email?.toLowerCase() !== companyInvite.email.toLowerCase()) {
    return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
  }

  // Claim the invitation, then add the user to the company. The claim is
  // what spends the token: the status check above only reads, so two requests
  // can both pass it, but only one can move the row out of 'pending'.
  const outcome = await redeemCompanyInvitation(serviceClient, user.id, companyInvite)

  // Lost claim: accepted, revoked or expired since the read. The same answer
  // as any invitation that is no longer pending, and nothing was created.
  if (outcome === 'gone') {
    return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }
  // The membership already existed: the invitation is fulfilled and spent.
  if (outcome === 'already_member') {
    return NextResponse.json({ error: 'Du är redan medlem.' }, { status: 409 })
  }
  // The claim or the insert failed: no membership, and the invitation is
  // pending again so the link still works.
  if (outcome === 'error') {
    return NextResponse.json({ error: 'Kunde inte lägga till medlem.' }, { status: 500 })
  }

  // Set active company. Non-fatal on failure: the membership insert already
  // succeeded and middleware falls back to it, but log so silent
  // persistence failures (#701) are observable.
  const { error: prefError } = await serviceClient
    .from('user_preferences')
    .upsert({
      user_id: user.id,
      active_company_id: companyInvite.company_id,
    }, { onConflict: 'user_id' })

  if (prefError) {
    console.error('[team/accept] failed to set active company', prefError)
  }

  return NextResponse.json({
    data: { type: 'company', companyId: companyInvite.company_id },
  })
}
