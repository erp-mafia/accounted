'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusGlyph } from '@/components/ui/status-glyph'
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
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { BalanceSheetReport } from '@/types'
import type { AccountDrilldown } from '@/components/reports/drilldown-click'

export default function BalanceSheetView({ periodId, dateRange, drilldown }: { periodId: string; dateRange: DateRangeValue; drilldown: AccountDrilldown }) {
  const reportQs = reportQuery(periodId, dateRange)
  const { data, dataStatus, loading, error, refetch } = useReportData<BalanceSheetReport>(
    `/api/reports/balance-sheet?${reportQs}`,
    'Kunde inte hämta balansräkning',
  )

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

  const isBalanced = Math.abs(data.total_assets - data.total_equity_liabilities) < 0.01

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `/api/reports/balance-sheet/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/balance-sheet/xlsx?${reportQs}` },
        ]}
      />

      {/* How far these figures can be trusted, as on Nyckeltal. */}
      {dataStatus && <KPIFreshness status={dataStatus} />}

      {/* Assets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tillgångar</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable
            sections={data.asset_sections}
            drilldown={drilldown}
            footer={{ label: 'Summa tillgångar', amount: data.total_assets, headline: true }}
          />
        </CardContent>
      </Card>

      {/* Equity and liabilities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eget kapital och skulder</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportSectionTable
            sections={data.equity_liability_sections}
            drilldown={drilldown}
            footer={{ label: 'Summa eget kapital och skulder', amount: data.total_equity_liabilities, headline: true }}
          />
        </CardContent>
      </Card>

      {/* Balance check: one line under the totals (board Rapporter-v3). */}
      <div className="border-t-hairline pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-strong">Balanscheck</span>
          {isBalanced ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <StatusGlyph tone="ok" />
              Balanserar
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-destructive tabular-nums">
              <StatusGlyph tone="error" />
              Balanserar ej: differens {formatAmount(Math.abs(data.total_assets - data.total_equity_liabilities))} kr
            </span>
          )}
        </div>
        {!isBalanced && data.imbalance_diagnosis && (
          <p className="mt-2 text-[13px] text-muted-foreground">{data.imbalance_diagnosis.message}</p>
        )}
      </div>
    </div>
  )
}
