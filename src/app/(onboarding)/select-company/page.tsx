import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import BankIdCompanyPicker from '@/components/onboarding/BankIdCompanyPicker'

export const dynamic = 'force-dynamic'

const ENRICHMENT_TTL_DAYS = 7

/**
 * /select-company: the door to adding a company.
 *
 * Reached from "Lägg till företag" in the app (?choose=1) and as the landing
 * after a BankID login. It renders only when there is something to choose:
 * companies the user's BankID says they run (CompanyRoles) that are not in
 * Accounted yet. Everything else goes straight through (founder direction
 * 2026-09-14): no new engagements means the onboarding journey, and a
 * BankID login that finds nothing new opens the company the user already
 * has. Companies the user already belongs to are never listed here; opening
 * one is the in-app switcher's job.
 */
export default async function SelectCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ choose?: string }>
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Invite recovery, same as /onboarding: BankID users land here, so a missed
  // invite acceptance (e.g. a register flow that dropped the cookie handling)
  // gets retried before the user is funnelled into creating a company.
  const inviteToken = (await cookies()).get('gnubok-invite-token')?.value
  if (inviteToken && (await acceptPendingInviteByToken(user, inviteToken))) {
    redirect('/')
  }

  // All lookups key only on user.id/email, one parallel batch instead of
  // serial round-trips on the post-BankID-login landing page.
  const [
    // Existing memberships: only to keep already-added companies out of the
    // engagement list and to know where "nothing to choose" leads.
    { data: memberships },
    { data: teamMembership },
    // Greeting name.
    { data: profile },
    // BankID enrichment (CompanyRoles from Bolagsverket via TIC). Stored
    // user-keyed in `bankid_enrichment` because it lands before company
    // selection, see fetchAndStoreEnrichment in the tic extension.
    { data: enrichmentRow },
    // Pending invitation for this email with no cookie to accept it from:
    // rendered as a "check your invite email" hint in the picker.
    hasPendingInvite,
  ] = await Promise.all([
    supabase
      .from('company_members')
      .select(`
        company:company_id (
          id,
          org_number,
          archived_at
        )
      `)
      .eq('user_id', user.id),
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
    user.email ? hasPendingInviteForEmail(user.email) : Promise.resolve(false),
  ])

  type CompanyRow = {
    id: string
    org_number: string | null
    archived_at: string | null
  }

  const memberCompanies = ((memberships ?? []) as unknown as Array<{
    // Supabase's generated types can express this as either a single object
    // or an array depending on the relationship graph; handle both shapes.
    company: CompanyRow | CompanyRow[] | null
  }>)
    .map((m) => (Array.isArray(m.company) ? m.company[0] ?? null : m.company))
    .filter((c): c is CompanyRow => !!c && !c.archived_at)

  const memberOrgNumbers = new Set(
    memberCompanies
      .map((c) => (c.org_number ? c.org_number.replace(/[\s-]/g, '') : null))
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

  // Drop roles for companies the user already belongs to: those are added.
  const rolesNotAlreadyMine = activeRoles.filter(
    (r) => !memberOrgNumbers.has(r.companyRegistrationNumber.replace(/[\s-]/g, '')),
  )

  // Other accounts can independently use the same organisation number.
  const candidates = rolesNotAlreadyMine

  const enrichmentTimestamp = enrichmentRow?.updated_at ?? enrichmentRow?.created_at ?? null
  const enrichmentStale = enrichmentTimestamp
    ? Date.now() - new Date(enrichmentTimestamp).getTime() > ENRICHMENT_TTL_DAYS * 24 * 60 * 60 * 1000
    : false

  // Nothing to choose from: "Lägg till företag" (?choose=1) and a user with
  // no company go straight into the journey; a BankID login that found no
  // new engagement opens the company the user already has (the middleware
  // resolves which). The stale-enrichment hint and the pending-invite hint
  // both have a home on the journey's first step, so nothing is lost.
  const { choose } = await searchParams
  if (candidates.length === 0) {
    redirect(choose || memberCompanies.length === 0 ? '/onboarding' : '/')
  }

  return (
    <BankIdCompanyPicker
      firstName={firstName}
      teamId={teamId}
      roles={candidates}
      enrichmentStale={enrichmentStale}
      hasPendingInvite={hasPendingInvite}
    />
  )
}
