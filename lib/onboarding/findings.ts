import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { loadConnectedAiClients } from '@/lib/onboarding/ai-clients.server'

/**
 * Genomlysning: what the books act (issue #2438) can say about a company
 * right after its books, bank and Skatteverket arrived. Read-only, one
 * request, computed from what is already in the ledger. Every number here
 * is a fact the user did not have before importing; nothing is estimated.
 */

export interface BooksFindings {
  books: {
    /** Posted and reversed entries (drafts do not count as "books"). */
    entries: number
    periods: {
      name: string
      start: string
      end: string
      isClosed: boolean
      /** null = never checked; false = IB does not match the previous UB. */
      continuityVerified: boolean | null
    }[]
    /** Net revenue (class 3) of the most recent period with entries, in SEK. */
    revenue: number | null
    /** Result (classes 3 to 8) of the same period. */
    result: number | null
    /** Which period the revenue/result describe. */
    periodName: string | null
    /** Customer invoices past due and still open. */
    overdueInvoices: number
    /** Balance on 26xx (VAT accounts): what is owed to or by Skatteverket right now. */
    vatBalance: number | null
    /** Bank rows nobody has categorized yet. */
    uncategorizedTransactions: number
    /** ISO date of the latest posted verifikat: where the bank history should take over. */
    lastEntryDate: string | null
    /** Posted verifikat still without underlag (the journal list's own predicate). */
    missingUnderlag: number
  }
  bank: {
    connected: boolean
    bankName: string | null
    transactions: number
    sweep: { auto_linked: number; suggested: number; unmatched: number } | null
  }
  skv: {
    connected: boolean
    /** Balance on 1630 (skattekonto) in the ledger, positive = asset. */
    ledger1630: number | null
    nextDeadlines: { type: string; dueDate: string }[]
  }
  ai: {
    /** Clients whose MCP OAuth sign-in this user has completed (a live key with that client). */
    connected: AiClient[]
  }
}

/** Payload of the get_onboarding_books_summary RPC; sums are exact numerics. */
interface BooksSummary {
  period_name: string | null
  revenue: number | string | null
  result: number | string | null
  vat_balance: number | string | null
  ledger_1630: number | string | null
}

const round2 = (x: number) => Math.round(x * 100) / 100
/** -0 would survive JSON as 0 but not toBe(0); keep the API value canonical. */
const toOre = (v: number | string) => round2(Number(v)) + 0

const TAX_DEADLINES_OF_INTEREST = ['moms_monthly', 'moms_quarterly', 'moms_yearly', 'arbetsgivardeklaration']

export async function loadBooksFindings(
  supabase: SupabaseClient,
  companyId: string,
  today: string,
  userId: string,
): Promise<BooksFindings> {
  const results = await Promise.all([
    supabase
      .from('journal_entries')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed']),
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, continuity_verified')
      .eq('company_id', companyId)
      .order('period_start', { ascending: true }),
    supabase
      .from('invoices')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['sent', 'partially_paid', 'overdue'])
      .lt('due_date', today),
    supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('is_business', null)
      .eq('is_ignored', false),
    supabase
      .from('bank_connections')
      .select('bank_name, status, last_sie_sweep')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(1),
    supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId),
    supabase
      .from('skatteverket_tokens')
      .select('status')
      .eq('company_id', companyId),
    supabase
      .from('deadlines')
      .select('tax_deadline_type, due_date')
      .eq('company_id', companyId)
      .in('tax_deadline_type', TAX_DEADLINES_OF_INTEREST)
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .gte('due_date', today)
      .order('due_date', { ascending: true })
      .limit(3),
    supabase
      .from('journal_entries')
      .select('entry_date')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .order('entry_date', { ascending: false })
      .limit(1),
    // Revenue, result, 26xx and 1630 in one company-first pass. The previous
    // journal_entry_lines + journal_entries!inner embed could only be planned
    // from the line side and walked every tenant's lines (statement timeouts).
    supabase.rpc('get_onboarding_books_summary', { p_company_id: companyId }),
    // Same predicate as the journal list and the worklist; p_limit only sizes
    // the page, total_count covers the full set.
    supabase.rpc('verifikat_without_documents', { p_company_id: companyId, p_limit: 1, p_offset: 0 }),
    loadConnectedAiClients(supabase, userId),
  ])
  // A failed read stays an error: it must never surface as a zero balance.
  for (const result of results.slice(0, 11)) {
    if ('error' in result && result.error) throw result.error
  }
  const [
    { count: entryCount }, { data: periodRows }, { count: overdueCount },
    { count: uncategorizedCount }, { data: bankRows }, { count: txCount },
    { data: skvRows }, { data: deadlineRows }, { data: lastEntryRows },
    { data: summaryData }, { data: underlagData }, connectedAi,
  ] = results

  const periods = ((periodRows ?? []) as {
    id: string
    name: string
    period_start: string
    period_end: string
    is_closed: boolean
    continuity_verified: boolean | null
  }[]).map((p) => ({
    id: p.id,
    name: p.name,
    start: p.period_start,
    end: p.period_end,
    isClosed: p.is_closed,
    continuityVerified: p.continuity_verified ?? null,
  }))

  const summary = summaryData as BooksSummary | null
  if (!summary) throw new Error('get_onboarding_books_summary returned no payload')
  const underlag = underlagData as { ok?: boolean; code?: string; total_count?: number } | null
  if (!underlag?.ok || typeof underlag.total_count !== 'number') {
    throw new Error(`verifikat_without_documents failed: ${underlag?.code ?? 'no payload'}`)
  }

  // Figures for the latest period that actually has entries: for a migrated
  // company that is the last closed year, for a running one the current year.
  // A company without books shows no balances at all, not zeros.
  const hasBooks = (entryCount ?? 0) > 0
  const hasPeriod = hasBooks && summary.period_name !== null
  const revenue = hasPeriod && summary.revenue !== null ? toOre(summary.revenue) : null
  const result = hasPeriod && summary.result !== null ? toOre(summary.result) : null
  const periodName = hasPeriod ? summary.period_name : null
  const vatBalance = hasBooks ? toOre(summary.vat_balance ?? 0) : null
  const ledger1630 = hasBooks ? toOre(summary.ledger_1630 ?? 0) : null
  const missingUnderlag = hasBooks ? underlag.total_count : 0

  const bank = (bankRows ?? [])[0] as
    | { bank_name: string | null; status: string; last_sie_sweep: { auto_linked?: number; suggested?: number; unmatched?: number } | null }
    | undefined
  const skvActive = ((skvRows ?? []) as { status: string | null }[]).some((r) => r.status === 'active')

  return {
    books: {
      entries: entryCount ?? 0,
      periods: periods.map(({ id: _id, ...rest }) => rest),
      revenue,
      result,
      periodName,
      overdueInvoices: overdueCount ?? 0,
      vatBalance,
      uncategorizedTransactions: uncategorizedCount ?? 0,
      lastEntryDate: ((lastEntryRows ?? []) as { entry_date: string }[])[0]?.entry_date ?? null,
      missingUnderlag,
    },
    bank: {
      connected: !!bank,
      bankName: bank?.bank_name ?? null,
      transactions: txCount ?? 0,
      sweep: bank?.last_sie_sweep
        ? {
            auto_linked: bank.last_sie_sweep.auto_linked ?? 0,
            suggested: bank.last_sie_sweep.suggested ?? 0,
            unmatched: bank.last_sie_sweep.unmatched ?? 0,
          }
        : null,
    },
    skv: {
      connected: skvActive,
      ledger1630,
      nextDeadlines: ((deadlineRows ?? []) as { tax_deadline_type: string; due_date: string }[]).map((d) => ({
        type: d.tax_deadline_type,
        dueDate: d.due_date,
      })),
    },
    ai: { connected: connectedAi },
  }
}
