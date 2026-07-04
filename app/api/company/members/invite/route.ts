import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { getEmailService } from '@/lib/email/service'
import {
  generateInviteEmailSubject,
  generateInviteEmailHtml,
  generateInviteEmailText,
} from '@/lib/email/invite-templates'

// Loads the email extension so getEmailService() returns the Resend
// implementation instead of the noop default. Without this, the invite email
// is silently skipped in dev whenever this route is hit before any other
// init'd route in the process.
ensureInitialized()

/**
 * POST /api/company/members/invite
 * Invite a user to the current company (e.g., a client as viewer).
 * Only company owners and admins can invite.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
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

  const body = await request.json()
  const email = (body.email as string || '').trim().toLowerCase()
  const role = (body.role as string) || 'viewer'

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Ogiltig e-postadress.' }, { status: 400 })
  }

  if (!['admin', 'member', 'viewer'].includes(role)) {
    return NextResponse.json({ error: 'Ogiltig roll.' }, { status: 400 })
  }

  // Check if email is already a member of this company
  const { data: existingMembers } = await serviceClient
    .from('company_members')
    .select('id, user_id')
    .eq('company_id', companyId)

  if (existingMembers && existingMembers.length > 0) {
    const memberUserIds = existingMembers.map((m) => m.user_id)
    const { data: memberProfiles } = await serviceClient
      .from('profiles')
      .select('id, email')
      .in('id', memberUserIds)

    const alreadyMember = memberProfiles?.some(
      (p) => p.email?.toLowerCase() === email
    )
    if (alreadyMember) {
      return NextResponse.json({ error: 'Denna person är redan medlem.' }, { status: 409 })
    }
  }

  // Check for existing pending invite
  const { data: existingInvite } = await serviceClient
    .from('company_invitations')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('email', email)
    .single()

  if (existingInvite && existingInvite.status === 'pending') {
    return NextResponse.json({ error: 'En inbjudan har redan skickats till denna e-post.' }, { status: 409 })
  }

  // Get company name for the email
  const { data: company } = await serviceClient
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single()

  // Generate token
  const { token, hash } = generateInviteToken()
  const expiresAt = getInviteExpiry()

  // Upsert invitation
  if (existingInvite) {
    const { error } = await serviceClient
      .from('company_invitations')
      .update({
        token_hash: hash,
        invited_by: user.id,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
        role,
      })
      .eq('id', existingInvite.id)

    if (error) {
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
  } else {
    const { error } = await serviceClient
      .from('company_invitations')
      .insert({
        company_id: companyId,
        email,
        role,
        token_hash: hash,
        invited_by: user.id,
        status: 'pending',
        expires_at: expiresAt.toISOString(),
      })

    if (error) {
      return NextResponse.json({ error: 'Kunde inte skapa inbjudan.' }, { status: 500 })
    }
  }

  // Send email
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const emailService = getEmailService()
  if (emailService.isConfigured()) {
    const inviteUrl = `${appUrl}/invite/${token}`

    const emailData = {
      companyName: company?.name || 'Företag',
      inviterEmail: user.email || '',
      inviteUrl,
    }

    console.log('[company/members/invite] sending email', {
      to: email,
      company: emailData.companyName,
      from: user.email,
    })

    const result = await emailService.sendEmail({
      to: email,
      subject: generateInviteEmailSubject(emailData),
      html: generateInviteEmailHtml(emailData),
      text: generateInviteEmailText(emailData),
    })

    if (result.success) {
      console.log('[company/members/invite] email sent', {
        to: email,
        messageId: result.messageId,
      })
    } else {
      console.error('[company/members/invite] email send failed:', result.error)
    }
  } else {
    console.warn('[company/members/invite] email service not configured: skipping send', {
      to: email,
    })
  }

  // In development, return the invite URL directly (no email service)
  const isDev = process.env.NODE_ENV === 'development'
  const devInviteUrl = isDev ? `${appUrl}/invite/${token}` : undefined

  return NextResponse.json({
    data: { email, status: 'pending', ...(isDev && { inviteUrl: devInviteUrl }) },
  })
}
