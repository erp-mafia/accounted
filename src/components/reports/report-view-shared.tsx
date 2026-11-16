'use client'

// What more than one report view renders. Each view under ./lazy-views is its
// own chunk, loaded only when FocusedReport opens that report; anything two or
// more views share lives here instead of in a common barrel.

import React from 'react'
import Link from 'next/link'
import { DocumentTextIcon, ExclamationTriangleIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AccountNumber } from '@/components/ui/account-number'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { accountDrilldownClick, type AccountDrilldown } from '@/components/reports/drilldown-click'
import { cn, formatAmount } from '@/lib/utils'
import { LIST_BLEED_CLASS } from '@/components/ui/dry-table'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'

// Shared shells for the report bodies, so all views read as the same
// instrument: skeleton report rows while loading, EmptyState when the period
// has no data, LoadError with "Försök igen" on fetch errors (design.md
// convention 17).
export function ReportLoadingCard() {
  return (
    <LateReveal>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="flex h-9 items-center justify-between border-b-hairline">
          <Skeleton className="h-3.5 w-56" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </LateReveal>
  )
}

/**
 * The report could not load. With `onRetry` it is the LoadError block; a view
 * whose fetch cannot be asked again (a paged report) says it without the
 * button.
 */
export function ReportErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (onRetry) return <LoadError title={message} onRetry={onRetry} />
  return <EmptyState tone="error" icon={ExclamationTriangleIcon} title={message} />
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
  /**
   * Report total, rendered as the table's tfoot (e.g. "Summa tillgångar").
   * `headline` sets the amount as the headline number, for a statement's
   * grand totals; a section total stays in the row type.
   */
  footer?: { label: string; amount: number; negate?: boolean; headline?: boolean }
}) {
  const fmt = (amount: number, neg?: boolean) =>
    neg ? `-${formatAmount(amount)}` : formatAmount(amount)

  if (sections.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Inga poster.</p>
  }

  // One ledger table with group-band rows (board Rapporter-v3): cells 8px in
  // with the list's 8px bleed, rows without "kr", each Summa with it, and the
  // report total as the headline number.
  const cell = 'h-9 px-2 py-2 align-top border-b-hairline'
  return (
    <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
      <table className="w-full border-collapse text-[13px]">
        <tbody>
          {sections.map((section) => (
            <React.Fragment key={section.title}>
              <tr className="bg-muted/40">
                <td colSpan={3} className="h-8 px-2 align-middle text-xs font-medium text-muted-foreground border-b-hairline">
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr
                  key={row.account_number}
                  className={cn(drilldown && 'cursor-pointer transition-colors duration-150 hover:bg-secondary/35')}
                  onClick={drilldown ? accountDrilldownClick(drilldown, row.account_number) : undefined}
                >
                  <td className={cn(cell, 'w-20')}><AccountNumber number={row.account_number} name={row.account_name} /></td>
                  <td className={cell}>
                    {drilldown ? <Link href={drilldown.href(row.account_number)} className="block">{row.account_name}</Link> : row.account_name}
                  </td>
                  <td className={cn(cell, 'w-32 text-right tabular-nums whitespace-nowrap')}>{fmt(row.amount, negate)}</td>
                </tr>
              ))}
              {/* A one-account group gets no Summa row: it would repeat the line. */}
              {section.rows.length > 1 && (
                <tr>
                  <td colSpan={2} className={cn(cell, 'text-right text-muted-foreground')}>Summa</td>
                  <td className={cn(cell, 'text-right font-medium text-strong tabular-nums whitespace-nowrap')}>
                    {fmt(section.subtotal, negate)} kr
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr>
              <td colSpan={2} className="px-2 pb-2 pt-5 align-baseline text-[13px] font-medium text-strong">{footer.label}</td>
              <td
                className={cn(
                  'px-2 pb-2 pt-5 text-right align-baseline text-strong tabular-nums whitespace-nowrap',
                  footer.headline ? 'font-display text-3xl' : 'text-[13px] font-medium',
                )}
              >
                {fmt(footer.amount, footer.negate)} kr
              </td>
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
/**
 * One aging bucket on a reskontra row. Blank only at zero: a credit note not
 * yet due is a negative bucket, the PDF and the xlsx print it, and without it
 * the row does not add up to its own Totalt.
 */
export function agingCell(amount: number): string {
  return amount === 0 ? '' : formatAmount(amount)
}

interface ReskontraToolbarProps {
  asOfDate: string
  onAsOfDateChange: (date: string) => void
  inputId: string
  exportBase: string
}

/** A reskontra that could not be read. The toolbar stays: a refused date is mended in the field that sent it. */
export function ReskontraErrorCard({
  message,
  onRetry,
  ...toolbar
}: ReskontraToolbarProps & { message: string; onRetry?: () => void }) {
  return (
    <div className="space-y-4">
      <ReskontraToolbar {...toolbar} />
      <ReportErrorCard message={message} onRetry={onRetry} />
    </div>
  )
}

export function ReskontraToolbar({ asOfDate, onAsOfDateChange, inputId, exportBase }: ReskontraToolbarProps) {
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
