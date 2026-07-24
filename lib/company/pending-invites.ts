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
      return false
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
 * True when a pending, unexpired invitation exists for this email.
 * Invitation emails are lowercased at creation (invite route Zod schema),
 * so the lowercase equality match is exact. Used to tell an invitee who
 * arrived without the invite token ("go open the link in the email")
 * apart from a genuine first-time user. Never throws.
 */
export async function hasPendingInviteForEmail(email: string): Promise<boolean> {
  try {
    const serviceClient = createServiceClient()
    const { data } = await serviceClient
      .from('company_invitations')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .limit(1)

    return (data ?? []).length > 0
  } catch (err) {
    console.error('[pending-invites] pending lookup failed', err)
    return false
  }
}
