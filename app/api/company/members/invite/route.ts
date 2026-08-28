import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { generateInviteToken, getInviteExpiry } from '@/lib/auth/invite-tokens'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import {
  generateInviteEmailSubject,
  generateInviteEmailHtml,
  generateInviteEmailText,
} from '@/lib/email/invite-templates'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'

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
 * First local-part character + *** + domain, e.g. "j***@example.com".
 * Keeps invitee PII out of the log record while leaving enough to tell
 * WHICH invite failed. The logger's own redaction would otherwise replace
 * a raw address with [REDACTED_EMAIL] (lib/observability/redact.ts); the
 * masked form does not match that email pattern, so it survives intact.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * POST /api/company/members/invite
 * Invite a user to the current company (e.g., a client as viewer).
 * Only company owners and admins can invite.
 *
 * The accept link (inviteUrl) is ALWAYS returned in the response, whether or
 * not the invitation email went out, so the inviter can share it directly.
 * This is the only place the raw link exists: tokens are stored hashed
 * (lib/auth/invite-tokens.ts), so a self-hosted operator without a mail
 * provider (#1710) or an inviter whose mail bounced would otherwise hold an
 * invitation nobody can accept. There is no re-send for company invites:
 * revoke and invite again to get a fresh link.
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

    // The request host is used only when it is the canonical app host or an
    // exact registered white-label domain. A spoofed Host header falls back to
    // NEXT_PUBLIC_APP_URL, so neither the email nor GoTrue gets an open
    // redirect target.
    const appOrigin = resolveRequestAppOrigin(request)

    // Self-hosted installations that turn public signup off in GoTrue
    // (disable_signup) set AUTH_SIGNUPS_DISABLED=true to mirror that config:
    // GoTrue offers no clean server-side read of the setting. Without this,
    // an invitee with no account is routed to /register, where
    // supabase.auth.signUp is rejected with "Signups not allowed for this
    // instance" and the invite dead-ends. Provision the account via the auth
    // admin invite API instead. Hosted keeps the flag unset: nothing in this
    // block runs and behavior is unchanged.
    const signupsDisabled = process.env.AUTH_SIGNUPS_DISABLED === 'true'
    let userProvisioned = false
    if (signupsDisabled) {
      const { data: emailExists, error: existsError } = await serviceClient.rpc(
        'check_email_exists',
        { email_to_check: email },
      )
      if (existsError) {
        // GoTrue is the authority: attempt provisioning anyway and let a
        // duplicate surface there instead of silently skipping the invitee.
        log.warn('check_email_exists failed; attempting provisioning anyway', {
          message: existsError.message,
        })
      }

      if (!emailExists) {
        // Provision BEFORE the invitation row is written: a failure here
        // leaves nothing half-created behind, so the admin can retry cleanly
        // after fixing the cause (typically GoTrue SMTP configuration).
        // The redirect lands the invitee back on the invite page with a
        // session; /auth/callback routes type=invite verifications to the
        // set-password surface first.
        const { error: provisionError } = await serviceClient.auth.admin.inviteUserByEmail(
          email,
          { redirectTo: `${appOrigin}/invite/${token}` },
        )

        if (provisionError) {
          const alreadyRegistered =
            provisionError.code === 'email_exists' ||
            /already been registered/i.test(provisionError.message)
          if (!alreadyRegistered) {
            // Never report a silently-successful invite when the invitee
            // cannot actually get an account.
            log.error('invitee auth provisioning failed', new Error(provisionError.message), {
              to: maskEmail(email),
            })
            return NextResponse.json(
              { error: getErrorMessage(provisionError, { context: 'auth', statusCode: 502 }) },
              { status: 502 },
            )
          }
          // The account exists after all (stale check_email_exists answer):
          // proceed exactly as for an existing user.
        } else {
          userProvisioned = true
        }
      }
    }

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
    // Brand mail (WL-13): sender identity and the invite link follow the
    // brand of the company the invite concerns; a company without a brand
    // uses the validated request origin (appOrigin) and sender exactly as
    // before.
    const sender = await getSenderForCompany(companyId)
    const appUrl = sender.brand ? getBaseUrlForBrand(sender.brand) : appOrigin
    const inviteUrl = `${appUrl}/invite/${token}`
    const emailService = getEmailService()
    let emailSent = false
    if (emailService.isConfigured()) {
      const emailData = {
        companyName: company?.name || 'Företag',
        inviterEmail: user.email || '',
        inviteUrl,
        appName: sender.brand?.appName,
      }

      const result = await emailService.sendEmail({
        to: email,
        subject: generateInviteEmailSubject(emailData),
        html: generateInviteEmailHtml(emailData),
        text: generateInviteEmailText(emailData),
        fromName: sender.fromName ?? undefined,
        fromAddress: sender.fromAddress ?? undefined,
        replyTo: sender.replyTo ?? undefined,
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

    return NextResponse.json({
      data: {
        email,
        status: 'pending',
        email_sent: emailSent,
        user_provisioned: userProvisioned,
        // The accept link is always returned so the inviter can share it
        // directly, e.g. when the mail bounced or no mail provider is
        // configured (self-hosted without Resend). Same contract as
        // POST /api/team/invite.
        inviteUrl,
      },
    })
  },
  { requireWrite: true },
)
