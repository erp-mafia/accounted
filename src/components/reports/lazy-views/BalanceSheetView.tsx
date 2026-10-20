'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { BalanceSheetReport } from '@/types'
import type { AccountDrilldown } from '@/components/reports/drilldown-click'

export default function BalanceSheetView({ periodId, dateRange, drilldown }: { periodId: string; dateRange: DateRangeValue; drilldown: AccountDrilldown }) {
  const reportQs = reportQuery(periodId, dateRange)
  const { data, loading, error } = useReportData<BalanceSheetReport>(
    `/api/reports/balance-sheet?${reportQs}`,
    'Kunde inte hämta balansräkning',
  )

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
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

      {/* Assets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tillgångar</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.asset_sections}
            drilldown={drilldown}
            footer={{ label: 'Summa tillgångar', amount: data.total_assets }}
          />
        </CardContent>
      </Card>

      {/* Equity and liabilities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Eget kapital och skulder</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ReportSectionTable
            sections={data.equity_liability_sections}
            drilldown={drilldown}
            footer={{ label: 'Summa eget kapital och skulder', amount: data.total_equity_liabilities }}
          />
        </CardContent>
      </Card>

      {/* Balance check */}
      <Card>
        <CardContent className="p-6">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Balanscheck</span>
            {isBalanced ? (
              <span className="text-sm text-muted-foreground">Balanserar</span>
            ) : (
              <div className="text-right">
                <Badge variant="destructive">Balanserar ej</Badge>
                <p className="text-sm text-destructive mt-1 tabular-nums">
                  Differens: {formatAmount(Math.abs(data.total_assets - data.total_equity_liabilities))} kr
                </p>
              </div>
            )}
          </div>
          {!isBalanced && data.imbalance_diagnosis && (
            <p className="text-sm text-muted-foreground mt-3 pt-3 border-t">
              {data.imbalance_diagnosis.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
