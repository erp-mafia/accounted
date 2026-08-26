import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import {
  ACCOUNT_RUTA,
  resolvePeriodDates,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
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
 *   ?periodType=monthly|quarterly|yearly&year=2026&period=5[&fiscal_period_id=<uuid>]
 *   ?fiscal_period_id=<uuid>
 *
 * The periodType form mirrors the way the main VAT report is fetched, down to
 * the period resolution itself: it goes through `resolvePeriodDates`, the same
 * helper the declaration uses, so the drill-down can never answer a query
 * string with a different span than the figure it drills into.
 */
const PAGE_LIMIT = 500
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)

  // Invert the effective mapping. Explicit account treatments replace the
  // fixed BAS mapping and can move a standard account to another ruta.
  const accountsForRuta = Object.entries(ACCOUNT_RUTA)
    .filter(([account, m]) =>
      m.box === rutaKey && !dynamicVatAccounts.explicitAccounts.has(account)
    )
    .map(([acc]) => acc)

  for (const [account, mapping] of dynamicVatAccounts.mappingByAccount) {
    if (mapping.box === rutaKey) accountsForRuta.push(account)
  }

  if (accountsForRuta.length === 0) {
    return NextResponse.json(
      { error: `Ruta ${rutaParam} har inga underliggande konton` },
      { status: 404 }
    )
  }

  // Resolve the period. The periodType form is primary and resolves through
  // `resolvePeriodDates`, the same helper the declaration itself uses, with
  // fiscal_period_id threaded through exactly as the sibling vat-declaration
  // routes do. Helårsmoms is filed per räkenskapsår (SFL 26 kap 10-11 §§) and
  // a räkenskapsår is not always a calendar year (a first/changed year runs up
  // to 18 months, BFL 3 kap 3 §), so a plain Jan-Dec span would list a
  // different set of verifikat than the declaration was computed from.
  // Monthly/quarterly are calendar periods and resolve identically to before.
  // The fiscal_period_id-only form (no periodType) still selects the span from
  // the fiscal period's own bounds.
  const periodType = searchParams.get('periodType') as VatPeriodType | null
  const yearStr = searchParams.get('year')
  const periodStr = searchParams.get('period')
  const fiscalPeriodId = searchParams.get('fiscal_period_id')

  let start: string
  let end: string
  if (periodType && yearStr && periodStr) {
    if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return NextResponse.json({ error: 'Invalid periodType' }, { status: 400 })
    }
    const year = parseInt(yearStr, 10)
    const periodNum = parseInt(periodStr, 10)
    if (isNaN(year) || isNaN(periodNum)) {
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
    }
    const dates = await resolvePeriodDates(
      supabase,
      companyId,
      periodType,
      year,
      periodNum,
      fiscalPeriodId ?? undefined
    )
    start = dates.start
    end = dates.end
  } else if (fiscalPeriodId) {
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
    return NextResponse.json(
      { error: 'periodType/year/period or fiscal_period_id is required' },
      { status: 400 }
    )
  }

  // New cursors include entry and line IDs so multiple rows with the same
  // date and voucher number are paged without gaps. Two-part legacy cursors
  // remain accepted during rolling deployments.
  let cursorDate: string | null = null
  let cursorVoucherNum: number | null = null
  let cursorEntryId: string | null = null
  let cursorLineId: string | null = null
  if (cursor) {
    const parts = cursor.split('|')
    const [cd, cv, ce, cl] = parts
    cursorVoucherNum = parseInt(cv, 10)
    const validShape = parts.length === 2 || parts.length === 4
    const validIds = parts.length === 2 || (UUID_PATTERN.test(ce) && UUID_PATTERN.test(cl))
    if (
      !validShape ||
      !validIds ||
      !cd ||
      !/^\d{4}-\d{2}-\d{2}$/.test(cd) ||
      isNaN(cursorVoucherNum)
    ) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
    cursorDate = cd
    cursorEntryId = ce ?? null
    cursorLineId = cl ?? null
  }

  // The RPC orders and limits at the database. The old PostgREST join loaded
  // every matching line before slicing 500 in JavaScript, which timed out for
  // companies with long VAT histories.
  const { data: rows, error } = await supabase.rpc('get_vat_ruta_source_lines', {
    p_company_id: companyId,
    p_start: start,
    p_end: end,
    p_accounts: accountsForRuta,
    p_cursor_date: cursorDate,
    p_cursor_voucher_number: cursorVoucherNum,
    p_cursor_entry_id: cursorEntryId,
    p_cursor_line_id: cursorLineId,
    p_limit: PAGE_LIMIT + 1,
  })

  if (error) {
    throw Object.assign(new Error(`Failed to fetch VAT source lines: ${error.message}`), {
      code: error.code,
    })
  }

  const pageRows = (rows ?? []).slice(0, PAGE_LIMIT) as Array<{
    line_id: string
    journal_entry_id: string
    voucher_number: number
    voucher_series: string | null
    entry_date: string
    description: string | null
    debit_amount: number
    credit_amount: number
  }>

  const lines: ReportSourceLine[] = pageRows.map((row) => ({
    journal_entry_id: row.journal_entry_id,
    voucher_number: row.voucher_number,
    voucher_series: row.voucher_series || 'A',
    date: row.entry_date,
    description: row.description || '',
    debit: Math.round((Number(row.debit_amount) || 0) * 100) / 100,
    credit: Math.round((Number(row.credit_amount) || 0) * 100) / 100,
  }))

  let next_cursor: string | null = null
  if ((rows?.length ?? 0) > PAGE_LIMIT && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]
    next_cursor = [
      last.entry_date,
      last.voucher_number,
      last.journal_entry_id,
      last.line_id,
    ].join('|')
  }

  return NextResponse.json({
    data: {
      ruta: rutaKey,
      lines,
      next_cursor,
    },
  })
})
