import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import OnboardingBackdrop from '@/components/onboarding/OnboardingBackdrop'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'

export const dynamic = 'force-dynamic'

/**
 * Client company creation from the byrå cockpit (WL-15): exactly today's
 * creation journey (company form, fiscal year, voucher series defaults), but
 * bound EXPLICITLY to the byrå team so the new company lands under the byrå
 * (companies.team_id = byrå team), the team sync grants the whole byrå
 * access, and the trial-suppression trigger keys on the byrå binding.
 *
 * Server-gated to byrå team owner/admin (creation is a commercial act: +1 on
 * the byrå's invoice). The create_company_with_owner RPC enforces the same
 * gate in the database, so a member cannot bypass this page via PostgREST.
 */
export default async function NewClientCompanyPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  const membership = await getByraMembership(supabase, user.id)
  if (!membership) {
    redirect('/')
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    redirect('/clients')
  }

  return (
    <div className="min-h-screen bg-background">
      <OnboardingBackdrop />
      <OnboardingJourney teamId={membership.teamId} mode="add" />
    </div>
  )
}
