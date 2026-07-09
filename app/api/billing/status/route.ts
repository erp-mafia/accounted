import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireCompanyId } from '@/lib/company/context'
import { isStripeConfigured } from '@/lib/stripe/client'
import { isSandboxCompany } from '@/lib/sandbox/guard'

/**
 * Billing status for the client-rendered billing section (which lives inside the
 * settings modal Dialog and can't read the DB server-side). Returns whether the
 * company is paying, whether Stripe checkout is configured, and the trial expiry
 * (for the days-left urgency banner). Read-only.
 */
export async function GET() {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let companyId: string | null = null
  try {
    companyId = await requireCompanyId(supabase, user.id)
  } catch {
    companyId = null
  }

  // Demo accounts (anonymous user or sandbox company) can't check out, so the
  // client hides the upgrade CTA rather than showing a button that only errors.
  let isDemo = user.is_anonymous === true
  if (companyId && !isDemo) {
    isDemo = await isSandboxCompany(supabase, companyId)
  }

  let isPaying = false
  let trialEndsAt: string | null = null
  if (companyId) {
    const { data: sub } = await supabase
      .from('company_subscriptions')
      .select('status')
      .eq('company_id', companyId)
      .maybeSingle()
    const status = (sub as { status: string | null } | null)?.status ?? null
    // Paying = a real subscription. Deliberately excludes 'trialing' so a
    // trialing company still sees the upgrade path (not the manage button).
    isPaying = status === 'active' || status === 'past_due'

    const { data: trial } = await supabase
      .from('capability_grants')
      .select('expires_at')
      .eq('company_id', companyId)
      .eq('source', 'trial')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    trialEndsAt = (trial as { expires_at: string | null } | null)?.expires_at ?? null
  }

  return NextResponse.json({ isPaying, configured: isStripeConfigured(), trialEndsAt, isDemo })
}
