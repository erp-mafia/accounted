import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { FinancialStatementPDF } from '@/lib/reports/financial-statement-pdf-template'
import { requireCompanyId } from '@/lib/company/context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!companyRow) {
    return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 404 })
  }
  // An identifiable period is part of räkenskapsinformation (BFL 7 kap). Refuse
  // to render a PDF that can't be archived with the period it refers to.
  if (!period) {
    return NextResponse.json(
      { error: 'Räkenskapsperioden kunde inte läsas. Välj en befintlig period innan du genererar PDF.' },
      { status: 400 }
    )
  }

  const parsedRange = parseReportDateRange(searchParams, period)
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 })
  }
  const range = parsedRange.range
  const effectiveStart = range.fromDate ?? period.period_start
  const effectiveEnd = range.toDate ?? period.period_end

  try {
    const report = await generateBalanceSheet(supabase, companyId, periodId, range)
    report.period = { start: effectiveStart, end: effectiveEnd }

    const totalAssets = report.total_assets
    const totalEquityLiab = report.total_equity_liabilities

    // ÅRL 3 kap / K2 / K3 require balansräkningen to balance. Compare rounded
    // to whole kronor: matches SFL 22:1's truncation convention for statutory
    // reports and is immune to floating-point accumulation across hundreds of
    // ledger lines (öresavrundning noise under half a krona is never a real
    // accounting error). The on-screen view still surfaces a "Balanserar ej"
    // warning at öre precision so users can diagnose smaller discrepancies.
    const diffInKronor = Math.abs(Math.round(totalAssets) - Math.round(totalEquityLiab))
    if (diffInKronor >= 1) {
      return NextResponse.json(
        {
          error:
            'Balansräkningen balanserar inte (tillgångar ≠ eget kapital och skulder). Åtgärda differensen innan du genererar PDF.',
        },
        { status: 400 }
      )
    }

    const pdfBuffer = await renderToBuffer(
      FinancialStatementPDF({
        title: 'Balansräkning',
        groups: [
          {
            heading: 'Tillgångar',
            sections: report.asset_sections,
            totalLabel: 'Summa tillgångar',
            total: totalAssets,
          },
          {
            heading: 'Eget kapital och skulder',
            sections: report.equity_liability_sections,
            totalLabel: 'Summa eget kapital och skulder',
            total: totalEquityLiab,
          },
        ],
        period: report.period,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    // "-utkast" suffix keeps the draft status visible even after the file
    // leaves the browser: complements the in-document ÅRL 2:7 disclaimer.
    const filename = `balansrakning-${report.period.start}--${report.period.end}-utkast.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera balansräkning' },
      { status: 500 }
    )
  }
}
