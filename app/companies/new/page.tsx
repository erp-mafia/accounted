import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import OnboardingBackdrop from '@/components/onboarding/OnboardingBackdrop'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'
import { SessionTimeoutController } from '@/components/auth/SessionTimeoutController'

export const dynamic = 'force-dynamic'

/**
 * Add-another-company: the same journey as first-run onboarding in
 * mode='add' (quiet escape link back to the app, no BankID prefill:
 * this route takes no ?org_number, exactly like the old wizard page).
 */
export default async function NewCompanyPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Deterministic personal-team attachment (WL-08): ensure_user_team returns
  // the user's PERSONAL team (creating one if missing). The previous bare
  // `.limit(1)` membership pick could hand a consultant's new private company
  // to their byrå team; byrå client creation binds its team explicitly via
  // /companies/new-client instead.
  const { data: teamId } = await supabase.rpc('ensure_user_team')
  if (!teamId) {
    redirect('/login')
  }

  return (
    <div className="min-h-dvh bg-background">
      <SessionTimeoutController />
      <OnboardingBackdrop />
      <OnboardingJourney teamId={teamId} mode="add" />
    </div>
  )
}
