import { redirect } from 'next/navigation'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import BankIdCompanyPicker, {
  type MemberCompany,
  type TicPickerCompany,
} from '@/components/onboarding/BankIdCompanyPicker'

export const dynamic = 'force-dynamic'

const ENRICHMENT_TTL_DAYS = 7

export default async function SelectCompanyPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // All four lookups key only on user.id, one parallel batch instead of
  // four serial round-trips on the post-BankID-login landing page.
  const [
    // Existing Accounted memberships.
    { data: memberships },
    { data: teamMembership },
    // Greeting name.
    { data: profile },
    // BankID enrichment (CompanyRoles from Bolagsverket via TIC). Stored
    // user-keyed in `bankid_enrichment` because it lands before company
    // selection, see fetchAndStoreEnrichment in the tic extension.
    { data: enrichmentRow },
  ] = await Promise.all([
    supabase
      .from('company_members')
      .select(`
        role,
        company:company_id (
          id,
          name,
          org_number,
          entity_type,
          archived_at
        )
      `)
      .eq('user_id', user.id)
      .order('joined_at', { ascending: true }),
    supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
    supabase
      .from('bankid_enrichment')
      .select('company_roles, created_at, updated_at')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  type CompanyRow = {
    id: string
    name: string
    org_number: string | null
    entity_type: string | null
    archived_at: string | null
  }

  const memberCompanies: MemberCompany[] = ((memberships ?? []) as unknown as Array<{
    role: string
    // Supabase's generated types can express this as either a single object
    // or an array depending on the relationship graph; handle both shapes.
    company: CompanyRow | CompanyRow[] | null
  }>)
    .map((m) => ({
      role: m.role,
      company: Array.isArray(m.company) ? m.company[0] ?? null : m.company,
    }))
    .filter((m): m is { role: string; company: CompanyRow } => !!m.company && !m.company.archived_at)
    .map((m) => ({
      id: m.company.id,
      name: m.company.name,
      orgNumber: m.company.org_number,
      entityType: m.company.entity_type,
      role: m.role,
    }))

  const memberOrgNumbers = new Set(
    memberCompanies
      .map((c) => (c.orgNumber ? c.orgNumber.replace(/[\s-]/g, '') : null))
      .filter((n): n is string => !!n),
  )

  // Ensure the user has a team (same pattern as /onboarding).
  let teamId = teamMembership?.team_id
  if (!teamId) {
    const { data: ensured } = await supabase.rpc('ensure_user_team')
    teamId = ensured ?? null
  }
  if (!teamId) {
    redirect('/login')
  }

  const firstName = profile?.full_name?.split(' ')[0] ?? null

  const enrichmentValue = enrichmentRow
    ? { companyRoles: enrichmentRow.company_roles as EnrichmentCompanyRole[] }
    : null

  // "Currently a director" = no position end date. We deliberately do NOT
  // also require companyStatus === 'Aktivt': real TIC payloads have been
  // observed with other values (locale/tenant variants), and filtering too
  // strictly silently hides the user's real directorships.
  //
  // Ceased/struck-off companies would still render here, but two later
  // guards block provisioning:
  //   1. BankIdCompanyPicker calls TIC /lookup before provisioning and
  //      short-circuits with a toast when isCeased=true.
  //   2. createCompanyFromTicRole refuses to provision when lookup.isCeased.
  // Both guards are required: don't remove one without removing both.
  //
  // Loose `== null` on purpose: TIC payloads have been observed returning
  // `undefined` for open-ended positions, which `=== null` would miss.
  const activeRoles = (enrichmentValue?.companyRoles ?? []).filter(
    (r) => r.positionEnd == null,
  )

  // Drop TIC roles that already appear in the user's Accounted memberships:
  // those render via the "Your Accounted companies" section above instead.
  const rolesNotAlreadyMine = activeRoles.filter(
    (r) => !memberOrgNumbers.has(r.companyRegistrationNumber.replace(/[\s-]/g, '')),
  )

  // Cross-reference remaining TIC org numbers against the global companies
  // table to detect "exists in Accounted, user not a member" cases. Use the
  // service client: RLS filters out companies the user isn't a member of,
  // which is exactly the data we need. Scoped to the specific org numbers.
  let externallyOwnedOrgs = new Set<string>()
  if (rolesNotAlreadyMine.length > 0) {
    const service = createServiceClient()
    const orgNumbers = rolesNotAlreadyMine.map((r) =>
      r.companyRegistrationNumber.replace(/[\s-]/g, ''),
    )
    const { data: rows } = await service
      .from('companies')
      .select('org_number')
      .in('org_number', orgNumbers)
      .is('archived_at', null)
    externallyOwnedOrgs = new Set(
      (rows ?? []).map((r: { org_number: string | null }) => r.org_number ?? '').filter(Boolean),
    )
  }

  const ticCompanies: TicPickerCompany[] = rolesNotAlreadyMine.map((role) => {
    const cleaned = role.companyRegistrationNumber.replace(/[\s-]/g, '')
    return {
      role,
      status: externallyOwnedOrgs.has(cleaned) ? 'exists' : 'new',
    }
  })

  const enrichmentTimestamp = enrichmentRow?.updated_at ?? enrichmentRow?.created_at ?? null
  const enrichmentStale = enrichmentTimestamp
    ? Date.now() - new Date(enrichmentTimestamp).getTime() > ENRICHMENT_TTL_DAYS * 24 * 60 * 60 * 1000
    : false

  return (
    <BankIdCompanyPicker
      firstName={firstName}
      teamId={teamId}
      memberCompanies={memberCompanies}
      ticCompanies={ticCompanies}
      enrichmentStale={enrichmentStale}
    />
  )
}
