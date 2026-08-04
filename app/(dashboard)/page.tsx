import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import { shouldShowOtherAccountHint } from '@/lib/company/other-account-hint'
import { COMPANY_PICKED_COOKIE } from '@/lib/company/context'
import type { OnboardingProgress } from '@/types'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getResolvedDashboardAgentProfile,
} from './request-context'

export const dynamic = 'force-dynamic'

// Home route = Hem (concept scene 14): greeting + Att göra + Fortsätt.
// The KPI/revenue/deadline widgets left the page (founder direction,
// dev_docs/last_session_resume.md §8), which also pruned their fetches:
// the journal-line YTD aggregation, unpaid-invoice totals and deadline
// queries are gone and the page got faster.

export default async function DashboardPage() {
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])

  if (!user) {
    redirect('/login')
  }

  if (!companyId) {
    redirect('/onboarding')
  }

  // Byrå landing: owners/admins of a byrå team home to the cockpit, not to
  // an auto-resolved client company. companyId above can be the middleware's
  // first-membership fallback (which it also writes back to
  // user_preferences, so the DB can't tell picked from auto-picked); the
  // session cookie stamped by setActiveCompany is the explicit-choice
  // signal. Once they enter a client this session, "/" is that company's
  // Hem again. Memberships are request-cached and shared with the layout.
  const [cookieStore, teamMemberships] = await Promise.all([
    cookies(),
    getDashboardTeamMemberships(),
  ])
  if (!cookieStore.has(COMPANY_PICKED_COOKIE)) {
    const byra = teamMemberships.find((m) => m.teams?.kind === 'byra')
    if (byra && (byra.role === 'owner' || byra.role === 'admin')) {
      redirect('/byra')
    }
  }

  const now = new Date()

  // Fetch all data in parallel
  const [
    settingsRes,
    { count: customerCount },
    { count: invoiceCount },
    { count: transactionCount },
    { data: bankConnections },
    { count: sieImportCount },
    { count: skatteverketTokenCount },
    { data: profile },
    agentProfile,
    worklist,
    suggestedMatches,
    resumeItems,
    otherAccountHint,
  ] = await Promise.all([
    getDashboardSettings(),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('bank_connections').select('id, status, consent_expires, bank_name').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed'),
    // Skatteverket tokens are user-scoped (one BankID identity per user) but
    // carry the active company_id; either filter would work: we use user_id
    // because that's what the token-store reads/writes against.
    supabase.from('skatteverket_tokens').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    // First name for the greeting.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    getResolvedDashboardAgentProfile(),
    // Pending-work counts + suggested matches come from lib/worklist: the
    // same source as the sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    listSuggestedMatches(supabase, companyId, 5),
    // In-progress work for the Fortsätt pane: pure draft-state derivation.
    listResumeItems(supabase, companyId, now),
    // Wrong-account hint (#1231): true only when this account has zero
    // journal entries while a same-orgnr company with real bookkeeping
    // exists in another account. Common case costs one existence probe.
    shouldShowOtherAccountHint(supabase),
  ])

  // A FAILED settings read must not masquerade as "onboarding not done":
  // that sent fully onboarded users back to the wizard on a transient query
  // failure (issue #1053). Throw to the error boundary (retryable) and only
  // redirect on a genuinely incomplete or missing settings row.
  const { data: settings, error: settingsError } = settingsRes
  if (settingsError) {
    throw new Error(`company_settings fetch failed: ${settingsError.message}`)
  }

  // If onboarding is not complete, redirect to onboarding
  if (!settings?.onboarding_complete) {
    redirect('/onboarding')
  }

  const agentBuilt = Boolean(agentProfile?.verified_at)

  const onboardingProgress: OnboardingProgress = {
    hasCustomers: (customerCount || 0) > 0,
    hasInvoices: (invoiceCount || 0) > 0,
    hasBankConnected: (bankConnections?.length || 0) > 0 || (transactionCount || 0) > 0,
    hasSIEImport: (sieImportCount || 0) > 0,
    hasSkatteverketConnected: (skatteverketTokenCount || 0) > 0,
  }

  const nowMs = now.getTime()
  const expiringBankConnections = (bankConnections || [])
    .filter(conn => {
      if (!conn.consent_expires) return false
      const daysLeft = Math.ceil(
        (new Date(conn.consent_expires).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      )
      return daysLeft > 0 && daysLeft <= 14
    })
    .map(conn => ({
      id: conn.id as string,
      bank_name: conn.bank_name as string,
      days_left: Math.ceil(
        (new Date(conn.consent_expires!).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      ),
    }))

  const userFirstName = profile?.full_name?.trim().split(/\s+/)[0] ?? null

  return (
    <DashboardContent
      companyId={companyId}
      agentBuilt={agentBuilt}
      userFirstName={userFirstName}
      expiringBankConnections={expiringBankConnections}
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      resumeItems={resumeItems}
      otherAccountHint={otherAccountHint}
      onboardingProgress={onboardingProgress}
      initialSetup={{
        path: settings.initial_setup_path ?? null,
        completedAt: settings.initial_setup_completed_at ?? null,
        dismissedAt: settings.initial_setup_dismissed_at ?? null,
      }}
    />
  )
}
