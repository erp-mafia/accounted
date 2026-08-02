import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { hashInviteToken } from '@/lib/auth/invite-tokens'

interface TeamInviteRow {
  id: string
  team_id: string
  email: string
  role: string
  status: string
  expires_at: string
  teams: { name: string; kind: string } | null
}

/**
 * GET /api/team/accept?token=xxx
 * Validates an invite token and returns invite info (for the invite page).
 * Handles both company invitations and byrå-team invitations (WL-08 invite
 * unfreeze). Team invitations resolve only for teams with kind='byra':
 * personal teams are uninvitable, so a token pointing at one is invalid.
 * No auth required: this is a public endpoint.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'Token saknas.' }, { status: 400 })
  }

  const tokenHash = hashInviteToken(token)
  const serviceClient = createServiceClient()

  const { data: companyInvite } = await serviceClient
    .from('company_invitations')
    .select('id, email, status, expires_at, company_id, companies:company_id(name)')
    .eq('token_hash', tokenHash)
    .single()

  if (companyInvite) {
    if (companyInvite.status !== 'pending') {
      return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 410 })
    }

    const expired = new Date(companyInvite.expires_at) < new Date()

    const { data: alreadyHasAccount } = await serviceClient.rpc('check_email_exists', {
      email_to_check: companyInvite.email,
    })

    return NextResponse.json({
      data: {
        type: 'company',
        companyName: (companyInvite.companies as unknown as { name: string })?.name || 'Företag',
        email: companyInvite.email,
        expired,
        alreadyHasAccount,
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

  if (teamInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan har redan använts.' }, { status: 410 })
  }

  const expired = new Date(teamInvite.expires_at) < new Date()

  const { data: alreadyHasAccount } = await serviceClient.rpc('check_email_exists', {
    email_to_check: teamInvite.email,
  })

  const teamName = teamInvite.teams?.name || 'Team'

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
 * Team acceptance inserts a team_members row; the DB sync trigger
 * (sync_team_member_to_companies) then grants membership in every company
 * attached to the team, so no company_members writes happen here.
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

  // No company invitation for this token: try byrå-team invitations.
  const { data: teamInviteRaw } = await serviceClient
    .from('team_invitations')
    .select('id, team_id, email, role, status, expires_at, teams:team_id(name, kind)')
    .eq('token_hash', tokenHash)
    .single()

  const teamInvite = teamInviteRaw as unknown as TeamInviteRow | null

  // Kind gate mirrors GET: byrå teams only; anything else is an invalid token.
  if (!teamInvite || teamInvite.teams?.kind !== 'byra' || teamInvite.status !== 'pending') {
    return NextResponse.json({ error: 'Inbjudan är ogiltig.' }, { status: 400 })
  }

  if (new Date(teamInvite.expires_at) < new Date()) {
    await serviceClient
      .from('team_invitations')
      .update({ status: 'expired' })
      .eq('id', teamInvite.id)
    return NextResponse.json({ error: 'Inbjudan har gått ut.' }, { status: 410 })
  }

  if (user.email?.toLowerCase() !== teamInvite.email.toLowerCase()) {
    return NextResponse.json({ error: 'E-postadressen matchar inte inbjudan.' }, { status: 403 })
  }

  // Invitations never mint team owners (the invite route's schema already
  // forbids it; re-checked here against hand-edited rows).
  const memberRole = teamInvite.role === 'admin' ? 'admin' : 'member'

  const { error: memberError } = await serviceClient
    .from('team_members')
    .insert({
      team_id: teamInvite.team_id,
      user_id: user.id,
      role: memberRole,
    })

  if (memberError) {
    if (memberError.code === '23505') {
      return NextResponse.json({ error: 'Du är redan medlem.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Kunde inte lägga till medlem.' }, { status: 500 })
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
      .eq('team_id', teamInvite.team_id)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (firstCompany) {
      const { error: prefError } = await serviceClient
        .from('user_preferences')
        .upsert({
          user_id: user.id,
          active_company_id: (firstCompany as { id: string }).id,
        }, { onConflict: 'user_id' })
      if (prefError) {
        console.error('[team/accept] failed to set active company', prefError)
      }
    }
  }

  // Mark invite as accepted
  await serviceClient
    .from('team_invitations')
    .update({ status: 'accepted' })
    .eq('id', teamInvite.id)

  return NextResponse.json({
    data: {
      type: 'team',
      teamId: teamInvite.team_id,
      teamName: teamInvite.teams?.name ?? null,
    },
  })
}

/** The pre-existing company-invite acceptance flow, unchanged. */
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

  // Add user to company
  const { error: memberError } = await serviceClient
    .from('company_members')
    .insert({
      company_id: companyInvite.company_id,
      user_id: user.id,
      role: companyInvite.role,
      source: 'direct',
    })

  if (memberError) {
    if (memberError.code === '23505') {
      return NextResponse.json({ error: 'Du är redan medlem.' }, { status: 409 })
    }
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

  // Mark invite as accepted
  await serviceClient
    .from('company_invitations')
    .update({ status: 'accepted' })
    .eq('id', companyInvite.id)

  return NextResponse.json({
    data: { type: 'company', companyId: companyInvite.company_id },
  })
}
