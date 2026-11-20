'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowsRightLeftIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { LIST_BLEED_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverHeader } from '@/components/ui/slide-over'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useDimensions } from '@/lib/reference-data/hooks'
import { useReportData } from '@/lib/hooks/use-report-data'
import { useReportPages } from '@/lib/hooks/use-report-pages'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  OPERATING_COST_ACCOUNT_RANGE,
  RESULTATKONTO_FIRST,
  RESULTATKONTO_LAST,
  REVENUE_ACCOUNT_RANGE,
} from '@/lib/bookkeeping/result-account-ranges'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { cn, formatAmount, formatDate } from '@/lib/utils'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionCrossLinesPage, DimensionCrossReport, DimensionCrossValue } from '@/types'

// --- Resultat across two dimensions (accounted#133) ---
// Dimension A down, B across, one amount per cell; a cell opens the lines it
// sums. The two dimensions are axes, not a filter: every cell, the untagged
// row and column included, sums to the resultatrapport for the window.

type Measure = 'result' | 'revenue' | 'costs' | 'range'

/** The fixed account ranges of the measure picker; 'result' sends none. */
const MEASURE_RANGES: Record<Exclude<Measure, 'result' | 'range'>, { from: string; to: string }> = {
  revenue: REVENUE_ACCOUNT_RANGE,
  costs: OPERATING_COST_ACCOUNT_RANGE,
}

/** A typed range, when both ends are result accounts in order. */
function validRange(from: string, to: string): { from: string; to: string } | null {
  if (!ACCOUNT_NUMBER_RE.test(from) || !ACCOUNT_NUMBER_RE.test(to)) return null
  if (from < RESULTATKONTO_FIRST || to > RESULTATKONTO_LAST || from > to) return null
  return { from, to }
}

/** The cell whose lines the slide-over shows. */
interface OpenCell {
  row: DimensionCrossValue
  column: DimensionCrossValue
  amount: number
}

export default function DimensionCrossView({ periodId, dateRange }: { periodId: string; dateRange: DateRangeValue }) {
  const t = useTranslations('reports')

  // Registered dimensions for the two pickers, from the session cache.
  const { dimensions, isLoading: dimensionsLoading } = useDimensions()
  const dims = useMemo(
    () => dimensions.map((d) => ({ sieDimNo: String(d.sie_dim_no), name: d.name })),
    [dimensions],
  )

  // Picked axes; until the user picks, the first two registered dimensions.
  const [picked, setPicked] = useState<{ a: string; b: string } | null>(null)
  const known = (no: string | undefined) => !!no && dims.some((d) => d.sieDimNo === no)
  const axes =
    picked && known(picked.a) && known(picked.b) && picked.a !== picked.b
      ? picked
      : dims.length >= 2
        ? { a: dims[0]!.sieDimNo, b: dims[1]!.sieDimNo }
        : null

  const [measure, setMeasure] = useState<Measure>('result')
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  const accounts =
    measure === 'result'
      ? null
      : measure === 'range'
        ? validRange(rangeFrom, rangeTo)
        : MEASURE_RANGES[measure]
  const rangeIncomplete = measure === 'range' && accounts === null

  // A string, so the fetch below only restarts when the query changes.
  let query: string | null = null
  if (axes && !rangeIncomplete) {
    const params = new URLSearchParams(reportQuery(periodId, dateRange))
    params.set('dim_a', axes.a)
    params.set('dim_b', axes.b)
    if (accounts) {
      params.set('account_from', accounts.from)
      params.set('account_to', accounts.to)
    }
    query = params.toString()
  }

  // Race-safe when the axes, the measure or the window change mid-flight.
  const { data, loading, error, refetch } = useReportData<DimensionCrossReport>(
    query ? `/api/reports/dimension-cross?${query}` : null,
    t('dimension_cross_load_error'),
  )

  const [openCell, setOpenCell] = useState<OpenCell | null>(null)

  const setAxis = (axis: 'a' | 'b', value: string) => {
    if (!axes) return
    const other = axis === 'a' ? axes.b : axes.a
    // Picking the other axis's dimension swaps the two.
    if (value === other) {
      setPicked({ a: axes.b, b: axes.a })
    } else {
      setPicked(axis === 'a' ? { a: value, b: axes.b } : { a: axes.a, b: value })
    }
  }

  if (dimensionsLoading && dims.length === 0) return <ReportLoadingCard />

  if (!axes) {
    return (
      <ReportEmptyState
        title={t('dimension_cross_need_two_title')}
        description={t('dimension_cross_need_two_description')}
      />
    )
  }

  const valueLabel = (v: DimensionCrossValue) => (v.code === null ? t('dimension_cross_untagged') : v.code)

  const dimensionSelect = (axis: 'a' | 'b') => (
    <Select value={axis === 'a' ? axes.a : axes.b} onValueChange={(v) => setAxis(axis, v)}>
      <SelectTrigger
        className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')}
        aria-label={t(axis === 'a' ? 'dimension_cross_rows' : 'dimension_cross_columns')}
      >
        <span className="text-muted-foreground">{t(axis === 'a' ? 'dimension_cross_rows' : 'dimension_cross_columns')}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {dims.map((d) => (
          <SelectItem key={d.sieDimNo} value={d.sieDimNo}>
            {d.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      {dimensionSelect('a')}
      <Button
        type="button"
        variant="outline"
        size="icon-toolbar"
        aria-label={t('dimension_cross_swap')}
        title={t('dimension_cross_swap')}
        onClick={() => setPicked({ a: axes.b, b: axes.a })}
      >
        <ArrowsRightLeftIcon className="h-4 w-4" />
      </Button>
      {dimensionSelect('b')}
      <Select value={measure} onValueChange={(v) => setMeasure(v as Measure)}>
        <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('dimension_cross_measure')}>
          <span className="text-muted-foreground">{t('dimension_cross_measure')}</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="result">{t('dimension_cross_measure_result')}</SelectItem>
          <SelectItem value="revenue">{t('dimension_cross_measure_revenue', MEASURE_RANGES.revenue)}</SelectItem>
          <SelectItem value="costs">{t('dimension_cross_measure_costs', MEASURE_RANGES.costs)}</SelectItem>
          <SelectItem value="range">{t('dimension_cross_measure_range')}</SelectItem>
        </SelectContent>
      </Select>
      {measure === 'range' && (
        <>
          <Input
            inputMode="numeric"
            maxLength={4}
            placeholder={RESULTATKONTO_FIRST}
            aria-label={t('dimension_cross_account_from')}
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value.replace(/\D/g, ''))}
            className={cn(TOOLBAR_FIELD_CLASS, 'w-20 tabular-nums')}
          />
          <Input
            inputMode="numeric"
            maxLength={4}
            placeholder={RESULTATKONTO_LAST}
            aria-label={t('dimension_cross_account_to')}
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value.replace(/\D/g, ''))}
            className={cn(TOOLBAR_FIELD_CLASS, 'w-20 tabular-nums')}
          />
        </>
      )}
      {query && (
        <ReportExportMenu
          items={[
            { format: 'pdf', href: `/api/reports/dimension-cross/pdf?${query}` },
            { format: 'xlsx', href: `/api/reports/dimension-cross/xlsx?${query}` },
          ]}
        />
      )}
    </div>
  )

  let body: React.ReactNode
  if (rangeIncomplete) {
    body = <p className="text-sm text-muted-foreground">
        {t('dimension_cross_range_hint', { first: RESULTATKONTO_FIRST, last: RESULTATKONTO_LAST })}
      </p>
  } else if (loading) {
    body = <ReportLoadingCard />
  } else if (error) {
    body = <ReportErrorCard message={error} onRetry={refetch} />
  } else if (
    !data ||
    data.rows.length === 0 ||
    (data.rows.every((r) => r.code === null) && data.columns.every((c) => c.code === null))
  ) {
    body = (
      <ReportEmptyState
        title={t('dimension_cross_empty_title')}
        description={t('dimension_cross_empty_description')}
      />
    )
  } else {
    body = (
      <div className="space-y-4 stagger-enter">
        {/* The window the amounts cover, as the server computed it. */}
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('date_range_label')}:{' '}
          {t('date_range_custom_summary', { from: formatDate(data.period.start), to: formatDate(data.period.end) })}
        </p>
        <CrossMatrix data={data} valueLabel={valueLabel} onOpen={setOpenCell} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {toolbar}
      {body}
      {openCell && query && (
        <CellLines
          query={query}
          cell={openCell}
          valueLabel={valueLabel}
          onClose={() => setOpenCell(null)}
        />
      )}
    </div>
  )
}

function CrossMatrix({
  data,
  valueLabel,
  onOpen,
}: {
  data: DimensionCrossReport
  valueLabel: (v: DimensionCrossValue) => string
  onOpen: (cell: OpenCell) => void
}) {
  const t = useTranslations('reports')
  // A report table (board Rapporter-v3, as ReportSectionTable): cells 8px in
  // with the list's 8px bleed, amounts without "kr", the Totalt row over the
  // strong rule and the grand total as the headline number.
  const cell = 'h-9 px-2 py-2 align-top border-b-hairline'
  const amountCell = cn(cell, 'text-right tabular-nums whitespace-nowrap')
  const totalCell = 'px-2 pb-2 pt-3 align-baseline border-t-total text-right tabular-nums whitespace-nowrap'

  return (
    <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {/* data-ph-mask: dimension names and values are user data. */}
            <th data-ph-mask="" className={TH_CLASS}>
              {data.dim_a.name} / {data.dim_b.name}
            </th>
            {data.columns.map((c, j) => (
              <th key={j} data-ph-mask="" className={cn(TH_CLASS, 'text-right')}>
                {valueLabel(c)}
              </th>
            ))}
            <th className={cn(TH_CLASS, 'text-right')}>{t('dimension_cross_total')}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              <td data-ph-mask="" className={cn(cell, 'whitespace-nowrap')}>
                {valueLabel(row)}
                {row.name && <span className="ml-2 text-muted-foreground">{row.name}</span>}
              </td>
              {data.cells[i]!.map((amount, j) => {
                const column = data.columns[j]!
                return (
                  <td key={j} className={amountCell}>
                    {Math.abs(amount) >= 0.005 ? (
                      <button
                        type="button"
                        onClick={() => onOpen({ row, column, amount })}
                        aria-label={t('dimension_cross_cell_open', { row: valueLabel(row), column: valueLabel(column) })}
                        className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {formatAmount(amount)}
                      </button>
                    ) : (
                      ''
                    )}
                  </td>
                )
              })}
              <td className={cn(amountCell, 'font-medium text-strong')}>{formatAmount(data.row_totals[i]!)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className={cn(totalCell, 'text-left font-medium text-strong')}>{t('dimension_cross_total')}</td>
            {data.column_totals.map((v, j) => (
              <td key={j} className={cn(totalCell, 'font-medium text-strong')}>{formatAmount(v)}</td>
            ))}
            <td className={cn(totalCell, 'font-display text-3xl', data.total >= 0 ? 'text-success' : 'text-destructive')}>
              {formatAmount(data.total)} kr
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/** The lines one cell sums, in a right slide-over, a page at a time. */
function CellLines({
  query,
  cell,
  valueLabel,
  onClose,
}: {
  query: string
  cell: OpenCell
  valueLabel: (v: DimensionCrossValue) => string
  onClose: () => void
}) {
  const t = useTranslations('reports')
  const tCommon = useTranslations('common')
  const first = useMemo(() => {
    const params = new URLSearchParams(query)
    // A null code is the "(Utan dimension)" row or column: left out.
    if (cell.row.code !== null) params.set('code_a', cell.row.code)
    if (cell.column.code !== null) params.set('code_b', cell.column.code)
    return `/api/reports/dimension-cross/lines?${params.toString()}`
  }, [query, cell])

  const { pages, loading, error, hasMore, loadMore, retry } = useReportPages<DimensionCrossLinesPage>(
    first,
    t('dimension_cross_lines_error'),
    (page) =>
      page.next
        ? `${first}&${new URLSearchParams({
            after_date: page.next.after_date,
            after_voucher: String(page.next.after_voucher),
            after_line: page.next.after_line,
          })}`
        : null,
  )
  const lines = pages.flatMap((p) => p.lines)

  return (
    <SlideOver open onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        <SlideOverHeader
          kicker={
            <span className="tabular-nums">
              {t('dimension_cross_lines_kicker')} · {formatAmount(cell.amount)}
            </span>
          }
          title={
            <span data-ph-mask="">
              {t('dimension_cross_lines_title', { row: valueLabel(cell.row), column: valueLabel(cell.column) })}
            </span>
          }
        />
        <SlideOverBody className="px-0">
          {/* The table runs to the drawer's edges; everything else sits on its 20px inset. */}
          {error && lines.length === 0 ? (
            <div className="px-5">
              <ReportErrorCard message={error} onRetry={retry} />
            </div>
          ) : loading && lines.length === 0 ? (
            <div className="px-5">
              <ReportLoadingCard />
            </div>
          ) : lines.length === 0 ? (
            <p className="px-5 text-sm text-muted-foreground">{t('dimension_cross_lines_empty')}</p>
          ) : (
            <div className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5 pr-2">{t('dimension_cross_col_date')}</TableHead>
                    <TableHead className="px-2">{t('dimension_cross_col_voucher')}</TableHead>
                    <TableHead className="px-2">{t('dimension_cross_col_account')}</TableHead>
                    <TableHead className="px-2">{t('dimension_cross_col_text')}</TableHead>
                    <TableHead className="pl-2 pr-5 text-right">{t('dimension_cross_col_amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="stagger-enter">
                  {lines.map((line) => (
                    <TableRow key={line.line_id}>
                      <TableCell className="date-figures pl-5 pr-2 whitespace-nowrap">{formatDate(line.entry_date)}</TableCell>
                      <TableCell className="px-2 tabular-nums whitespace-nowrap">
                        <Link href={`/bookkeeping/${line.journal_entry_id}`} className="underline-offset-4 hover:underline">
                          {formatVoucher(line)}
                        </Link>
                      </TableCell>
                      <TableCell className="px-2 tabular-nums">{line.account_number}</TableCell>
                      <TableCell data-ph-mask="" className="max-w-[160px] truncate px-2">
                        {line.line_description || line.description || ''}
                      </TableCell>
                      <TableCell className="pl-2 pr-5 text-right tabular-nums whitespace-nowrap">
                        {formatAmount(line.credit_amount - line.debit_amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* A page that failed keeps the rows above and says so in one line. */}
              {error ? (
                <div className="flex items-center gap-3 px-5 text-sm">
                  <span className="text-destructive">{error}</span>
                  <Button variant="link" onClick={retry}>{tCommon('retry')}</Button>
                </div>
              ) : (hasMore || loading) && (
                <div className="px-5">
                  <Button type="button" variant="outline" loading={loading} onClick={loadMore}>
                    {t('dimension_cross_show_more')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SlideOverBody>
      </SlideOverContent>
    </SlideOver>
  )
}
