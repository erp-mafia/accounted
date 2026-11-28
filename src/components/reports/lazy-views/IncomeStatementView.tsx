'use client'

import dynamic from 'next/dynamic'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { KPIFreshness } from '@/components/kpi/KPIFreshness'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  ReportSectionTable,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount } from '@/lib/utils'
import { NET_RESULT_LABEL } from '@/lib/reports/income-definitions'
import { incomeStatementLayout, type IncomeStatementClass8Block } from '@/lib/reports/financial-statement-pdf'
import { RESULT_AFTER_FINANCIAL_LABEL } from '@/lib/reports/class-8-groups'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'
import type { IncomeStatementReport } from '@/types'
import type { AccountDrilldown } from '@/components/reports/drilldown-click'

// Recharts is ~180KB: defer the chart so the report tables (the regulated
// content) render without waiting for the charting bundle.
const IncomeExpenseChart = dynamic(
  () => import('@/components/reports/IncomeExpenseChart').then((m) => m.IncomeExpenseChart),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> },
)

export default function IncomeStatementView({ periodId, dateRange, dimensionFilter = null, drilldown }: { periodId: string; dateRange: DateRangeValue; dimensionFilter?: DimensionFilterValue | null; drilldown: AccountDrilldown }) {
  const reportQs = reportQuery(periodId, dateRange, dimensionFilter)
  const { data, dataStatus, loading, error, refetch } = useReportData<IncomeStatementReport>(
    `/api/reports/income-statement?${reportQs}`,
    'Kunde inte hämta resultaträkning',
  )

  // Monthly breakdown is full-period by design (it IS the per-month view),
  // so the date range only affects the headline numbers above the chart.
  // The dimension filter DOES apply: a dimension-scoped view must not
  // silently chart company-wide months. A failure just leaves the chart out.
  const monthly = useReportData<{ months?: MonthlyDataPoint[] }>(
    `/api/reports/monthly-breakdown?${reportQuery(periodId, undefined, dimensionFilter)}`,
    'Kunde inte hämta resultaträkning',
  )
  const monthlyLoading = monthly.loading
  const monthlyData = monthly.data?.months ?? []

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} onRetry={refetch} />
  }

  if (!data) {
    return (
      <ReportEmptyState
        title="Ingen data för perioden"
        description="Välj ett annat räkenskapsår eller datumintervall."
      />
    )
  }

  const layout = incomeStatementLayout(data)
  const aboveTheLine = layout.class8.filter((block) => block.group.aboveResultAfterFinancial)
  const belowTheLine = layout.class8.filter((block) => !block.group.aboveResultAfterFinancial)

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/income-statement/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/income-statement/xlsx?${reportQs}` },
        ]}
      />

      {/* How far these figures can be trusted, from the same answer: shown
          with the figures it describes and printed with the page, as on
          Nyckeltal. */}
      {dataStatus && <KPIFreshness status={dataStatus} />}

      {!monthlyLoading && monthlyData.length > 0 && (
        <IncomeExpenseChart months={monthlyData} />
      )}

      {/* Revenue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rörelseintäkter</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable
            sections={data.revenue_sections}
            drilldown={drilldown}
            footer={{ label: 'Summa rörelseintäkter', amount: data.total_revenue }}
          />
        </CardContent>
      </Card>

      {/* Expenses */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rörelsekostnader</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable
            sections={data.expense_sections}
            negate
            drilldown={drilldown}
            footer={{ label: 'Summa rörelsekostnader', amount: data.total_expenses, negate: true }}
          />
        </CardContent>
      </Card>

      <ResultLine label="Rörelseresultat" amount={layout.operatingResult} />

      {/* Class 8 in the uppställningsform's blocks, as the PDF prints it:
          Finansiella poster, then Resultat efter finansiella poster, then
          Bokslutsdispositioner and Skatter. */}
      {aboveTheLine.map((block) => (
        <Class8BlockCard key={block.group.key} block={block} drilldown={drilldown} />
      ))}
      {layout.resultAfterFinancial !== null && (
        <ResultLine label={RESULT_AFTER_FINANCIAL_LABEL} amount={layout.resultAfterFinancial} />
      )}
      {belowTheLine.map((block) => (
        <Class8BlockCard key={block.group.key} block={block} drilldown={drilldown} />
      ))}

      <ResultLine label={NET_RESULT_LABEL} amount={data.net_result} />
    </div>
  )
}

/** A result line between the statement's blocks: Rörelseresultat and the lines after it. */
function ResultLine({ label, amount }: { label: string; amount: number }) {
  return (
    <Card>
      <CardContent className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={`font-display text-xl tabular-nums ${amount >= 0 ? 'text-success' : 'text-destructive'}`}>
          {formatAmount(amount)} kr
        </span>
      </CardContent>
    </Card>
  )
}

function Class8BlockCard({ block, drilldown }: { block: IncomeStatementClass8Block; drilldown: AccountDrilldown }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{block.group.heading}</CardTitle>
      </CardHeader>
      <CardContent>
        <ReportSectionTable
          sections={block.sections}
          drilldown={drilldown}
          footer={{ label: block.group.totalLabel, amount: block.total }}
        />
      </CardContent>
    </Card>
  )
}
