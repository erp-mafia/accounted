import { redirect } from 'next/navigation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import { shouldShowOtherAccountHint } from '@/lib/company/other-account-hint'
import { vatDeadlineLine } from '@/lib/onboarding/checklist'
import type { OnboardingProgress } from '@/types'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
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
    { count: inboxItemCount },
    { count: postedEntryCount, error: postedEntryError },
    { data: nextVatDeadline },
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
    // Any item ever received in the document inbox (email/WhatsApp/upload)
    // marks the receipts checklist step done: same "has ever done X" shape
    // as the other flags above.
    supabase.from('invoice_inbox_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    // Posted entries distinguish "brand-new empty ledger" from "all caught
    // up" in the Att göra empty state (hits the partial posted/reversed index).
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['posted', 'reversed']),
    // Next upcoming momsdeklaration for the checklist's Skatteverket step.
    // Rows are system-generated per company settings; dismissed rows are
    // excluded everywhere deadlines are listed, so here too.
    supabase
      .from('deadlines')
      .select('due_date')
      .eq('company_id', companyId)
      .in('tax_deadline_type', ['moms_monthly', 'moms_quarterly', 'moms_yearly'])
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .gte('due_date', now.toISOString().slice(0, 10))
      .order('due_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
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
    hasInboxItems: (inboxItemCount || 0) > 0,
  }

  const vatLine = vatDeadlineLine({
    vatRegistered: settings.vat_registered,
    momsPeriod: settings.moms_period ?? null,
    nextVatDueDate: nextVatDeadline?.due_date ?? null,
  })

  // "Empty ledger" only matters while the setup checklist is still open; once
  // it is completed or dismissed the ordinary all-clear copy applies. A failed
  // count must NOT read as empty: that would tell a company with real
  // bookkeeping that its ledger is blank, so errors degrade to the normal copy.
  const setupOpen = !settings.initial_setup_completed_at && !settings.initial_setup_dismissed_at
  const emptyLedger = setupOpen && !postedEntryError && (postedEntryCount || 0) === 0

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
      vatLine={vatLine}
      emptyLedger={emptyLedger}
    />
  )
}
