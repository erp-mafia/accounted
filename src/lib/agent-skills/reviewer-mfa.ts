import 'server-only'

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifiedSessionAal } from '@/lib/auth/claims'
import { isCommunityReviewer } from '@/lib/agent-skills/reviewers'

/**
 * MFA for the one operator interface (CASA 3.3.1): the community review
 * queue (/skills/granskning and /api/community/submissions/*,
 * /api/community/items/[slug]/approve), where a reviewer publishes texts to
 * every company's AI.
 *
 * A reviewer's session must be AAL2 (a verified TOTP challenge in this
 * session, per the signature-verified token) or the reviewer must be
 * BankID-linked (BankID is two-factor, the same notion shouldEnforceMfa in
 * lib/auth/mfa.ts uses). Unlike the product-wide gate this applies on every
 * deployment and ignores the time-boxed mfa_exempt_until exemption, which
 * exists for Google's OAuth reviewers and never for an operator. MFA stays
 * optional for everyone else (founder decision: CASA asks for it on admin
 * interfaces only).
 *
 * bankid_linked is read from a fresh getUser() rather than the token's
 * claims, so an unlinked BankID stops counting at once instead of at the
 * next token refresh. Any failure counts as "no MFA" (fail closed).
 */
export async function reviewerSessionHasMfa(supabase: Pick<SupabaseClient, 'auth'>): Promise<boolean> {
  if ((await verifiedSessionAal(supabase)) === 'aal2') return true
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()
    if (error || !user) return false
    return user.app_metadata?.bankid_linked === true
  } catch {
    return false
  }
}

export const REVIEWER_MFA_REQUIRED = {
  code: 'REVIEWER_MFA_REQUIRED',
  message:
    'Granskningen kräver inloggning med tvåfaktorsautentisering eller BankID. Aktivera tvåfaktorsautentisering under Inställningar > Säkerhet och logga in igen.',
  message_en:
    'The review queue requires signing in with two-factor authentication or BankID. Turn on two-factor authentication under Settings > Security and sign in again.',
} as const

const NOT_FOUND = { code: 'NOT_FOUND', message: 'Hittades inte.', message_en: 'Not found.' } as const

/**
 * Gate for the review routes: 404 for anyone who is not a reviewer (the
 * queue's existence stays hidden, as before), 403 with REVIEWER_MFA_REQUIRED
 * for a reviewer whose session lacks MFA, null when the request may proceed.
 */
export async function reviewerAccessError(
  userId: string,
  supabase: Pick<SupabaseClient, 'auth'>,
): Promise<NextResponse | null> {
  if (!isCommunityReviewer(userId)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 })
  }
  if (!(await reviewerSessionHasMfa(supabase))) {
    return NextResponse.json(
      { error: REVIEWER_MFA_REQUIRED },
      { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  return null
}
