import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveMissingUnderlagEntries } from '@/lib/bookkeeping/missing-underlag'
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

interface LineRow {
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
}

const num = (v: number | string | null | undefined) => (typeof v === 'string' ? Number(v) : (v ?? 0))
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * Revenue and result from a period's lines. Revenue: class 3 credit minus
 * debit. Result: the same sign convention across classes 3 to 8 (income
 * positive, costs negative). Pure so the test can pin the signs.
 */
export function summarizeLines(lines: LineRow[]): { revenue: number; result: number } {
  let revenue = 0
  let result = 0
  for (const l of lines) {
    const cls = l.account_number.charAt(0)
    const net = num(l.credit_amount) - num(l.debit_amount)
    if (cls === '3') revenue += net
    if (cls >= '3' && cls <= '8') result += net
  }
  return { revenue: round2(revenue), result: round2(result) }
}

/** Balance of an asset-side account range: debit minus credit. */
export function assetBalance(lines: LineRow[]): number {
  let bal = 0
  for (const l of lines) bal += num(l.debit_amount) - num(l.credit_amount)
  return round2(bal)
}

/** Balance of a liability-side range (26xx): credit minus debit, positive = owed to SKV. */
export function liabilityBalance(lines: LineRow[]): number {
  return round2(-assetBalance(lines))
}

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
    loadConnectedAiClients(supabase, userId),
  ])
  for (const result of results.slice(0, 9)) {
    if ('error' in result && result.error) throw result.error
  }
  const [
    { count: entryCount }, { data: periodRows }, { count: overdueCount },
    { count: uncategorizedCount }, { data: bankRows }, { count: txCount },
    { data: skvRows }, { data: deadlineRows }, { data: lastEntryRows }, connectedAi,
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

  // Figures for the latest period that actually has entries: for a migrated
  // company that is the last closed year, for a running one the current year.
  let revenue: number | null = null
  let result: number | null = null
  let periodName: string | null = null
  if ((entryCount ?? 0) > 0) {
    for (const p of [...periods].reverse()) {
      const lines = await fetchAllRows<LineRow>((range) =>
        supabase
          .from('journal_entry_lines')
          .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, status, entry_date)')
          .eq('journal_entries.company_id', companyId)
          .in('journal_entries.status', ['posted', 'reversed'])
          .gte('journal_entries.entry_date', p.start)
          .lte('journal_entries.entry_date', p.end)
          .order('id')
          .range(range.from, range.to),
      )
      if (lines.length === 0) continue
      const s = summarizeLines(lines)
      revenue = s.revenue
      result = s.result
      periodName = p.name
      break
    }
  }

  let vatBalance: number | null = null
  let ledger1630: number | null = null
  if ((entryCount ?? 0) > 0) {
    const [vatLines, skvLines] = await Promise.all([
      fetchAllRows<LineRow>((range) =>
        supabase
          .from('journal_entry_lines')
          .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, status)')
          .eq('journal_entries.company_id', companyId)
          .in('journal_entries.status', ['posted', 'reversed'])
          .gte('account_number', '2600')
          .lte('account_number', '2699')
          .order('id')
          .range(range.from, range.to),
      ),
      fetchAllRows<LineRow>((range) =>
        supabase
          .from('journal_entry_lines')
          .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, status)')
          .eq('journal_entries.company_id', companyId)
          .in('journal_entries.status', ['posted', 'reversed'])
          .eq('account_number', '1630')
          .order('id')
          .range(range.from, range.to),
      ),
    ])
    vatBalance = liabilityBalance(vatLines)
    ledger1630 = assetBalance(skvLines)
  }

  let missingUnderlag = 0
  if ((entryCount ?? 0) > 0) {
    missingUnderlag = (await resolveMissingUnderlagEntries(supabase, companyId, {}, { idOnly: true })).length
  }

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
