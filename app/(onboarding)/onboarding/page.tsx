import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'
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

  // Invite recovery: an invitee normally never reaches this page (the client
  // flows or the auth callback attach them to the company first), so landing
  // here with a live invite cookie means acceptance was missed. Retry it and
  // skip onboarding entirely on success; if only a pending invitation exists
  // (cookie lost, e.g. confirmation opened on another device), surface a hint
  // instead of silently asking the invitee to create a company.
  const inviteToken = (await cookies()).get('gnubok-invite-token')?.value
  if (inviteToken && (await acceptPendingInviteByToken(user, inviteToken))) {
    redirect('/')
  }
  const hasPendingInvite = user.email
    ? await hasPendingInviteForEmail(user.email)
    : false

  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  let teamId = teamMembership?.team_id

  // Ensure user has a team (fallback for edge cases)
  if (!teamId) {
    const { data: newTeamId } = await supabase.rpc('ensure_user_team')
    teamId = newTeamId
  }

  if (!teamId) {
    redirect('/login')
  }

  // The BankID picker routes here with ?org_number=… for every pick. Strip
  // formatting so whatever Step 2 displays matches what the rest of the flow
  // will store.
  const { org_number: rawOrgNumber } = await searchParams
  const initialOrgNumber = rawOrgNumber ? rawOrgNumber.replace(/[\s-]/g, '') : undefined

  // BankID prefill: look up the CompanyRoles row (no Lens call) to seed
  // entity_type + company_name. If no role matches, everything is manual:
  // same fallback as a non-BankID signup. The journey auto-submits the
  // deep-linked orgnr, which runs the same single Lens lookup as manual
  // entry (plan addendum 2026-07-24); on lookup failure the flow degrades
  // to asking the questions with these role fields as prefill.
  let initialEntityType: EntityType | undefined
  let initialLegalName: string | undefined
  if (initialOrgNumber) {
    const match = await findCompanyRoleByOrgNumber(supabase, user.id, initialOrgNumber)
    if (match) {
      initialEntityType = mapTicEntityType(match.legalEntityType) ?? undefined
      initialLegalName = match.legalName
    }
  }

  return (
    <OnboardingJourney
      teamId={teamId}
      mode="first"
      initialOrgNumber={initialOrgNumber}
      initialEntityType={initialEntityType}
      initialLegalName={initialLegalName}
      // A deep-linked orgnr is a deliberate create-this-company pick from the
      // BankID list: don't distract that flow with the invite hint.
      hasPendingInvite={hasPendingInvite && !initialOrgNumber}
    />
  )
}
