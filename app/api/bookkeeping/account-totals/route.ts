import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// GET /api/bookkeeping/account-totals?from=3000&to=3999[&date_from=..&date_to=..&group_by=month]
//
// Sums posted debit/credit per account in an account-number range, optionally
// bucketed by month. Both the entry list and the per-batch line fetches are
// paginated — PostgREST caps unpaginated selects at 1000 rows, which would
// silently under-count totals for companies with large journals.

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}$/, 'from must be a 4-digit account number'),
  to: z.string().regex(/^\d{4}$/, 'to must be a 4-digit account number'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  group_by: z.enum(['month']).optional(),
})

export const GET = withRouteContext('bookkeeping.account_totals', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validated = validateQuery(request, QuerySchema, {
    log,
    operation: 'bookkeeping.account_totals',
  })
  if (!validated.success) return validated.response
  const { from, to, date_from: dateFrom, date_to: dateTo, group_by: groupBy } = validated.data

  // Posted entries in range — paginated (large journals exceed 1000 entries).
  const entries = await fetchAllRows<{ id: string; entry_date: string }>(({ from: f, to: t }) => {
    let query = supabase
      .from('journal_entries')
      .select('id, entry_date')
      .eq('company_id', companyId)
      .eq('status', 'posted')

    if (dateFrom) query = query.gte('entry_date', dateFrom)
    if (dateTo) query = query.lte('entry_date', dateTo)

    return query.order('id', { ascending: true }).range(f, t)
  })

  if (entries.length === 0) {
    return NextResponse.json({ totals: [], monthly: groupBy === 'month' ? [] : undefined })
  }

  const entryIds = entries.map((e) => e.id)
  const entryDateMap = new Map(entries.map((e) => [e.id, e.entry_date]))

  // Fetch lines in id-batches to avoid URL length limits; each batch is
  // itself paginated (200 entries can easily carry >1000 lines).
  const batchSize = 200
  const allLines: Array<{
    journal_entry_id: string
    account_number: string
    debit_amount: number
    credit_amount: number
  }> = []

  for (let i = 0; i < entryIds.length; i += batchSize) {
    const batch = entryIds.slice(i, i + batchSize)
    const lines = await fetchAllRows<{
      journal_entry_id: string
      account_number: string
      debit_amount: number
      credit_amount: number
    }>(({ from: f, to: t }) =>
      supabase
        .from('journal_entry_lines')
        .select('journal_entry_id, account_number, debit_amount, credit_amount')
        .in('journal_entry_id', batch)
        .gte('account_number', from)
        .lte('account_number', to)
        .order('id', { ascending: true })
        .range(f, t)
    )
    allLines.push(...lines)
  }

  // Aggregate by account
  const accountTotals = new Map<string, { debit: number; credit: number }>()

  for (const line of allLines) {
    const existing = accountTotals.get(line.account_number) || { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    accountTotals.set(line.account_number, existing)
  }

  const totals = Array.from(accountTotals.entries())
    .map(([account_number, bal]) => ({
      account_number,
      debit: Math.round(bal.debit * 100) / 100,
      credit: Math.round(bal.credit * 100) / 100,
      net: Math.round((bal.debit - bal.credit) * 100) / 100,
    }))
    .sort((a, b) => a.account_number.localeCompare(b.account_number))

  // Monthly grouping
  if (groupBy === 'month') {
    const monthlyMap = new Map<string, Map<string, { debit: number; credit: number }>>()

    for (const line of allLines) {
      const entryDate = entryDateMap.get(line.journal_entry_id)
      if (!entryDate) continue
      const month = entryDate.slice(0, 7)
      if (!monthlyMap.has(month)) {
        monthlyMap.set(month, new Map())
      }
      const monthAccounts = monthlyMap.get(month)!
      const existing = monthAccounts.get(line.account_number) || { debit: 0, credit: 0 }
      existing.debit += Number(line.debit_amount) || 0
      existing.credit += Number(line.credit_amount) || 0
      monthAccounts.set(line.account_number, existing)
    }

    const monthlyFlat = Array.from(monthlyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([month, accounts]) =>
        Array.from(accounts.entries()).map(([account_number, bal]) => ({
          month,
          account_number,
          debit: Math.round(bal.debit * 100) / 100,
          credit: Math.round(bal.credit * 100) / 100,
          net: Math.round((bal.debit - bal.credit) * 100) / 100,
        }))
      )

    return NextResponse.json({ totals, monthly: monthlyFlat })
  }

  return NextResponse.json({ totals })
})
