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

  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  let teamId = teamMembership?.team_id
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }
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
