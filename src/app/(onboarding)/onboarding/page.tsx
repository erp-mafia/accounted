import { createClient } from '@/lib/supabase/server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import OnboardingJourney from '@/components/onboarding/journey/OnboardingJourney'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'
import type { EntityType } from '@/types'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import { addableEngagements } from '@/lib/company-lookup/engagements'
import { mapSetupEntityType as mapTicEntityType } from '@/lib/company-lookup/entity-type-map'
import { isScbConfigured } from '@/lib/parties/scb/config'
import { orgNumberKey, registrationNumberKey } from '@/lib/invariants/org-number'
import { setActiveCompany } from '@/lib/company/context'
import { NEXT_ACTION_HEADER } from '@/lib/company/tab-guard'

export const dynamic = 'force-dynamic'

// The user's CompanyRoles enrichment (from BankID auth). CompanyRoles lives on
// the TIC Identity API (separate product, separate quota from the Lens
// `/lookup` endpoint) so this is free: no Lens calls.
async function readCompanyRoles(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<EnrichmentCompanyRole[]> {
  const { data } = await supabase
    .from('bankid_enrichment')
    .select('company_roles')
    .eq('user_id', userId)
    .maybeSingle()

  const roles = (data?.company_roles ?? []) as EnrichmentCompanyRole[]
  return Array.isArray(roles) ? roles : []
}

// The role whose orgnr matches a legacy `?org_number=` link. Exported for
// unit testing.
export async function findCompanyRoleByOrgNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgNumber: string,
): Promise<EnrichmentCompanyRole | null> {
  const roles = await readCompanyRoles(supabase, userId)
  return roles.find((r) => r.companyRegistrationNumber.replace(/[\s-]/g, '') === orgNumber) ?? null
}

// The role the BankID picker sent as `?pick=<TIC companyId>`. The pick is an
// opaque id resolved against the signed-in user's own roles only: the
// registration number never goes into the URL, because a sole trader's is
// the owner's personnummer and the URL lands in analytics ($current_url) and
// request logs. Exported for unit testing.
export async function findCompanyRoleByPick(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  pick: string,
): Promise<EnrichmentCompanyRole | null> {
  if (!/^\d{1,15}$/.test(pick)) return null
  const companyId = Number(pick)
  const roles = await readCompanyRoles(supabase, userId)
  return roles.find((r) => r.companyId === companyId) ?? null
}

/**
 * The id of the non-archived company this user belongs to whose org number
 * is `orgNumber` (any TIC or typed shape), or null. Exported for unit testing.
 */
export async function findOwnCompanyByOrgNumber(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  orgNumber: string,
): Promise<string | null> {
  const key = registrationNumberKey(orgNumber)
  if (!key) return null

  const { data } = await supabase
    .from('company_members')
    .select('company:company_id ( id, org_number, archived_at )')
    .eq('user_id', userId)

  type CompanyRow = { id: string; org_number: string | null; archived_at: string | null }
  for (const row of (data ?? []) as unknown as Array<{ company: CompanyRow | CompanyRow[] | null }>) {
    const company = Array.isArray(row.company) ? row.company[0] ?? null : row.company
    if (company && !company.archived_at && orgNumberKey(company.org_number) === key) {
      return company.id
    }
  }
  return null
}

/**
 * Where Tillbaka on the journey's first question leads: the BankID picker
 * while it has companies to offer (/select-company renders only then), else
 * the company the user already has ("Lägg till företag" with nothing to pick
 * lands here), else nowhere. Exported for unit testing.
 */
export async function firstQuestionBackHref(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const [roles, { data }] = await Promise.all([
    readCompanyRoles(supabase, userId),
    supabase
      .from('company_members')
      .select('company:company_id ( org_number, archived_at )')
      .eq('user_id', userId),
  ])

  type CompanyRow = { org_number: string | null; archived_at: string | null }
  const companies = ((Array.isArray(data) ? data : []) as unknown as Array<{ company: CompanyRow | CompanyRow[] | null }>)
    .map((row) => (Array.isArray(row.company) ? row.company[0] ?? null : row.company))
    .filter((company): company is CompanyRow => !!company && !company.archived_at)

  if (addableEngagements(roles, companies.map((company) => company.org_number)).length > 0) return '/select-company'
  return companies.length > 0 ? '/' : null
}

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ pick?: string; org_number?: string }>
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

  // The BankID picker routes here with ?pick=<TIC companyId>. Links from
  // before it carried ?org_number=<registration number> and live on in
  // history and bookmarks; they still resolve, then lose the number below.
  const { pick, org_number: legacyOrgNumber } = await searchParams
  const role = pick
    ? await findCompanyRoleByPick(supabase, user.id, pick)
    : legacyOrgNumber
      ? await findCompanyRoleByOrgNumber(supabase, user.id, legacyOrgNumber.replace(/[\s-]/g, ''))
      : null
  const registrationNumber = role?.companyRegistrationNumber ?? legacyOrgNumber ?? null

  // A deep link to a company this user already has opens that company
  // instead of starting the journey for a duplicate. The BankID picker used
  // to list a sole trader's own firm (its 16-digit TIC number never matched
  // the stored personnummer), and the resulting URL lives on in history and
  // bookmarks, so the guard belongs here and not only in the picker.
  // Only on arrival: the journey's own createCompanyFromOnboarding sets
  // cookies, so Next renders this page again inside the action's response,
  // and by then the company the journey just created answers the pick. A
  // redirect there reached the browser as React error #441 and threw the
  // user past the done screen.
  const isActionRender = (await headers()).has(NEXT_ACTION_HEADER)
  const existingCompanyId = registrationNumber && !isActionRender
    ? await findOwnCompanyByOrgNumber(supabase, user.id, registrationNumber)
    : null
  if (existingCompanyId) {
    try {
      await setActiveCompany(supabase, user.id, existingCompanyId)
    } catch {
      // Not switchable (e.g. a frozen seat): the middleware resolves the
      // company to open, which is still better than a second copy.
    }
    redirect('/')
  }

  // A legacy link answers with the same page without the number, before
  // anything renders, so the client never records it as the page URL.
  if (legacyOrgNumber) {
    redirect(role ? `/onboarding?pick=${role.companyId}` : '/onboarding')
  }

  // Deterministic personal-team attachment (WL-08), same as /companies/new:
  // ensure_user_team returns the user's PERSONAL team (creating one if
  // missing). The previous bare `.limit(1)` membership pick returned whichever
  // row came first, so a byrå member's new company landed in the personal or
  // the byrå team at random. Byrå clients bind their team explicitly via
  // /companies/new-client.
  const { data: teamId } = await supabase.rpc('ensure_user_team')
  if (!teamId) {
    redirect('/login')
  }

  // BankID prefill from the picked CompanyRoles row (no Lens call): the org
  // number in the 10-digit form the journey accepts (TIC registers an
  // enskild firma under 16 digits, which the journey refused, so the pick
  // never looked the firm up), entity_type and company_name. Without a role
  // everything is manual: same fallback as a non-BankID signup. The journey
  // auto-submits the orgnr, which runs the same single Lens lookup as manual
  // entry (plan addendum 2026-07-24); on lookup failure the flow degrades to
  // asking the questions with these role fields as prefill.
  const initialOrgNumber = role ? registrationNumberKey(role.companyRegistrationNumber) ?? undefined : undefined
  const initialEntityType: EntityType | undefined = role ? mapTicEntityType(role.legalEntityType) ?? undefined : undefined
  const initialLegalName = role?.legalName
  const backHref = await firstQuestionBackHref(supabase, user.id)

  return (
    <OnboardingJourney
      userId={user.id}
      teamId={teamId}
      mode="first"
      initialOrgNumber={initialOrgNumber}
      initialEntityType={initialEntityType}
      initialLegalName={initialLegalName}
      // A deep-linked orgnr is a deliberate create-this-company pick from the
      // BankID list: don't distract that flow with the invite hint.
      hasPendingInvite={hasPendingInvite && !initialOrgNumber}
      // SCB credentials are server env: the client learns once whether the
      // search-as-you-type picker exists in this environment.
      companySearchEnabled={isScbConfigured()}
      backHref={backHref}
    />
  )
}
