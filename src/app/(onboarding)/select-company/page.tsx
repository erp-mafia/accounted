import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  acceptPendingInviteByToken,
  hasPendingInviteForEmail,
} from '@/lib/company/pending-invites'
import { addableEngagements } from '@/lib/company-lookup/engagements'
import BankIdCompanyPicker from '@/components/onboarding/BankIdCompanyPicker'

export const dynamic = 'force-dynamic'

const ENRICHMENT_TTL_DAYS = 7

/**
 * /select-company: the door to adding a company.
 *
 * Reached from "Lägg till företag" in the app (?choose=1), and as the landing
 * of a signed-in user without a company whose BankID login stored
 * engagements (the middleware sends them here; a BankID login of a user who
 * has a company opens that company, like any other login, crm#1034). It
 * renders only when there is something to choose: companies the user's
 * BankID says they run (CompanyRoles) that still exist and are not in
 * Accounted yet. Everything else goes straight through (founder direction
 * 2026-09-14): no new engagements means the onboarding journey, or the
 * company the user already has. Companies the user already belongs to are
 * never listed here; opening one is the in-app switcher's job.
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
  // serial round-trips on a landing page.
  const [
    // Existing memberships: only to keep already-added companies out of the
    // engagement list and to know where "nothing to choose" leads.
    { data: memberships },
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

  const firstName = profile?.full_name?.split(' ')[0] ?? null

  // Engagements in companies that still exist and are not the user's yet.
  // Struck-off, merged and dissolved companies keep their last board in the
  // register for good, so they are dropped on the company's status (crm#1034).
  // Other accounts can independently use the same organisation number.
  const candidates = addableEngagements(
    enrichmentRow?.company_roles,
    memberCompanies.map((c) => c.org_number),
  )

  const enrichmentTimestamp = enrichmentRow?.updated_at ?? enrichmentRow?.created_at ?? null
  const enrichmentStale = enrichmentTimestamp
    ? Date.now() - new Date(enrichmentTimestamp).getTime() > ENRICHMENT_TTL_DAYS * 24 * 60 * 60 * 1000
    : false

  // Nothing to choose from: "Lägg till företag" (?choose=1) and a user with
  // no company go straight into the journey; anyone else who reaches the page
  // (an old link) opens the company they already have (the middleware
  // resolves which). The stale-enrichment hint and the pending-invite hint
  // both have a home on the journey's first step, so nothing is lost.
  const { choose } = await searchParams
  if (candidates.length === 0) {
    redirect(choose || memberCompanies.length === 0 ? '/onboarding' : '/')
  }

  return (
    <BankIdCompanyPicker
      firstName={firstName}
      roles={candidates}
      enrichmentStale={enrichmentStale}
      hasPendingInvite={hasPendingInvite}
    />
  )
}
