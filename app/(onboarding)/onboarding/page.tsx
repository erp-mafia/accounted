import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import WelcomeOnboarding from '@/components/dashboard/WelcomeOnboarding'
import type { EntityType } from '@/types'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import { mapEntityType as mapTicEntityType } from '@/lib/company-lookup/entity-type-map'

export const dynamic = 'force-dynamic'

// Look up the user's CompanyRoles enrichment (from BankID auth) and find the
// role whose orgnr matches the incoming `?org_number=`. CompanyRoles lives on
// the TIC Identity API (separate product, separate quota from the Lens
// `/lookup` endpoint) so this is free: no Lens calls.
//
// Returns enough to pre-fill Step 1's entity-type radio + Step 2's
// company_name field. The rest (address, F-skatt, VAT) is captured by the
// user in Steps 2-4. F-skatt/VAT defaults can't be safely guessed without
// Bolagsverket data (ML 17 kap 24§ violation if we default a momsregistrerat
// bolag to false), so we make the user confirm in Step 4.
//
// Exported for unit testing.
export async function findCompanyRoleByOrgNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgNumber: string,
): Promise<{ legalName: string; legalEntityType: string } | null> {
  const { data } = await supabase
    .from('bankid_enrichment')
    .select('company_roles')
    .eq('user_id', userId)
    .maybeSingle()

  const roles = (data?.company_roles ?? []) as EnrichmentCompanyRole[]
  if (!Array.isArray(roles) || roles.length === 0) return null

  const match = roles.find(
    (r) => r.companyRegistrationNumber.replace(/[\s-]/g, '') === orgNumber,
  )
  if (!match) return null

  return { legalName: match.legalName, legalEntityType: match.legalEntityType }
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ org_number?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Check if user already has companies (adding another vs first-time)
  const { data: existingMembership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  const hasCompanies = !!existingMembership

  // Fetch profile and team
  const [{ data: profile }, { data: teamMembership }] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
    supabase.from('team_members').select('team_id').eq('user_id', user.id).limit(1).maybeSingle(),
  ])

  let teamId = teamMembership?.team_id

  // Ensure user has a team (fallback for edge cases)
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }

  if (!teamId) {
    redirect('/login')
  }

  const firstName = profile?.full_name?.split(' ')[0] || null

  // The BankID picker routes here with ?org_number=… for every pick. Strip
  // formatting so whatever Step 2 displays matches what the rest of the flow
  // will store.
  const { org_number: rawOrgNumber } = await searchParams
  const initialOrgNumber = rawOrgNumber ? rawOrgNumber.replace(/[\s-]/g, '') : undefined

  // BankID prefill: look up the CompanyRoles row (no Lens call) to pre-fill
  // Step 1's entity_type radio and Step 2's company_name. If no role matches,
  // the user fills everything manually: same fallback as a non-BankID
  // signup. `preverifiedOrgNumber` tells Step 2 to skip the client-side
  // /lookup since CompanyRoles already confirms existence.
  let initialEntityType: EntityType | undefined
  let initialLegalName: string | undefined
  let preverifiedOrgNumber: string | undefined
  if (initialOrgNumber) {
    const match = await findCompanyRoleByOrgNumber(supabase, user.id, initialOrgNumber)
    if (match) {
      initialEntityType = mapTicEntityType(match.legalEntityType) ?? undefined
      initialLegalName = match.legalName
      preverifiedOrgNumber = initialOrgNumber
    }
  }

  return (
    <WelcomeOnboarding
      firstName={firstName}
      teamId={teamId}
      skipWelcome
      hasExistingCompanies={hasCompanies}
      initialOrgNumber={initialOrgNumber}
      initialEntityType={initialEntityType}
      initialLegalName={initialLegalName}
      preverifiedOrgNumber={preverifiedOrgNumber}
    />
  )
}
