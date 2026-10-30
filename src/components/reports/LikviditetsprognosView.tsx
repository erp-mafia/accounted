'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChevronDownIcon, ChevronRightIcon, ExclamationCircleIcon, PlusIcon, XMarkIcon } from '@/components/icons'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ForecastRowDialog } from '@/components/reports/ForecastRowDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  chartPoints,
  defaultThreshold,
  firstBreach,
  flowHref,
  forecastTotals,
  isoWeekNumber,
  openingState,
  weekSections,
} from '@/lib/forecast/report-view'
import { parseAmountInput } from '@/lib/money'
import type { ForecastRowView } from '@/lib/forecast/rows'
import type { CashFlow, CashForecast } from '@/lib/forecast/types'
import { cn, formatAmount, formatCurrency, formatDate, formatWholeKr } from '@/lib/utils'

export interface LikviditetsprognosData {
  forecast: CashForecast
  past_rows: ForecastRowView[]
}

const NUM = 'text-right tabular-nums whitespace-nowrap'
/** Overdue invoices listed per side before "and N more". */
const OVERDUE_SHOWN = 8
const THRESHOLD_KEY = 'Accounted:cash-forecast-threshold:'

/** The warning line a viewer set for a company, remembered in this browser only. */
function readThreshold(companyId: string | undefined): number | null {
  if (!companyId) return null
  try {
    const raw = window.localStorage.getItem(THRESHOLD_KEY + companyId)
    const value = raw === null ? null : Number(raw)
    return value !== null && Number.isFinite(value) ? value : null
  } catch {
    // Storage blocked (a private window): no line remembered, the default holds.
    return null
  }
}

function writeThreshold(companyId: string | undefined, value: number | null): void {
  if (!companyId) return
  try {
    if (value === null) window.localStorage.removeItem(THRESHOLD_KEY + companyId)
    else window.localStorage.setItem(THRESHOLD_KEY + companyId, String(value))
  } catch {
    // Storage blocked (a private window): the line falls back to the default.
  }
}

/**
 * Likviditetsprognos (accounted#136): where the bank balance is heading for
 * 13 ISO weeks, read from GET /api/reports/cash-forecast (the engine in
 * lib/forecast). The page groups and labels; every figure is the engine's.
 */
export function LikviditetsprognosView() {
  const t = useTranslations('cash_forecast')
  const locale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const [data, setData] = useState<LikviditetsprognosData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/reports/cash-forecast')
        const result = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) setError(getErrorMessage(result, { locale, fallback: t('load_failed') }))
        else setData(result.data as LikviditetsprognosData)
      } catch {
        if (!cancelled) setError(t('load_failed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // t and locale are stable for the mounted locale; a reload is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])

  const refresh = useCallback(() => setReload((n) => n + 1), [])

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={
          <HelpPopover>
            <div className="space-y-2 text-[13px]">
              <div>{t('help_intro')}</div>
              <div>{t('help_sources')}</div>
              <div>{t('help_once')}</div>
              <div>{t('help_overdue')}</div>
              <div>{t('help_rows')}</div>
            </div>
          </HelpPopover>
        }
        action={
          canWrite && data ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon className="h-4 w-4" />
              {t('add_row')}
            </Button>
          ) : undefined
        }
      />

      {loading && !data ? (
        <ForecastSkeleton />
      ) : error && !data ? (
        <Card>
          <CardContent className="space-y-4 p-8 text-center">
            <div className="text-destructive">
              <ExclamationCircleIcon className="mx-auto mb-2 h-6 w-6" />
              {error}
            </div>
            <Button variant="secondary" onClick={refresh}>
              {t('retry')}
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <LikviditetsprognosReport data={data} onChanged={refresh} />
      ) : null}

      {adding && data && <ForecastRowDialog today={data.forecast.today} onOpenChange={setAdding} onAdded={refresh} />}
    </div>
  )
}

function ForecastSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
      <Card>
        <CardContent className="space-y-2 p-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * The report body from a loaded forecast. Split from the fetch so a preview
 * renders it from hand-made data.
 */
export function LikviditetsprognosReport({ data, onChanged }: { data: LikviditetsprognosData; onChanged: () => void }) {
  const t = useTranslations('cash_forecast')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const { forecast, past_rows: pastRows } = data

  const fallbackThreshold = useMemo(() => defaultThreshold(forecast), [forecast])
  // The body mounts only in the browser, after the forecast loaded, so the
  // stored line can be read on the first render.
  const [storedThreshold, setStoredThreshold] = useState<number | null>(() => readThreshold(company?.id))
  const [thresholdText, setThresholdText] = useState<string | null>(null)
  const threshold = storedThreshold ?? fallbackThreshold

  const sections = useMemo(() => weekSections(forecast, threshold), [forecast, threshold])
  const points = useMemo(() => chartPoints(forecast), [forecast])
  const totals = useMemo(() => forecastTotals(forecast), [forecast])
  const breach = useMemo(() => firstBreach(forecast, threshold), [forecast, threshold])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (isoWeek: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(isoWeek)) next.delete(isoWeek)
      else next.add(isoWeek)
      return next
    })

  function commitThreshold() {
    if (thresholdText === null) return
    const trimmed = thresholdText.trim()
    const parsed = trimmed === '' ? null : parseAmountInput(trimmed)
    if (trimmed === '' || (parsed !== null && parsed >= 0)) {
      setStoredThreshold(parsed)
      writeThreshold(company?.id, parsed)
    }
    setThresholdText(null)
  }

  async function cancelRow(rowId: string, amount: number, date: string) {
    await confirm(
      {
        title: t('cancel_title'),
        description: t('cancel_description', { amount: formatCurrency(amount), date: formatDate(date) }),
        confirmLabel: t('cancel_confirm'),
      },
      async () => {
        const res = await fetch(`/api/reports/cash-forecast/rows/${encodeURIComponent(rowId)}/cancel`, { method: 'POST' })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          toast({ title: t('cancel_failed'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
          throw new Error('cancel failed')
        }
        onChanged()
      },
    )
  }

  const opening = forecast.opening
  const state = openingState(opening)
  const openingDate = opening.as_of ? formatDate(opening.as_of.slice(0, 10)) : null
  const openingNote =
    state === 'bank'
      ? t('opening_bank', { date: openingDate ?? '' })
      : state === 'bank_stale'
        ? t('opening_bank_stale', { date: openingDate ?? '', days: opening.age_days ?? 0 })
        : state === 'booked'
          ? t('opening_booked')
          : t('opening_unknown')
  const unavailable = forecast.caveats.find((c) => c.code === 'SOURCE_UNAVAILABLE')
  const caveats = forecast.caveats.filter((c) => c !== unavailable || breach !== null)

  return (
    <div className="space-y-8 stagger-enter">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4">
            <div className="text-[12.5px] text-muted-foreground">{t('opening_label')}</div>
            <div className={cn('font-display text-xl tabular-nums', opening.amount < 0 && 'text-destructive')}>
              {formatCurrency(opening.amount)}
            </div>
            <div className="text-[12.5px] text-muted-foreground">{openingNote}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <div className="text-[12.5px] text-muted-foreground">{t('lowest_label')}</div>
            <div className={cn('font-display text-xl tabular-nums', forecast.lowest.closing < 0 && 'text-destructive')}>
              {formatCurrency(forecast.lowest.closing)}
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              {t('lowest_when', { date: formatDate(forecast.lowest.date), week: isoWeekNumber(forecast.lowest.iso_week) })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <div className="text-[12.5px] text-muted-foreground">{t('closing_label', { weeks: forecast.horizon.weeks })}</div>
            <div className={cn('font-display text-xl tabular-nums', forecast.closing < 0 && 'text-destructive')}>
              {formatCurrency(forecast.closing)}
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              {t('closing_flows', { inflow: formatCurrency(totals.inflow), outflow: formatCurrency(totals.outflow) })}
            </div>
          </CardContent>
        </Card>
      </div>

      {breach ? (
        <AttnLine>
          {breach.date
            ? t('attn_breach_day', { threshold: formatCurrency(threshold), date: formatDate(breach.date), week: breach.week })
            : t('attn_breach', { threshold: formatCurrency(threshold), week: breach.week })}
        </AttnLine>
      ) : unavailable ? (
        <AttnLine>{locale === 'en' ? unavailable.message_en : unavailable.message_sv}</AttnLine>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-2">
          <CardTitle className="text-base">{t('chart_title')}</CardTitle>
          <div className="flex items-center gap-2">
            <label htmlFor="forecast-threshold" className="text-[12.5px] text-muted-foreground">
              {t('threshold_label')}
            </label>
            <Input
              id="forecast-threshold"
              inputMode="decimal"
              autoComplete="off"
              className="h-8 w-32 text-right tabular-nums"
              title={t('threshold_hint')}
              placeholder={formatWholeKr(fallbackThreshold)}
              value={thresholdText ?? (storedThreshold === null ? '' : formatWholeKr(storedThreshold))}
              onChange={(e) => setThresholdText(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitThreshold()
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="week" tickFormatter={(w) => t('week_short', { week: w })} tick={{ fontSize: 11 }} />
              <YAxis
                width={56}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => new Intl.NumberFormat('sv-SE', { notation: 'compact' }).format(Number(v))}
              />
              <Tooltip
                // The out bar is drawn below zero; its amount is still what goes out.
                formatter={(value, name, item) => [
                  formatCurrency(item?.dataKey === 'outflow' ? Math.abs(Number(value)) : Number(value)),
                  String(name),
                ]}
                labelFormatter={(w) => t('week_label', { week: String(w) })}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              {/* No draw-in animation: motion is functional only, and a print mid-animation would cut the line. */}
              <Bar dataKey="inflow" name={t('legend_in')} stackId="flow" fill="hsl(var(--chart-1))" isAnimationActive={false} />
              <Bar dataKey="outflow" name={t('legend_out')} stackId="flow" fill="hsl(var(--chart-2))" isAnimationActive={false} />
              <Line
                dataKey="closing"
                name={t('legend_closing')}
                type="linear"
                stroke="hsl(var(--foreground))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <ReferenceLine
                y={threshold}
                // Drawn even when the whole forecast lies under it, which is when it matters.
                ifOverflow="extendDomain"
                stroke="hsl(var(--chart-3))"
                strokeDasharray="4 4"
                label={{ value: t('legend_threshold'), position: 'insideTopRight', fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('col_week')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('col_period')}</TableHead>
                <TableHead className={cn(NUM, 'hidden sm:table-cell')}>{t('col_opening')}</TableHead>
                <TableHead className={cn(NUM, 'hidden sm:table-cell')}>{t('col_in')}</TableHead>
                <TableHead className={cn(NUM, 'hidden sm:table-cell')}>{t('col_out')}</TableHead>
                <TableHead className={NUM}>{t('col_closing')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sections.map((s) => {
                const expanded = open.has(s.iso_week)
                return (
                  <Fragment key={s.iso_week}>
                    <TableRow className="cursor-pointer" onClick={() => toggle(s.iso_week)}>
                      <TableCell className="whitespace-nowrap">
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 text-left"
                          aria-expanded={expanded}
                          aria-label={t('expand', { week: s.week })}
                          onClick={(e) => {
                            e.stopPropagation()
                            toggle(s.iso_week)
                          }}
                        >
                          {expanded ? <ChevronDownIcon className="h-4 w-4 text-muted-foreground" /> : <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />}
                          <span>{t('week_short', { week: s.week })}</span>
                        </button>
                        {s.lowest ? (
                          <Badge variant="outline" className="ml-2">
                            {t('chip_lowest')}
                          </Badge>
                        ) : s.belowThreshold ? (
                          <Badge variant="warning" className="ml-2">
                            {t('chip_below')}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap tabular-nums text-muted-foreground sm:table-cell">
                        {formatDate(s.start)} - {formatDate(s.end)}
                      </TableCell>
                      <TableCell className={cn(NUM, 'hidden sm:table-cell')}>{formatWholeKr(s.opening)}</TableCell>
                      <TableCell className={cn(NUM, 'hidden sm:table-cell')}>{s.inflow === 0 ? '' : formatWholeKr(s.inflow)}</TableCell>
                      <TableCell className={cn(NUM, 'hidden sm:table-cell')}>{s.outflow === 0 ? '' : formatWholeKr(s.outflow)}</TableCell>
                      <TableCell className={cn(NUM, s.closing < 0 && 'text-destructive')}>{formatWholeKr(s.closing)}</TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={6} className="max-w-0 bg-secondary/20 px-4 py-3">
                          {s.flows.length === 0 ? (
                            <div className="text-[12.5px] text-muted-foreground">{t('week_empty')}</div>
                          ) : (
                            <ul className="space-y-1">
                              {s.flows.map((f, i) => (
                                <FlowLine
                                  key={`${f.source}:${f.ref?.id ?? ''}:${f.date}:${i}`}
                                  flow={f}
                                  onCancel={canWrite && f.ref?.type === 'cash_forecast_row' ? () => cancelRow(f.ref!.id, f.amount, f.date) : undefined}
                                />
                              ))}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(forecast.overdue.receivables.invoices.length > 0 || forecast.overdue.payables.invoices.length > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('overdue_title')}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <OverdueList
              title={t('overdue_receivables')}
              total={forecast.overdue.receivables.total}
              items={forecast.overdue.receivables.invoices.map((i) => ({
                key: i.invoice_id,
                href: `/invoices/${encodeURIComponent(i.invoice_id)}`,
                name: i.customer_name,
                number: i.invoice_number,
                days: i.days_overdue,
                amount: i.amount,
              }))}
            />
            <OverdueList
              title={t('overdue_payables')}
              total={forecast.overdue.payables.total}
              items={forecast.overdue.payables.invoices.map((i) => ({
                key: i.supplier_invoice_id,
                href: `/supplier-invoices/${encodeURIComponent(i.supplier_invoice_id)}`,
                name: i.supplier_name,
                number: i.supplier_invoice_number,
                days: i.days_overdue,
                amount: i.amount,
              }))}
            />
          </div>
        </section>
      )}

      {pastRows.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('past_title')}</h2>
          <div className="text-[12.5px] text-muted-foreground">{t('past_hint')}</div>
          <ul className="divide-y divide-border border-y border-border text-[13px]">
            {pastRows.map((row) => (
              <li key={row.cash_forecast_row_id} className="flex items-center gap-3 py-2">
                <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{formatDate(row.expected_date)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {row.note ?? t(`category_${row.category}`)}
                  {row.external_source && <span className="text-muted-foreground"> · {row.external_source}</span>}
                </span>
                <span className={cn(NUM, row.direction === 'out' && 'text-destructive')}>
                  {formatAmount(row.direction === 'out' ? -row.amount : row.amount)}
                </span>
                {canWrite && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('cancel_row')}
                    onClick={() => cancelRow(row.cash_forecast_row_id, row.amount, row.expected_date)}
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {caveats.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('caveats_title')}</h2>
          <ul className="space-y-1 text-[12.5px] text-muted-foreground">
            {caveats.map((c, i) => (
              <li key={`${c.code}:${i}`}>{locale === 'en' ? c.message_en : c.message_sv}</li>
            ))}
          </ul>
        </section>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}

/** One flow inside an expanded week: date, what it is, a chip when it is not known, the signed amount, the way to its source. */
function FlowLine({ flow, onCancel }: { flow: CashFlow; onCancel?: () => void }) {
  const t = useTranslations('cash_forecast')
  const href = flowHref(flow)
  const title = flow.counterparty ?? t(`source_${flow.source}`)
  const detail = flow.counterparty ? [t(`source_${flow.source}`), flow.reference].filter(Boolean).join(' · ') : flow.reference
  const signed = flow.direction === 'out' ? -flow.amount : flow.amount
  return (
    <li className="flex items-center gap-3 text-[13px]">
      <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{formatDate(flow.date)}</span>
      <span className="min-w-0 flex-1 truncate">
        {href ? (
          <Link href={href} className="underline decoration-border underline-offset-4 hover:decoration-foreground">
            {title}
          </Link>
        ) : (
          title
        )}
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </span>
      {flow.estimate ? (
        <Badge variant="outline">{t('chip_estimate')}</Badge>
      ) : flow.kind === 'forecast' ? (
        <Badge variant="outline">{t('chip_forecast')}</Badge>
      ) : null}
      <span className={cn(NUM, 'w-24', flow.direction === 'out' && 'text-destructive')}>{formatAmount(signed)}</span>
      {onCancel ? (
        <Button size="icon-sm" variant="ghost" aria-label={t('cancel_row')} onClick={onCancel}>
          <XMarkIcon className="h-4 w-4" />
        </Button>
      ) : (
        <span className="w-8 shrink-0" aria-hidden="true" />
      )}
    </li>
  )
}

interface OverdueItem {
  key: string
  href: string
  name: string
  number: string | null
  days: number
  amount: number
}

function OverdueList({ title, total, items }: { title: string; total: number; items: OverdueItem[] }) {
  const t = useTranslations('cash_forecast')
  if (items.length === 0) return null
  const shown = items.slice(0, OVERDUE_SHOWN)
  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="tabular-nums text-[13px]">{formatCurrency(total)}</span>
      </CardHeader>
      <CardContent className="space-y-1">
        <ul className="space-y-1 text-[13px]">
          {shown.map((item) => (
            <li key={item.key} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">
                <Link href={item.href} className="underline decoration-border underline-offset-4 hover:decoration-foreground">
                  {item.name}
                </Link>
                {item.number && <span className="text-muted-foreground"> · {item.number}</span>}
              </span>
              <span className="whitespace-nowrap text-[12.5px] text-muted-foreground">{t('overdue_days', { days: item.days })}</span>
              <span className={cn(NUM, 'w-24')}>{formatAmount(item.amount)}</span>
            </li>
          ))}
        </ul>
        {items.length > shown.length && (
          <div className="text-[12.5px] text-muted-foreground">{t('overdue_more', { count: items.length - shown.length })}</div>
        )}
      </CardContent>
    </Card>
  )
}
