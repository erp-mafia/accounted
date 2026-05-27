import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ruta: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)
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

  // Resolve the period — either by fiscal_period_id or periodType/year/period.
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

  let query = supabase
    .from('journal_entry_lines')
    .select(`
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
    .order('entry_date', { foreignTable: 'journal_entries', ascending: true })
    .order('voucher_number', { foreignTable: 'journal_entries', ascending: true })
    .limit(PAGE_LIMIT + 1)

  if (cursor) {
    const [cursorDate, cursorVoucher] = cursor.split('|')
    const cursorVoucherNum = parseInt(cursorVoucher, 10)
    if (!cursorDate || isNaN(cursorVoucherNum)) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
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

  const lines: ReportSourceLine[] = rows
    .slice(0, PAGE_LIMIT)
    .map((row) => ({
      journal_entry_id: row.journal_entries.id,
      voucher_number: row.journal_entries.voucher_number,
      voucher_series: row.journal_entries.voucher_series || 'A',
      date: row.journal_entries.entry_date,
      description: row.journal_entries.description || '',
      debit: Math.round((Number(row.debit_amount) || 0) * 100) / 100,
      credit: Math.round((Number(row.credit_amount) || 0) * 100) / 100,
    }))

  let next_cursor: string | null = null
  if (rows.length > PAGE_LIMIT && lines.length > 0) {
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
}
