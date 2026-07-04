import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { validateQuery } from '@/lib/api/validate'
import { AccountBalancesQuerySchema } from '@/lib/api/schemas'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'

const log = createLogger('api.bookkeeping.account-balances')

/**
 * Per-account saldo as of a date. Used by the journal-entry form to show
 * each account's balance before the draft entry is posted.
 *
 * Mirrors the trial-balance model:
 *   - Balance-sheet accounts (class 1-2): IB + period activity through as_of.
 *   - P&L accounts (class 3-8):           period activity only (P&L resets
 *                                         each räkenskapsår; carrying a
 *                                         since-inception sum would violate
 *                                         BFNAR 2013:2).
 *
 * IB is sourced via getOpeningBalances() so SIE-imported and year-end-closed
 * companies behave identically. The opening-balance entry is excluded from
 * period activity to avoid double-counting its lines.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = validateQuery(request, AccountBalancesQuerySchema)
  if (!params.success) return params.response
  const { accounts, as_of } = params.data

  const companyId = await requireCompanyId(supabase, user.id)

  // Find the fiscal period containing as_of (any state: we want a reference
  // saldo even for closed/locked periods).
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, opening_balance_entry_id')
    .eq('company_id', companyId)
    .lte('period_start', as_of)
    .gte('period_end', as_of)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (periodError) {
    log.error('fiscal period lookup failed', { companyId, as_of, error: periodError.message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // No period anchor → no meaningful IB, return zeros so the UI degrades cleanly.
  if (!period) {
    return NextResponse.json({
      data: accounts.map((account_number) => ({ account_number, balance: 0 })),
    })
  }

  const { data: coaRows, error: coaError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_class')
    .eq('company_id', companyId)
    .in('account_number', accounts)

  if (coaError) {
    log.error('chart of accounts lookup failed', { companyId, error: coaError.message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const accountClass = new Map<string, number>()
  for (const row of coaRows ?? []) {
    accountClass.set(row.account_number, row.account_class)
  }

  let openingBalances: Map<string, { debit: number; credit: number }>
  let obEntryId: string | null
  try {
    const result = await getOpeningBalances(supabase, companyId, {
      period_start: period.period_start,
      opening_balance_entry_id: period.opening_balance_entry_id,
    })
    openingBalances = result.balances
    obEntryId = result.obEntryId
  } catch (err) {
    log.error('opening-balance computation failed', {
      companyId,
      period_id: period.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // Sum activity from period_start through as_of, excluding the OB entry
  // (its lines are already in openingBalances).
  let lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
  try {
    lines = await fetchAllRows<{
      account_number: string
      debit_amount: number
      credit_amount: number
    }>(({ from, to }) => {
      let query = supabase
        .from('journal_entry_lines')
        .select(
          'account_number, debit_amount, credit_amount, journal_entries!inner(company_id, status, entry_date)'
        )
        .eq('journal_entries.company_id', companyId)
        .in('account_number', accounts)
        .in('journal_entries.status', ['posted', 'reversed'])
        .gte('journal_entries.entry_date', period.period_start)
        .lte('journal_entries.entry_date', as_of)

      if (obEntryId) {
        query = query.neq('journal_entry_id', obEntryId)
      }

      // Stable total order for correct paging (see fetch-all.ts).
      return query.order('id', { ascending: true }).range(from, to)
    })
  } catch (err) {
    log.error('period activity lookup failed', {
      companyId,
      period_id: period.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const periodActivity = new Map<string, { debit: number; credit: number }>()
  for (const line of lines) {
    const existing = periodActivity.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    periodActivity.set(line.account_number, existing)
  }

  return NextResponse.json({
    data: accounts.map((account_number) => {
      // Fall back to inferring class from the first digit for accounts not in
      // the company's COA (e.g. system accounts the user typed manually).
      const klass = accountClass.get(account_number) ?? (parseInt(account_number[0], 10) || 0)
      const isBalanceSheet = klass >= 1 && klass <= 2

      const ib = isBalanceSheet
        ? openingBalances.get(account_number) || { debit: 0, credit: 0 }
        : { debit: 0, credit: 0 }
      const activity = periodActivity.get(account_number) || { debit: 0, credit: 0 }

      const net = ib.debit - ib.credit + activity.debit - activity.credit
      return {
        account_number,
        balance: Math.round(net * 100) / 100,
      }
    }),
  })
}
