import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { FinancialStatementPDF, type FinancialStatementGroup, type FinancialStatementSection, type FinancialStatementSummaryRow } from '@/lib/reports/financial-statement-pdf-template'
import { requireCompanyId } from '@/lib/company/context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import type { CompanySettings } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'

// K2/K3 uppställningsform (ÅRL bilaga 2, kostnadsslagsindelad) splits class 8
// into three named blocks with subtotals:
//   80–84 → Finansiella poster (followed by "Resultat efter finansiella poster")
//   88   → Bokslutsdispositioner
//   89   → Skatt på årets resultat
// The generator lumps these together under financial_sections, so we split
// here by the first row's account prefix.
const FINANSIELLA_POSTER_PREFIXES = ['80', '81', '82', '83', '84']
const BOKSLUTSDISPOSITIONER_PREFIXES = ['88']
const SKATT_PREFIXES = ['89']
const KNOWN_CLASS_8_PREFIXES = [
  ...FINANSIELLA_POSTER_PREFIXES,
  ...BOKSLUTSDISPOSITIONER_PREFIXES,
  ...SKATT_PREFIXES,
]

function sectionPrefix(section: FinancialStatementSection, prefixes: string[]): boolean {
  if (section.rows.length === 0) return false
  const acc = section.rows[0].account_number
  return prefixes.some((p) => acc.startsWith(p))
}

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

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateIncomeStatement(supabase, companyId, periodId, {
      ...range,
      dimensions: dimFilter.dimensions,
    })
    report.period = { start: effectiveStart, end: effectiveEnd }

    const operatingResult = Math.round((report.total_revenue - report.total_expenses) * 100) / 100

    // Split class 8 into its three K2/K3 blocks plus a catch-all for any
    // prefix the generator emits but we haven't explicitly mapped. If a future
    // generator change adds sections for 85/86/87 or similar, this keeps them
    // visible and arithmetically accounted for rather than silently dropped.
    const finansiellaPosterSections = report.financial_sections.filter((s) =>
      sectionPrefix(s, FINANSIELLA_POSTER_PREFIXES),
    )
    const bokslutsdispositionerSections = report.financial_sections.filter((s) =>
      sectionPrefix(s, BOKSLUTSDISPOSITIONER_PREFIXES),
    )
    const skattSections = report.financial_sections.filter((s) =>
      sectionPrefix(s, SKATT_PREFIXES),
    )
    const ovrigaFinansiellaPosterSections = report.financial_sections.filter(
      (s) => !sectionPrefix(s, KNOWN_CLASS_8_PREFIXES),
    )

    const totalFinansiellaPoster = Math.round(
      finansiellaPosterSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
    ) / 100
    const totalBokslutsdispositioner = Math.round(
      bokslutsdispositionerSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
    ) / 100
    const totalSkatt = Math.round(
      skattSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
    ) / 100
    const totalOvrigaFinansiellaPoster = Math.round(
      ovrigaFinansiellaPosterSections.reduce((sum, s) => sum + s.subtotal, 0) * 100,
    ) / 100
    // Catch-all is treated as part of "finansiella poster" for the subtotal —
    // 85-87 accounts in BAS are financial-adjacent (not tax, not bokslut).
    const resultatEfterFinansiellaPoster = Math.round(
      (operatingResult + totalFinansiellaPoster + totalOvrigaFinansiellaPoster) * 100,
    ) / 100

    const groups: FinancialStatementGroup[] = [
      {
        heading: 'Rörelseintäkter',
        sections: report.revenue_sections,
        totalLabel: 'Summa rörelseintäkter',
        total: report.total_revenue,
      },
      {
        heading: 'Rörelsekostnader',
        sections: report.expense_sections,
        totalLabel: 'Summa rörelsekostnader',
        total: report.total_expenses,
        negate: true,
      },
    ]

    if (finansiellaPosterSections.length > 0) {
      groups.push({
        heading: 'Finansiella poster',
        sections: finansiellaPosterSections,
        totalLabel: 'Summa finansiella poster',
        total: totalFinansiellaPoster,
      })
    }
    if (ovrigaFinansiellaPosterSections.length > 0) {
      groups.push({
        heading: 'Övriga finansiella poster',
        sections: ovrigaFinansiellaPosterSections,
        totalLabel: 'Summa övriga finansiella poster',
        total: totalOvrigaFinansiellaPoster,
      })
    }
    if (bokslutsdispositionerSections.length > 0) {
      groups.push({
        heading: 'Bokslutsdispositioner',
        sections: bokslutsdispositionerSections,
        totalLabel: 'Summa bokslutsdispositioner',
        total: totalBokslutsdispositioner,
      })
    }
    if (skattSections.length > 0) {
      groups.push({
        heading: 'Skatter',
        sections: skattSections,
        totalLabel: 'Summa skatter',
        total: totalSkatt,
      })
    }

    // K2/K3 uppställningsform (ÅRL bilaga 2) summary structure:
    //   Rörelseresultat
    //   Resultat efter finansiella poster (only if finansiella poster present)
    //   Bokslutsdispositioner (only if present)
    //   Skatt på årets resultat (always, so the reader can verify the tax calc)
    //   Årets resultat
    const summary: FinancialStatementSummaryRow[] = [
      { label: 'Rörelseresultat', amount: operatingResult },
    ]
    if (
      finansiellaPosterSections.length > 0 ||
      ovrigaFinansiellaPosterSections.length > 0
    ) {
      summary.push({
        label: 'Resultat efter finansiella poster',
        amount: resultatEfterFinansiellaPoster,
      })
    }
    if (bokslutsdispositionerSections.length > 0) {
      summary.push({ label: 'Bokslutsdispositioner', amount: totalBokslutsdispositioner })
    }
    summary.push({ label: 'Skatt på årets resultat', amount: totalSkatt })
    summary.push({ label: 'Årets resultat', amount: report.net_result, emphasis: true })

    const pdfBuffer = await renderToBuffer(
      FinancialStatementPDF({
        // Partial-view disclosure in the document title (BFNAR 2013:2).
        title: dimensionFilterDisclosure(dimFilter.dimensions)
          ? `Resultaträkning — ${dimensionFilterDisclosure(dimFilter.dimensions)}`
          : 'Resultaträkning',
        groups,
        summary,
        period: report.period,
        company: companyRow as CompanySettings,
        generatedAt: new Date().toISOString(),
      })
    )

    // "-utkast" suffix keeps the draft status visible even after the file
    // leaves the browser — complements the in-document ÅRL 2:7 disclaimer.
    const filename = `resultatrakning${dimensionFilterFileSuffix(dimFilter.dimensions)}-${report.period.start}--${report.period.end}-utkast.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera resultaträkning' },
      { status: 500 }
    )
  }
}
