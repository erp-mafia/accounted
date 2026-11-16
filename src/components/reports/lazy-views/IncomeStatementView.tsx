'use client'

import dynamic from 'next/dynamic'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  ReportSectionTable,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount } from '@/lib/utils'
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
  const { data, loading, error, refetch } = useReportData<IncomeStatementReport>(
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
        description="Det finns inget bokfört underlag för den valda perioden."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/income-statement/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/income-statement/xlsx?${reportQs}` },
        ]}
      />

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

      {/* Operating result */}
      <Card>
        <CardContent className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Rörelseresultat</span>
          <span className={`font-display text-xl tabular-nums ${data.total_revenue - data.total_expenses >= 0 ? 'text-success' : 'text-destructive'}`}>
            {formatAmount(data.total_revenue - data.total_expenses)} kr
          </span>
        </CardContent>
      </Card>

      {/* Financial items */}
      {data.financial_sections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Finansiella poster</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportSectionTable
              sections={data.financial_sections}
              drilldown={drilldown}
              footer={{ label: 'Summa finansiella poster', amount: data.total_financial }}
            />
          </CardContent>
        </Card>
      )}

      {/* Net result */}
      <Card>
        <CardContent className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Årets resultat</span>
          <span className={`font-display text-xl tabular-nums ${data.net_result >= 0 ? 'text-success' : 'text-destructive'}`}>
            {formatAmount(data.net_result)} kr
          </span>
        </CardContent>
      </Card>
    </div>
  )
}
