'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { accountDrilldownClick } from '@/components/reports/drilldown-click'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount } from '@/lib/utils'
import { formatLatestVouchers } from '@/lib/reports/latest-vouchers-format'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'
import type { ResultatrapportReport } from '@/types'

export default function ResultatrapportView({ periodId, dateRange, dimensionFilter = null, onNavigateToAccount }: { periodId: string; dateRange: DateRangeValue; dimensionFilter?: DimensionFilterValue | null; onNavigateToAccount: (account: string) => void }) {
  const t = useTranslations('reports')
  const reportQs = reportQuery(periodId, dateRange, dimensionFilter)
  const { data, loading, error } = useReportData<ResultatrapportReport>(
    `/api/reports/resultatrapport?${reportQs}`,
    'Kunde inte hämta resultatrapport',
  )
  const latestVouchers = formatLatestVouchers(data?.latest_vouchers)

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} />
  }

  if (!data || data.groups.length === 0) {
    return (
      <ReportEmptyState
        title="Inga intäkter eller kostnader"
        description="Det finns inga bokförda intäkter eller kostnader i den valda perioden."
      />
    )
  }

  const hasPrior = data.prior_period !== null
  const colCount = 4

  return (
    <div className="space-y-4">
      {/* The export menu and the latest-voucher line share one row. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {latestVouchers && (
          <p className="text-sm text-muted-foreground">
            {t('latest_posted_vouchers')}: {latestVouchers}
          </p>
        )}
        <ReportExportMenu
          items={[
          { format: 'pdf', href: `/api/reports/resultatrapport/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/resultatrapport/xlsx?${reportQs}` },
          ]}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  <th
                    className="text-right font-medium px-4 py-2 w-32 tabular-nums"
                    title={`${data.period.start} till ${data.period.end}`}
                  >
                    Innevarande
                  </th>
                  <th
                    className="text-right font-medium px-4 py-2 w-32 tabular-nums"
                    title={hasPrior ? `${data.prior_period!.start} till ${data.prior_period!.end}` : undefined}
                  >
                    Föregående
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <React.Fragment key={group.class}>
                    <tr className="bg-muted/30">
                      <td colSpan={colCount} className="px-4 py-2 text-[12.5px] font-semibold text-muted-foreground">
                        {group.class_label}
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr
                        key={row.account_number}
                        className="border-b last:border-0 cursor-pointer hover:bg-secondary/35 transition-colors"
                        onClick={accountDrilldownClick(onNavigateToAccount, row.account_number)}
                      >
                        <td className="px-4 py-1.5">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="px-4 py-1.5">{row.account_name}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(row.current_period)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                          {hasPrior ? formatAmount(row.prior_period) : '-'}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_current)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
                        {hasPrior ? formatAmount(group.subtotal_prior) : '-'}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <div className="grid gap-x-6 items-baseline grid-cols-[1fr_auto_auto]">
            <span className="text-sm font-medium">Beräknat resultat</span>
            <span className={`font-display text-xl tabular-nums w-32 text-right ${data.net_result_current >= 0 ? 'text-success' : 'text-destructive'}`}>
              {formatAmount(data.net_result_current)} kr
            </span>
            <span className="tabular-nums text-sm text-muted-foreground w-32 text-right">
              {hasPrior ? `${formatAmount(data.net_result_prior)} kr` : '-'}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
