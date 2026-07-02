import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import type { ReportSourceLine } from '@/lib/reports/source-lines'

/**
 * GET /api/reports/trial-balance/account/[accountNumber]/sources
 *
 * Returns the journal entry lines for one account in a fiscal period,
 * ordered by entry date then voucher number ASC. Used by the trial balance
 * drilldown UI to show the verifikat behind an aggregated row.
 *
 * Pagination uses an opaque cursor of `<entry_date>|<voucher_number>` for
 * the last seen row; pass it back as `cursor` to continue.
 */
const PAGE_LIMIT = 500

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountNumber: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)
  const { accountNumber } = await params

  const { searchParams } = new URL(request.url)
  const fiscalPeriodId = searchParams.get('fiscal_period_id')
  const cursor = searchParams.get('cursor')

  if (!fiscalPeriodId) {
    return NextResponse.json(
      { error: 'fiscal_period_id is required' },
      { status: 400 }
    )
  }

  // Same filter as the parent report, so drill-down totals match the row the
  // user expanded (a filtered resultatrapport row must not expand to
  // unfiltered lines).
  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  // Look up account name (and verify account belongs to the company)
  const { data: account } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name')
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .maybeSingle()

  if (!account) {
    return NextResponse.json(
      { error: 'Konto saknas' },
      { status: 404 }
    )
  }

  // Parse the optional cursor up front (format: <iso-date>|<voucher_number>).
  // Pagination is applied in JS after a full, deterministically-ordered fetch.
  let cursorDate: string | null = null
  let cursorVoucherNum = 0
  if (cursor) {
    const [cd, cv] = cursor.split('|')
    cursorVoucherNum = parseInt(cv, 10)
    // The cursor is applied in JS (string compare); structurally validating the
    // date component here is defense-in-depth against malformed/injection cursors.
    if (!cd || !/^\d{4}-\d{2}-\d{2}$/.test(cd) || isNaN(cursorVoucherNum)) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
    cursorDate = cd
  }

  // Pull ALL lines on this account in this period, then sort + paginate in JS.
  //
  // Why not order/limit in SQL: `.order(col, { foreignTable })` in PostgREST
  // sorts the *embedded* resource's rows, not the parent result set, so it
  // cannot give us a chronological parent order. Without a stable parent order
  // a raw `.limit()` returns an arbitrary subset that varies between identical
  // requests — which surfaced as the trial-balance drill-down showing
  // "different rows on every reload" for high-volume accounts. We instead page
  // on the line PK (`id`) for a stable total order (see fetch-all.ts) and do
  // the chronological sort here, mirroring `generateGeneralLedger`.
  const rows = await fetchAllRows<{
    id: string
    debit_amount: number
    credit_amount: number
    dimensions: Record<string, string> | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journal_entries: any
  }>(({ from, to }) => {
    let query = supabase
      .from('journal_entry_lines')
      .select(`
        id,
        debit_amount,
        credit_amount,
        dimensions,
        journal_entry_id,
        journal_entries!inner(
          id,
          voucher_number,
          voucher_series,
          entry_date,
          description,
          status,
          company_id,
          fiscal_period_id
        )
      `)
      .eq('account_number', accountNumber)
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])

    if (dimFilter.dimensions) {
      // jsonb containment (@>) — served by idx_jel_dimensions_gin.
      query = query.contains('dimensions', dimFilter.dimensions)
    }

    return query.order('id', { ascending: true }).range(from, to)
  }, { dedupeBy: (r) => r.id })

  // Map then sort in JS (date ASC, voucher_number ASC, journal_entry_id ASC as
  // a final deterministic tiebreak for lines sharing a date and voucher number
  // across series).
  const allMapped: ReportSourceLine[] = rows.map((row) => ({
    journal_entry_id: row.journal_entries.id,
    voucher_number: row.journal_entries.voucher_number,
    voucher_series: row.journal_entries.voucher_series || 'A',
    date: row.journal_entries.entry_date,
    description: row.journal_entries.description || '',
    debit: Math.round((Number(row.debit_amount) || 0) * 100) / 100,
    credit: Math.round((Number(row.credit_amount) || 0) * 100) / 100,
    ...(row.dimensions && Object.keys(row.dimensions).length > 0
      ? { dimensions: row.dimensions }
      : {}),
  }))
  allMapped.sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date)
    if (dateComp !== 0) return dateComp
    if (a.voucher_number !== b.voucher_number) return a.voucher_number - b.voucher_number
    return a.journal_entry_id.localeCompare(b.journal_entry_id)
  })

  // Apply the cursor in JS: keep rows strictly after (date, voucher_number).
  const afterCursor = cursorDate
    ? allMapped.filter(
        (l) =>
          l.date > cursorDate! ||
          (l.date === cursorDate! && l.voucher_number > cursorVoucherNum)
      )
    : allMapped

  const lines = afterCursor.slice(0, PAGE_LIMIT)

  // If more rows remain beyond this page, point the next cursor at the last
  // delivered row so the next call resumes from after it.
  let next_cursor: string | null = null
  if (afterCursor.length > PAGE_LIMIT && lines.length > 0) {
    const last = lines[lines.length - 1]
    next_cursor = `${last.date}|${last.voucher_number}`
  }

  return NextResponse.json({
    data: {
      account_number: account.account_number,
      account_name: account.account_name,
      lines,
      next_cursor,
    },
  })
}
