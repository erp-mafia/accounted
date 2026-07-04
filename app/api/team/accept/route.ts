import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { hashInviteToken } from '@/lib/auth/invite-tokens'

/**
 * GET /api/team/accept?token=xxx
 * Validates an invite token and returns invite info (for the invite page).
 * Only company invitations are supported: team invitations are disabled.
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

  if (!companyInvite) {
    return NextResponse.json({ error: 'Inbjudan hittades inte eller är ogiltig.' }, { status: 404 })
  }

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

/**
 * POST /api/team/accept
 * Accepts a company invite after the user has signed up.
 * Team invitations are disabled: teams are single-user.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  if (companyLookupError) {
    console.error('[team/accept] company lookup error:', companyLookupError.message)
  }

  if (!companyInvite || companyInvite.status !== 'pending') {
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
