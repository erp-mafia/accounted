import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
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

const InviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email('Ogiltig e-postadress.')),
  role: z.enum(['admin', 'member', 'viewer']).default('viewer'),
})

/**
 * POST /api/company/members/invite
 * Invite a user to the current company (e.g., a client as viewer).
 * Only company owners and admins can invite.
 */
export const POST = withRouteContext(
  'company_members.invite',
  async (request, ctx) => {
    const { companyId, user, log } = ctx
    const serviceClient = await createServiceClient()

    // Check caller has permission (owner/admin — stricter than requireWrite)
    const { data: callerMembership } = await serviceClient
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .single()

    if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
      return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })
    }

    const validation = await validateBody(request, InviteSchema, {
      log,
      operation: 'company_members.invite',
    })
    if (!validation.success) return validation.response
    const { email, role } = validation.data

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

    // Send email. email_sent is surfaced in the response so the UI can tell
    // the user when the invitation exists but the mail never went out:
    // previously a send failure was invisible (invite looked sent).
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const emailService = getEmailService()
    let emailSent = false
    if (emailService.isConfigured()) {
      const inviteUrl = `${appUrl}/invite/${token}`

      const emailData = {
        companyName: company?.name || 'Företag',
        inviterEmail: user.email || '',
        inviteUrl,
      }

      const result = await emailService.sendEmail({
        to: email,
        subject: generateInviteEmailSubject(emailData),
        html: generateInviteEmailHtml(emailData),
        text: generateInviteEmailText(emailData),
      })

      if (result.success) {
        emailSent = true
        log.info('invite email sent', { to: email, messageId: result.messageId })
      } else {
        log.error('invite email send failed', new Error(result.error ?? 'unknown'), { to: email })
      }
    } else {
      log.warn('email service not configured: invite email skipped', { to: email })
    }

    // In development, return the invite URL directly (no email service)
    const isDev = process.env.NODE_ENV === 'development'
    const devInviteUrl = isDev ? `${appUrl}/invite/${token}` : undefined

    return NextResponse.json({
      data: {
        email,
        status: 'pending',
        email_sent: emailSent,
        ...(isDev && { inviteUrl: devInviteUrl }),
      },
    })
  },
  { requireWrite: true },
)
