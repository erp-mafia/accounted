'use client'

import React from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { accountDrilldownClick, type AccountDrilldown } from '@/components/reports/drilldown-click'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { cn, formatAmount } from '@/lib/utils'
import { formatLatestVouchers } from '@/lib/reports/latest-vouchers-format'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { BalansrapportReport, BalansrapportSection } from '@/types'

export default function BalansrapportView({ periodId, dateRange, drilldown }: { periodId: string; dateRange: DateRangeValue; drilldown: AccountDrilldown }) {
  const t = useTranslations('reports')
  const reportQs = reportQuery(periodId, dateRange)
  const { data, loading, error } = useReportData<BalansrapportReport>(
    `/api/reports/balansrapport?${reportQs}`,
    'Kunde inte hämta balansrapport',
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
        title="Inga balansposter"
        description="Det finns inga bokförda balansposter i den valda perioden."
      />
    )
  }

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
          { format: 'pdf', href: `/api/reports/balansrapport/pdf?${reportQs}` },
          { format: 'xlsx', href: `/api/reports/balansrapport/xlsx?${reportQs}` },
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
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Ingående balans</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Förändring</th>
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Utgående balans</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((group) => (
                  <React.Fragment key={group.class}>
                    <tr className="bg-muted/30">
                      <td colSpan={5} className="px-4 py-2 text-[12.5px] font-semibold text-muted-foreground">
                        {group.class_label}
                      </td>
                    </tr>
                    {group.sections.map((section) => (
                      <BalansrapportSectionRows
                        key={section.key}
                        section={section}
                        depth={0}
                        drilldown={drilldown}
                      />
                    ))}
                    <BalansrapportTotalRow
                      label={`Summa ${group.class_label}`}
                      ib={group.subtotal_ib}
                      change={group.subtotal_change}
                      ub={group.subtotal_ub}
                      className="border-b font-semibold"
                    />
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Summa tillgångar</span>
            <span className="tabular-nums">{formatAmount(data.total_assets_ub)} kr</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Summa eget kapital, reserver, avsättningar och skulder</span>
            <span className="tabular-nums">{formatAmount(data.total_equity_liabilities_ub)} kr</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Beräknat resultat (ej bokslutsjusterat)</span>
            <span className="tabular-nums">{formatAmount(data.beraknat_resultat)} kr</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t">
            <span className="text-sm font-medium">Balanscheck</span>
            {data.is_balanced ? (
              <span className="text-sm text-muted-foreground">Balanserar</span>
            ) : (
              <div className="text-right">
                <Badge variant="destructive">Balanserar ej</Badge>
                {data.imbalance_diagnosis && (
                  <p className="text-sm text-destructive mt-1 tabular-nums">
                    Differens: {formatAmount(Math.abs(data.imbalance_diagnosis.differens))} kr
                  </p>
                )}
              </div>
            )}
          </div>
          {!data.is_balanced && data.imbalance_diagnosis && (
            <p className="text-sm text-muted-foreground pt-2 border-t">
              {data.imbalance_diagnosis.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * One ÅRL heading of the Balansrapport: its label, then either its account
 * rows or its subsections (one level, e.g. Anläggningstillgångar), then its
 * "Summa" line.
 */
function BalansrapportSectionRows({
  section,
  depth,
  drilldown,
}: {
  section: BalansrapportSection
  depth: 0 | 1
  drilldown: AccountDrilldown
}) {
  return (
    <>
      <tr>
        <td
          colSpan={5}
          className={cn(
            'pt-3 pb-1 text-[13px] font-medium',
            depth === 0 ? 'px-4' : 'pl-8 pr-4 text-muted-foreground',
          )}
        >
          {section.label}
        </td>
      </tr>
      {section.note && (
        <tr>
          <td colSpan={5} className="px-4 pb-1.5 text-[12.5px] text-muted-foreground">
            {section.note}
          </td>
        </tr>
      )}
      {section.sections.map((child) => (
        <BalansrapportSectionRows
          key={child.key}
          section={child}
          depth={1}
          drilldown={drilldown}
        />
      ))}
      {section.rows.map((row) => (
        <tr
          key={row.account_number}
          className="border-b cursor-pointer hover:bg-secondary/35 transition-colors"
          onClick={accountDrilldownClick(drilldown, row.account_number)}
        >
          <td className="px-4 py-1.5">
            <AccountNumber number={row.account_number} name={row.account_name} />
          </td>
          <td className="px-4 py-1.5"><Link href={drilldown.href(row.account_number)} className="block">{row.account_name}</Link></td>
          <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(row.ib)}</td>
          <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(row.period_change)}</td>
          <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(row.ub)}</td>
        </tr>
      ))}
      <BalansrapportTotalRow
        label={section.total_label}
        ib={section.subtotal_ib}
        change={section.subtotal_change}
        ub={section.subtotal_ub}
        className={cn('font-medium', depth === 0 && 'border-b')}
      />
    </>
  )
}

function BalansrapportTotalRow({
  label,
  ib,
  change,
  ub,
  className,
}: {
  label: string
  ib: number
  change: number
  ub: number
  className?: string
}) {
  return (
    <tr className={className}>
      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
        {label}
      </td>
      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(ib)}</td>
      <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{formatAmount(change)}</td>
      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(ub)}</td>
    </tr>
  )
}
