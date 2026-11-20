'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { ReconcileVacationLiabilityDialog } from '@/components/salary/VacationLiabilityConfirmDialog'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { roundOre } from '@/lib/money'
import { formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type {
  VacationLiabilityCheck,
  VacationLiabilityReport,
  VacationLiabilityRow,
} from '@/lib/reports/vacation-liability'

export type SemesterskuldData = VacationLiabilityReport & { check: VacationLiabilityCheck | null }

const DAYS = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 })
const NUM = 'text-right tabular-nums whitespace-nowrap'
/** A difference within a krona is öre noise, not something to book. */
const TOLERANCE = 1

/**
 * Semesterskuld (BFNAR 2016:10) as of the selected fiscal year's end, or
 * today while the year runs: one line per employee with the days and the
 * computed liability (the day value and its make-up behind the amount), one
 * summary line set against what 2920/2940 hold, and when the two differ one
 * ochre sentence that offers to book the difference.
 */
export function SemesterskuldView({ periodId }: { periodId: string }) {
  const t = useTranslations('reports')
  const locale = useLocale() as ErrorLocale
  const [data, setData] = useState<SemesterskuldData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/reports/vacation-liability?period_id=${encodeURIComponent(periodId)}`)
        const result = await res.json()
        if (cancelled) return
        if (!res.ok || result.error) {
          setError(getErrorMessage(result, { locale }))
        } else {
          setData(result.data)
        }
      } catch {
        if (!cancelled) setError(t('ss_error'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // t is stable for the mounted locale; the period and a reload are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId, reload])

  const refresh = useCallback(() => setReload((n) => n + 1), [])

  if (loading && !data) {
    return (
      <LateReveal>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex h-9 items-center justify-between border-b-hairline">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </LateReveal>
    )
  }

  if (error && !data) {
    return <LoadError title={error} onRetry={refresh} />
  }

  if (!data) return null

  return (
    <SemesterskuldReport
      data={data}
      exportBase={`/api/reports/vacation-liability?period_id=${encodeURIComponent(periodId)}`}
      onReconciled={refresh}
      onRefreshFailedRetry={error ? refresh : undefined}
    />
  )
}

/**
 * The report body, from a loaded report. Split from the fetch so the
 * sandbox preview renders it from hand-made data.
 */
export function SemesterskuldReport({
  data,
  exportBase,
  onReconciled,
  onRefreshFailedRetry,
}: {
  data: SemesterskuldData
  exportBase: string
  onReconciled: () => void
  /** Set when a refresh failed with the report on screen: its line takes the page's one attention line. */
  onRefreshFailedRetry?: () => void
}) {
  const tCommon = useTranslations('common')
  const t = useTranslations('reports')
  const { canWrite } = useCanWrite()
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const { totals, check } = data
  const computedTotal = totals.computedTotal
  const difference = check?.computedDifferenceTotal ?? 0
  const hasDifference = !!check && Math.abs(difference) > TOLERANCE

  if (data.rows.length === 0 && computedTotal === 0 && (!check || !hasDifference)) {
    return <EmptyState title={t('ss_empty_title')} description={t('ss_empty_desc')} />
  }

  const differenceText = hasDifference
    ? t(difference > 0 ? 'ss_attn_under' : 'ss_attn_over', { amount: formatCurrency(Math.abs(difference)) })
    : null

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `${exportBase}&format=pdf` },
          { format: 'xlsx', href: `${exportBase}&format=xlsx` },
        ]}
      />

      <p className="text-xs text-muted-foreground tabular-nums">
        {t('ss_summary', { date: formatDate(data.asOfDate), start: formatDate(data.vacationYearStart) })}
      </p>

      {onRefreshFailedRetry ? (
        <AttnLine action={{ label: tCommon('retry'), onClick: onRefreshFailedRetry }}>{tCommon('refresh_failed')}</AttnLine>
      ) : differenceText ? (
        <AttnLine action={canWrite ? { label: t('ss_attn_action'), onClick: () => setReconcileOpen(true) } : undefined}>
          {differenceText}
        </AttnLine>
      ) : null}

      <Card>
        <CardContent>
          <div className="overflow-x-auto stagger-enter">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ss_col_employee')}</TableHead>
                  <TableHead className="w-20 text-right">{t('ss_col_days')}</TableHead>
                  <TableHead className="w-20 text-right">{t('ss_col_taken')}</TableHead>
                  <TableHead className="w-20 text-right">{t('ss_col_remaining')}</TableHead>
                  <TableHead className="w-20 text-right">{t('ss_col_saved')}</TableHead>
                  <TableHead className="w-36 text-right">{t('ss_col_liability')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.employeeId}>
                    <TableCell className="max-w-0 truncate">{row.employeeName}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysEntitled)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysTaken)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysRemaining)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysSaved)}</TableCell>
                    <TableCell className={NUM}>
                      <InfoTooltip content={<LiabilityDetail row={row} />} side="left">
                        <span className="cursor-help underline decoration-dotted decoration-muted-foreground underline-offset-4">
                          {formatAmount(roundOre(row.computedLiability + row.computedAvgifter))}
                        </span>
                      </InfoTooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5} className="font-medium">{t('ss_total')}</TableCell>
                  <TableCell className={`${NUM} font-medium`}>{formatAmount(computedTotal)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </CardContent>
      </Card>

      {check && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {/* The Summa row is the calculated liability and the ochre line names
              the difference, so this line only adds what the books hold. */}
          {t(hasDifference ? 'ss_line_booked' : 'ss_line_booked_matches', {
            amount: formatCurrency(roundOre(check.booked2920 + check.booked2940), 'SEK', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          })}
        </p>
      )}

      {totals.advanceVacationDebt !== 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('ss_advance_debt', { amount: formatAmount(totals.advanceVacationDebt) })}
        </p>
      )}

      {canWrite && (
        <ReconcileVacationLiabilityDialog
          open={reconcileOpen}
          onOpenChange={setReconcileOpen}
          asOf={data.asOfDate}
          onDone={onReconciled}
        />
      )}
    </div>
  )
}

/** What the amount is made of: days, day value, rörliga lönedelar, avgifter. */
function LiabilityDetail({ row }: { row: VacationLiabilityRow }) {
  const t = useTranslations('reports')
  return (
    <div className="space-y-1 text-xs tabular-nums">
      <div>{t('ss_detail_days', { days: DAYS.format(row.liabilityDays), value: formatCurrency(row.dayValue) })}</div>
      {row.earningPay !== 0 && <div>{t('ss_detail_earning', { amount: formatCurrency(row.earningPay) })}</div>}
      {row.variablePay !== 0 && <div>{t('ss_detail_variable', { amount: formatCurrency(row.variablePay) })}</div>}
      <div>{t('ss_detail_avgifter', { amount: formatCurrency(row.computedAvgifter) })}</div>
      {row.dayValueEstimated && <div className="text-muted-foreground">{t('ss_detail_estimated')}</div>}
      {row.vacationDaysOffRemaining != null && (
        <div className="text-muted-foreground">{t('ss_days_off', { days: DAYS.format(row.vacationDaysOffRemaining) })}</div>
      )}
    </div>
  )
}
