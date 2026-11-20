import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { dbError } from '@/lib/errors/db-error'
import { roundOre } from '@/lib/money'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'
import { isIsoDateShaped } from '@/lib/invariants'
import { isUuid } from '@/lib/invariants/uuid'
import { parseReportDateRange, type DateRange } from '@/lib/reports/date-range'
import type { ReportSourceLine } from '@/lib/reports/source-lines'

/**
 * GET /api/reports/trial-balance/account/[accountNumber]/sources
 *
 * Returns the journal entry lines for one account in a fiscal period,
 * ordered by entry date, voucher number and line, the huvudbok's order. Used
 * by the trial balance drilldown UI to show the verifikat behind an
 * aggregated row. Optional from_date/to_date narrow it to the report's date
 * range, validated against the period exactly as the report validates them.
 *
 * Pagination uses an opaque cursor of `<entry_date>|<voucher_number>|<line
 * id>` for the last seen row; pass it back as `cursor` to continue.
 */
const PAGE_LIMIT = 500

/** Sorts after every line id: a two-part cursor resumes after its whole date and voucher number. */
const PAST_EVERY_LINE = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

interface PageLineRow {
  line_id: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  dimensions: Record<string, string> | null
  journal_entry_id: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number
  description: string | null
}

export const GET = withRouteContext<{ params: Promise<{ accountNumber: string }> }>(
  'report.trial_balance.account_sources',
  async (request, { supabase, companyId }, { params }) => {
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

  // The report's date range, so an expanded row lists the lines behind its
  // own Förändring. Read the period only when a range was asked for.
  let range: DateRange = {}
  if (searchParams.has('from_date') || searchParams.has('to_date')) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) {
      return NextResponse.json({ error: 'Räkenskapsåret saknas' }, { status: 404 })
    }
    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    range = parsed.range
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

  // Parse the optional cursor up front: <iso-date>|<voucher_number>|<line id>.
  // A cursor without the line id (handed out before it was added) resumes
  // after that date and voucher number, as it always did.
  let after: { date: string; voucher: number; line: string } | null = null
  if (cursor) {
    const [cd, cv, cl] = cursor.split('|')
    if (!isIsoDateShaped(cd) || !cv || !/^\d+$/.test(cv) || (cl !== undefined && !isUuid(cl))) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
    after = { date: cd, voucher: Number(cv), line: cl ?? PAST_EVERY_LINE }
  }

  // One page in SQL (get_general_ledger_account_page walks the account's
  // verifikat through ledger_account_entries once the company is built), one
  // line more than the page to know whether another follows.
  const { data, error } = await supabase.rpc('get_general_ledger_account_page', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_account_number: accountNumber,
    p_from_date: range.fromDate ?? null,
    p_to_date: range.toDate ?? null,
    p_exclude_entry_id: null,
    p_dimensions: dimFilter.dimensions ?? null,
    p_after_date: after?.date ?? null,
    p_after_voucher: after?.voucher ?? null,
    p_after_line_id: after?.line ?? null,
    p_limit: PAGE_LIMIT + 1,
  })
  if (error) throw dbError(error, 'get_general_ledger_account_page failed')
  const rows = ((data as { lines?: PageLineRow[] } | null)?.lines ?? []) as PageLineRow[]
  const page = rows.slice(0, PAGE_LIMIT)

  const lines: ReportSourceLine[] = page.map((row) => ({
    journal_entry_id: row.journal_entry_id,
    voucher_number: row.voucher_number,
    voucher_series: row.voucher_series || 'A',
    date: row.entry_date,
    description: row.description || '',
    debit: roundOre(Number(row.debit_amount) || 0),
    credit: roundOre(Number(row.credit_amount) || 0),
    ...(row.dimensions && Object.keys(row.dimensions).length > 0
      ? { dimensions: row.dimensions }
      : {}),
  }))

  // If more rows remain beyond this page, point the next cursor at the last
  // delivered row so the next call resumes from after it.
  const last = page[page.length - 1]
  const next_cursor = rows.length > PAGE_LIMIT && last
    ? `${last.entry_date}|${last.voucher_number}|${last.line_id}`
    : null

  return NextResponse.json({
    data: {
      account_number: account.account_number,
      account_name: account.account_name,
      lines,
      next_cursor,
    },
  })
})
