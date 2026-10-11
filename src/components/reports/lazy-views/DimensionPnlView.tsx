'use client'

import React, { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useDimensions } from '@/lib/reference-data/hooks'
import { useReportData } from '@/lib/hooks/use-report-data'
import { formatAmount, formatDate } from '@/lib/utils'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionPnlReport } from '@/types'

// --- Resultat per projekt/kostnadsställe (dimension P&L matrix) ---

export default function DimensionPnlView({ periodId, dateRange }: { periodId: string; dateRange: DateRangeValue }) {
  const t = useTranslations('reports')
  const [dimNo, setDimNo] = useState('6')
  const reportQs = `${reportQuery(periodId, dateRange)}&dim_no=${encodeURIComponent(dimNo)}`
  // Race-safe when the pivot or the window changes mid-flight: only the
  // answer for the current query string lands.
  const { data, loading, error } = useReportData<DimensionPnlReport>(
    `/api/reports/dimension-pnl?${reportQs}`,
    'Kunde inte hämta rapporten',
  )

  // Registered dimensions for the pivot picker, from the session cache
  // (lib/reference-data); best-effort, the report defaults to projekt while
  // the registry is unavailable.
  const { dimensions } = useDimensions()
  const dims = useMemo(
    () => dimensions.map((d) => ({ sie_dim_no: d.sie_dim_no, name: d.name })),
    [dimensions],
  )

  const pivotPicker = dims.length > 1 && (
    <div className="flex flex-wrap items-center gap-1.5">
      {dims.map((d) => {
        const active = String(d.sie_dim_no) === dimNo
        return (
          <button
            key={d.sie_dim_no}
            type="button"
            onClick={() => setDimNo(String(d.sie_dim_no))}
            className={
              active
                ? 'px-3 py-1.5 text-xs rounded-full border transition-colors duration-150 bg-secondary border-border text-foreground'
                : 'px-3 py-1.5 text-xs rounded-full border transition-colors duration-150 bg-transparent border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            }
          >
            {d.name}
          </button>
        )
      })}
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportLoadingCard />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportErrorCard message={error} />
      </div>
    )
  }

  if (!data || data.groups.length === 0) {
    return (
      <div className="space-y-4">
        {pivotPicker}
        <ReportEmptyState
          title="Inga taggade poster"
          description="Inga intäkter eller kostnader är taggade med en dimension i den valda perioden."
        />
      </div>
    )
  }

  const columnLabel = (c: DimensionPnlReport['columns'][number]) =>
    c.code === null ? '(Utan dimension)' : c.code

  const colCount = 2 + data.columns.length + 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {pivotPicker}
          {/* The window the amounts cover, as the server computed it: a
              quarter picked above reads as that quarter, not the year to date. */}
          <p className="text-sm text-muted-foreground tabular-nums">
            {t('date_range_label')}:{' '}
            {t('date_range_custom_summary', {
              from: formatDate(data.period.start),
              to: formatDate(data.period.end),
            })}
          </p>
        </div>
        <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/dimension-pnl/xlsx?${reportQs}` }]} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-4 py-2 w-20">Konto</th>
                  <th className="text-left font-medium px-4 py-2">Kontonamn</th>
                  {data.columns.map((c, i) => (
                    /* data-ph-mask: the pivot column header is a user dimension
                       value. No title attribute: replay masking covers text
                       nodes, not attributes. */
                    <th key={i} data-ph-mask="" className="text-right font-medium px-4 py-2 w-32 tabular-nums">
                      {columnLabel(c)}
                    </th>
                  ))}
                  <th className="text-right font-medium px-4 py-2 w-32 tabular-nums">Totalt</th>
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
                      <tr key={row.account_number} className="border-b last:border-0">
                        <td className="px-4 py-1.5">
                          <AccountNumber number={row.account_number} name={row.account_name} />
                        </td>
                        <td className="px-4 py-1.5">{row.account_name}</td>
                        {row.values.map((v, i) => (
                          <td key={i} className="px-4 py-1.5 text-right tabular-nums">
                            {Math.abs(v) >= 0.005 ? formatAmount(v) : ''}
                          </td>
                        ))}
                        <td className="px-4 py-1.5 text-right tabular-nums font-medium">{formatAmount(row.total)}</td>
                      </tr>
                    ))}
                    <tr className="border-b font-medium">
                      <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">
                        Summa
                      </td>
                      {group.subtotals.map((v, i) => (
                        <td key={i} className="px-4 py-1.5 text-right tabular-nums">{formatAmount(v)}</td>
                      ))}
                      <td className="px-4 py-1.5 text-right tabular-nums">{formatAmount(group.subtotal_total)}</td>
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="px-4 text-sm font-medium">Beräknat resultat</td>
                  <td className="px-4" />
                  {data.net_per_column.map((v, i) => (
                    <td key={i} className={`px-4 text-right tabular-nums font-medium w-32 ${v >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {formatAmount(v)}
                    </td>
                  ))}
                  <td className={`px-4 text-right font-display text-xl tabular-nums w-32 ${data.net_total >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {formatAmount(data.net_total)} kr
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
