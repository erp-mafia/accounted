import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import DashboardContent from '@/components/dashboard/DashboardContent'
import WelcomeGate from '@/components/onboarding/WelcomeGate'
import { getActiveCompanyId } from '@/lib/company/context'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
import type { Deadline, OnboardingProgress } from '@/types'

export const dynamic = 'force-dynamic'

// Home route = Översikt (DashboardContent). The agent chat has its own nav
// entry at /chat, so / no longer forwards there. New users who haven't built
// their assistant yet get WelcomeGate (the build-agent checklist) instead of
// the dashboard; once the agent is verified, / renders the normal Översikt.

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const cookieStore = await cookies()
  const rawCompanyId = cookieStore.get('gnubok-company-id')?.value
    ?? await getActiveCompanyId(supabase, user.id)

  // Validate the cookie/preference points to a company the user can access
  let companyId = rawCompanyId
  if (companyId) {
    const { data: membership } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) companyId = null
  }

  if (!companyId) {
    redirect('/onboarding')
  }

  // Fetch current year date boundaries
  const startOfYearStr = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]
  const startOfMonthStr = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  // Fetch all data in parallel
  const [
    { data: settings },
    { count: customerCount },
    { count: invoiceCount },
    { count: receiptCount },
    { count: transactionCount },
    { data: journalLines },
    { data: unpaidInvoices },
    { data: bankConnections },
    { data: deadlines },
    { count: sieImportCount },
    { count: staleUncategorizedCount },
    { count: skatteverketTokenCount },
    { data: agentProfile },
    { count: postedEntriesCount },
    worklist,
    suggestedMatches,
  ] = await Promise.all([
    supabase.from('company_settings').select('*').eq('company_id', companyId).single(),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('receipts').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entry:journal_entries!inner(entry_date, status, company_id)')
      .eq('journal_entry.status', 'posted')
      .eq('journal_entry.company_id', companyId)
      .gte('journal_entry.entry_date', startOfYearStr),
    supabase.from('invoices').select('total, total_sek, vat_amount, vat_amount_sek, status').eq('company_id', companyId).in('status', ['sent', 'overdue']).is('credited_invoice_id', null),
    supabase.from('bank_connections').select('id, accounts_data, status, consent_expires, bank_name').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('deadlines').select('*, customer:customers(id, name)').eq('company_id', companyId).eq('is_completed', false)
      .or(`due_date.lt.${today},due_date.lte.${nextWeek}`).order('due_date', { ascending: true }),
    supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).is('journal_entry_id', null).eq('is_ignored', false).is('is_business', null).lt('date', new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]),
    // Skatteverket tokens are user-scoped (one BankID identity per user) but
    // carry the active company_id; either filter would work — we use user_id
    // because that's what the token-store reads/writes against.
    supabase.from('skatteverket_tokens').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('agent_profiles').select('verified_at').eq('company_id', companyId).maybeSingle(),
    // Any posted entry counts as "company has been used" for the hasData gate.
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'posted'),
    // Pending-work counts + suggested matches come from lib/worklist — the
    // same source as the sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    listSuggestedMatches(supabase, companyId, 5),
  ])

  // If onboarding is not complete, redirect to onboarding
  if (!settings?.onboarding_complete) {
    redirect('/onboarding')
  }

  // Sandbox sessions that pre-date the agent_profile seeding step would
  // otherwise still see the "Bygg din bokföringsassistent" hero + the
  // NewUserChecklist's agent step lit up. Backfill here so the next render
  // sees a verified profile and treats the sandbox as fully set up.
  let effectiveAgentVerified = agentProfile?.verified_at ?? null
  if (settings?.is_sandbox === true && !effectiveAgentVerified) {
    await ensureSandboxAgentProfile(supabase, companyId)
    const { data: refreshed } = await supabase
      .from('agent_profiles')
      .select('verified_at')
      .eq('company_id', companyId)
      .maybeSingle()
    effectiveAgentVerified = refreshed?.verified_at ?? null
  }

  const agentBuilt = Boolean(effectiveAgentVerified)

  // "Has the company already been used?" Any real business data means we must
  // NOT hijack the dashboard with the full-screen onboarding gate — existing
  // and migrated users get the normal Översikt with a build-assistant prompt
  // in the hero slot (see DashboardContent's agentBuilt branch) instead.
  const hasData =
    (transactionCount || 0) > 0 ||
    (sieImportCount || 0) > 0 ||
    (invoiceCount || 0) > 0 ||
    (receiptCount || 0) > 0 ||
    (customerCount || 0) > 0 ||
    (postedEntriesCount || 0) > 0

  // Only a genuinely empty company without an assistant sees the full
  // onboarding checklist (where building the assistant is the last step).
  // Everyone else falls through to the dashboard below.
  if (!agentBuilt && !hasData) {
    return (
      <WelcomeGate
        companyId={companyId}
        hasBookkeepingImported={(sieImportCount || 0) > 0}
        hasBankConnected={(transactionCount || 0) > 0}
        hasSkatteverketConnected={(skatteverketTokenCount || 0) > 0}
      />
    )
  }

  const onboardingProgress: OnboardingProgress = {
    hasCustomers: (customerCount || 0) > 0,
    hasInvoices: (invoiceCount || 0) > 0,
    hasBankConnected: (transactionCount || 0) > 0,
    hasSIEImport: (sieImportCount || 0) > 0,
    hasSkatteverketConnected: (skatteverketTokenCount || 0) > 0,
  }

  // Calculate totals from journal entry lines using account classes
  const calculateTotals = (lines: typeof journalLines, fromDate: string) => {
    const filtered = (lines || []).filter((l) => {
      const entry = l.journal_entry as unknown as { entry_date: string; status: string }
      return entry.entry_date >= fromDate
    })

    let revenue = 0
    let expenses = 0

    for (const line of filtered) {
      const acct = line.account_number
      if (acct.startsWith('3')) {
        // Revenue: class 3 — credit-normal accounts
        revenue += Math.round(((line.credit_amount || 0) - (line.debit_amount || 0)) * 100) / 100
      } else if (acct.startsWith('4') || acct.startsWith('5') || acct.startsWith('6') || acct.startsWith('7')) {
        // Expenses: classes 4-7 — debit-normal accounts
        expenses += Math.round(((line.debit_amount || 0) - (line.credit_amount || 0)) * 100) / 100
      }
    }

    revenue = Math.round(revenue * 100) / 100
    expenses = Math.round(expenses * 100) / 100

    return { income: revenue, expenses, net: Math.round((revenue - expenses) * 100) / 100 }
  }

  const ytdTotals = calculateTotals(journalLines, startOfYearStr)
  const mtdTotals = calculateTotals(journalLines, startOfMonthStr)

  // Mirror the per-invoice öresavrundning rule used on the invoice list/detail
  // pages: sum the displayed (rounded) SEK amount per invoice so the dashboard
  // total matches what the user sees on the invoice list when the setting is on.
  const unpaidTotal = (unpaidInvoices || []).reduce(
    (sum, inv) => sum + getDisplayTotal(
      { total: Number(inv.total_sek || inv.total), currency: 'SEK' },
      settings,
    ).displayed,
    0
  )

  const unpaidVatTotal = (unpaidInvoices || []).reduce(
    (sum, inv) => sum + Number(inv.vat_amount_sek || inv.vat_amount || 0),
    0
  )

  const overdueCount = (unpaidInvoices || []).filter(
    (inv) => inv.status === 'overdue'
  ).length

  let bankBalance: number | null = null
  if (bankConnections && bankConnections.length > 0) {
    const allBalances = bankConnections.flatMap(conn => {
      const accounts = conn.accounts_data as { balance: number }[] | null
      return accounts || []
    })
    if (allBalances.length > 0) {
      bankBalance = allBalances.reduce((sum, acc) => sum + (acc.balance || 0), 0)
    }
  }

  const nowMs = new Date().getTime()
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

  return (
    <DashboardContent
      companyId={companyId}
      agentBuilt={agentBuilt}
      summary={{
        ytd: ytdTotals,
        mtd: mtdTotals,
        unpaidInvoicesCount: (unpaidInvoices || []).length,
        unpaidInvoicesTotal: unpaidTotal,
        unpaidVatTotal,
        overdueInvoicesCount: overdueCount,
        bankBalance,
        expiringBankConnections,
        deadlines: (deadlines || []) as Deadline[],
        staleUncategorizedCount: staleUncategorizedCount || 0,
      }}
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      onboardingProgress={onboardingProgress}
    />
  )
}
