import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  ACCOUNT_RUTA,
  calculatePeriodDates,
} from '@/lib/reports/vat-declaration'
import type { ReportSourceLine } from '@/lib/reports/source-lines'
import type { VatDeclarationRutor, VatPeriodType } from '@/types'

/**
 * GET /api/reports/vat-declaration/ruta/[ruta]/sources
 *
 * Returns the journal entry lines that contribute to a single ruta on the
 * VAT declaration. The mapping ruta → BAS accounts is the inverse of
 * `ACCOUNT_RUTA` in `lib/reports/vat-declaration.ts`.
 *
 * Period can be specified either via:
 *   ?periodType=monthly|quarterly|yearly&year=2026&period=5
 *   ?fiscal_period_id=<uuid>
 *
 * The periodType form mirrors the way the main VAT report is fetched.
 */
const PAGE_LIMIT = 500

export const GET = withRouteContext<{ params: Promise<{ ruta: string }> }>(
  'report.vat_declaration.ruta_sources',
  async (request, { supabase, companyId }, { params }) => {
  const { ruta: rutaParam } = await params

  const { searchParams } = new URL(request.url)
  const cursor = searchParams.get('cursor')

  // Normalise ruta param to the keyof VatDeclarationRutor (`ruta10`, `ruta48`).
  const rutaKey = (
    rutaParam.startsWith('ruta') ? rutaParam : `ruta${rutaParam}`
  ) as keyof VatDeclarationRutor

  // Invert ACCOUNT_RUTA: which BAS accounts feed this ruta?
  const accountsForRuta = Object.entries(ACCOUNT_RUTA)
    .filter(([, m]) => m.box === rutaKey)
    .map(([acc]) => acc)

  if (accountsForRuta.length === 0) {
    return NextResponse.json(
      { error: `Ruta ${rutaParam} har inga underliggande konton` },
      { status: 404 }
    )
  }

  // Resolve the period: either by fiscal_period_id or periodType/year/period.
  let start: string | null = null
  let end: string | null = null
  const fiscalPeriodId = searchParams.get('fiscal_period_id')
  if (fiscalPeriodId) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) {
      return NextResponse.json({ error: 'Period saknas' }, { status: 404 })
    }
    start = period.period_start
    end = period.period_end
  } else {
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    if (!periodType || !yearStr || !periodStr) {
      return NextResponse.json(
        { error: 'periodType/year/period or fiscal_period_id is required' },
        { status: 400 }
      )
    }
    const year = parseInt(yearStr, 10)
    const periodNum = parseInt(periodStr, 10)
    if (isNaN(year) || isNaN(periodNum)) {
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
    }
    const dates = calculatePeriodDates(periodType, year, periodNum)
    start = dates.start
    end = dates.end
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

  // Pull ALL contributing lines, then sort + paginate in JS.
  //
  // Why not order/limit in SQL: `.order(col, { foreignTable })` in PostgREST
  // sorts the *embedded* resource's rows, not the parent result set, so it
  // cannot give us a chronological parent order. Without a stable parent order
  // a raw `.limit()` returns an arbitrary subset that varies between identical
  // requests, making the drill-down show "different rows on every reload". We
  // page on the line PK (`id`) for a stable total order (see fetch-all.ts) and
  // do the chronological sort here, mirroring `generateGeneralLedger` and the
  // trial-balance sources route.
  const rows = await fetchAllRows<{
    id: string
    debit_amount: number
    credit_amount: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    journal_entries: any
  }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select(`
        id,
        account_number,
        debit_amount,
        credit_amount,
        journal_entries!inner(
          id,
          voucher_number,
          voucher_series,
          entry_date,
          description,
          status,
          company_id
        )
      `)
      .in('account_number', accountsForRuta)
      .eq('journal_entries.company_id', companyId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .gte('journal_entries.entry_date', start)
      .lte('journal_entries.entry_date', end)
      .order('id', { ascending: true })
      .range(from, to), { dedupeBy: (r) => r.id })

  // Map then sort in JS (date ASC, voucher_number ASC, journal_entry_id ASC as
  // a final deterministic tiebreak).
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

  let next_cursor: string | null = null
  if (afterCursor.length > PAGE_LIMIT && lines.length > 0) {
    const last = lines[lines.length - 1]
    next_cursor = `${last.date}|${last.voucher_number}`
  }

  return NextResponse.json({
    data: {
      ruta: rutaKey,
      lines,
      next_cursor,
    },
  })
})
