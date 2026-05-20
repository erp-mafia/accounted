import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import WelcomeGate from '@/components/onboarding/WelcomeGate'

export const dynamic = 'force-dynamic'

// Home route. /chat is the AI-first front door, but a brand-new user has
// no agent built yet — sending them straight to chat lands them on an
// empty conversation list with nothing useful to do. So this page acts as
// a gate:
//
//   - No company yet           → /onboarding (company creation flow)
//   - Agent built              → /chat (front door)
//   - Otherwise                → render NewUserChecklist (Välkommen + steps)
//
// Once the agent is verified, every subsequent visit to / forwards to
// /chat. The checklist is therefore a one-time view per company.
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  // Surface the same progress flags the checklist needs in one round-trip.
  const [
    { count: bankCount },
    { count: sieCount },
    { count: skatteverketCount },
    { data: agent },
    { data: settings },
  ] = await Promise.all([
    supabase
      .from('bank_connections')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'active'),
    supabase
      .from('sie_imports')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'completed'),
    supabase
      .from('skatteverket_tokens')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('agent_profiles')
      .select('verified_at')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('company_settings')
      .select('onboarding_complete')
      .eq('company_id', companyId)
      .single(),
  ])

  // Company-creation flow still incomplete (e.g. user closed onboarding
  // mid-way) — push them back through it.
  if (!settings?.onboarding_complete) {
    redirect('/onboarding')
  }

  const hasBookkeepingImported = (sieCount ?? 0) > 0
  const hasBankConnected = (bankCount ?? 0) > 0
  const hasSkatteverketConnected = (skatteverketCount ?? 0) > 0
  const hasAgentBuilt = !!agent?.verified_at

  // Agent built → user is ready to chat. The agent is the last required
  // step; the other connections are recoverable later but the agent is
  // what makes /chat useful out of the gate.
  if (hasAgentBuilt) {
    redirect('/chat')
  }

  return (
    <WelcomeGate
      companyId={companyId}
      hasBookkeepingImported={hasBookkeepingImported}
      hasBankConnected={hasBankConnected}
      hasSkatteverketConnected={hasSkatteverketConnected}
    />
  )
}
