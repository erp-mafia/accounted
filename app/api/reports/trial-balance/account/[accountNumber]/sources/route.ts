import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
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

  // Pull all lines on this account in this period. We rely on the same
  // join+filter pattern as `generateTrialBalance`. Pagination is server-side
  // via cursor so even an account with tens of thousands of rows stays cheap.
  let query = supabase
    .from('journal_entry_lines')
    .select(`
      debit_amount,
      credit_amount,
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
    .limit(PAGE_LIMIT + 1)

  if (cursor) {
    // Cursor format: <iso-date>|<voucher_number>
    const [cursorDate, cursorVoucher] = cursor.split('|')
    const cursorVoucherNum = parseInt(cursorVoucher, 10)
    if (!cursorDate || isNaN(cursorVoucherNum)) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
    // Filter for rows strictly after the cursor (date>cur OR same date & voucher>cur).
    // Supabase doesn't expose tuple compare, so use an `or()` clause.
    query = query.or(
      `entry_date.gt.${cursorDate},and(entry_date.eq.${cursorDate},voucher_number.gt.${cursorVoucherNum})`,
      { foreignTable: 'journal_entries' }
    )
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data || []) as any[]

  // Map all rows then sort in JS (date ASC, voucher_number ASC).
  // .order({ foreignTable }) in Supabase sorts the embedded resource's rows,
  // not the parent result set, so we cannot rely on DB ordering here.
  // This mirrors the sort in generateGeneralLedger.
  const allMapped: ReportSourceLine[] = rows.map((row) => ({
    journal_entry_id: row.journal_entries.id,
    voucher_number: row.journal_entries.voucher_number,
    voucher_series: row.journal_entries.voucher_series || 'A',
    date: row.journal_entries.entry_date,
    description: row.journal_entries.description || '',
    debit: Math.round((Number(row.debit_amount) || 0) * 100) / 100,
    credit: Math.round((Number(row.credit_amount) || 0) * 100) / 100,
  }))
  allMapped.sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date)
    return dateComp !== 0 ? dateComp : a.voucher_number - b.voucher_number
  })
  const lines = allMapped.slice(0, PAGE_LIMIT)

  // If we got more than PAGE_LIMIT rows back, the next cursor points at the
  // last delivered row so the next call resumes from after it.
  let next_cursor: string | null = null
  if (rows.length > PAGE_LIMIT && lines.length > 0) {
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
