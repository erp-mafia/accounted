'use client'

// What more than one report view renders. Each view under ./lazy-views is its
// own chunk, loaded only when FocusedReport opens that report; anything two or
// more views share lives here instead of in a common barrel.

import React from 'react'
import Link from 'next/link'
import { DocumentTextIcon, ExclamationCircleIcon } from '@/components/icons'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { accountDrilldownClick, type AccountDrilldown } from '@/components/reports/drilldown-click'
import { formatAmount } from '@/lib/utils'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'

// Shared shells for the report bodies, so all views read as the same
// instrument: Skeleton while loading, EmptyState when the period has no data,
// a quiet destructive card on fetch errors (design.md primitives).
export function ReportLoadingCard() {
  return (
    <Card>
      <CardContent className="p-6 space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

export function ReportErrorCard({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-8 text-center text-destructive">
        <ExclamationCircleIcon className="h-6 w-6 mx-auto mb-2" />
        {message}
      </CardContent>
    </Card>
  )
}

export function ReportEmptyState({ title, description }: { title: string; description: string }) {
  return <EmptyState icon={DocumentTextIcon} title={title} description={description} />
}

export function reportQuery(
  periodId: string,
  range?: DateRangeValue,
  dimensionFilter?: DimensionFilterValue | null,
): string {
  const params = new URLSearchParams({ period_id: periodId })
  if (range?.fromDate) params.set('from_date', range.fromDate)
  if (range?.toDate) params.set('to_date', range.toDate)
  if (dimensionFilter) {
    params.set('dim_no', dimensionFilter.dimNo)
    params.set('dim_code', dimensionFilter.code)
  }
  return params.toString()
}

export function ReportSectionTable({
  sections,
  negate,
  drilldown,
  footer,
}: {
  sections: { title: string; rows: { account_number: string; account_name: string; amount: number }[]; subtotal: number }[]
  negate?: boolean
  drilldown?: AccountDrilldown
  /** Report total, rendered as the table's tfoot (e.g. "Summa tillgångar"). */
  footer?: { label: string; amount: number; negate?: boolean }
}) {
  const fmt = (amount: number, neg?: boolean) =>
    neg ? `-${formatAmount(amount)}` : formatAmount(amount)

  if (sections.length === 0) {
    return <p className="p-6 pt-0 text-sm text-muted-foreground">Inga poster.</p>
  }

  // One table with group-band rows (design.md tabular rules), matching the
  // Resultatrapport/Balansrapport idiom, instead of one boxed sub-table per
  // section with a repeated title line.
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[400px]">
        <tbody>
          {sections.map((section) => (
            <React.Fragment key={section.title}>
              <tr className="bg-muted/30">
                <td colSpan={3} className="px-4 py-2 text-[12.5px] font-semibold text-muted-foreground">
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr
                  key={row.account_number}
                  className={`border-b last:border-0 ${drilldown ? 'cursor-pointer hover:bg-secondary/35 transition-colors' : ''}`}
                  onClick={drilldown ? accountDrilldownClick(drilldown, row.account_number) : undefined}
                >
                  <td className="px-4 py-1.5 w-20"><AccountNumber number={row.account_number} name={row.account_name} /></td>
                  <td className="px-4 py-1.5">
                    {drilldown ? <Link href={drilldown.href(row.account_number)} className="block">{row.account_name}</Link> : row.account_name}
                  </td>
                  <td className="px-4 py-1.5 text-right tabular-nums w-32 whitespace-nowrap">
                    {fmt(row.amount, negate)} kr
                  </td>
                </tr>
              ))}
              <tr className="border-b font-medium">
                <td colSpan={2} className="px-4 py-1.5 text-right text-muted-foreground">Summa</td>
                <td className="px-4 py-1.5 text-right tabular-nums whitespace-nowrap">{fmt(section.subtotal, negate)} kr</td>
              </tr>
            </React.Fragment>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="font-medium">
              <td colSpan={2} className="px-4 py-2">{footer.label}</td>
              <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{fmt(footer.amount, footer.negate)} kr</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// Local calendar date (YYYY-MM-DD) for the reskontra "per datum" default:
// toISOString() is UTC and rolls the date over an hour early in Sweden.
// Shared "Per datum" control + export menu header for the two reskontra views
// (#1020/#1021): pick an arbitrary as-of date and export PDF/Excel for it.
export function ReskontraToolbar({
  asOfDate,
  onAsOfDateChange,
  inputId,
  exportBase,
}: {
  asOfDate: string
  onAsOfDateChange: (date: string) => void
  inputId: string
  exportBase: string
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={inputId} className="text-xs text-muted-foreground">
          Per datum
        </Label>
        <Input
          id={inputId}
          type="date"
          value={asOfDate}
          onChange={(e) => {
            if (e.target.value) onAsOfDateChange(e.target.value)
          }}
          className="w-40"
        />
      </div>
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `${exportBase}/pdf?as_of_date=${asOfDate}` },
          { format: 'xlsx', href: `${exportBase}/xlsx?as_of_date=${asOfDate}` },
        ]}
      />
    </div>
  )
}
