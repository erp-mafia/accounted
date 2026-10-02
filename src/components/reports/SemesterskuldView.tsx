'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle, Palmtree } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
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
import { formatAmount } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { VacationLiabilityCheck, VacationLiabilityReport } from '@/lib/reports/vacation-liability'

type SemesterskuldData = VacationLiabilityReport & { check: VacationLiabilityCheck | null }

const DAYS = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 })
const NUM = 'text-right tabular-nums'

/**
 * Semesterskuld (BFNAR 2016:10): per-employee vacation liability on
 * 2920/2940 as of the selected fiscal year's end, with the booked balances
 * beside the totals so a difference is visible.
 */
export function SemesterskuldView({ periodId }: { periodId: string }) {
  const t = useTranslations('reports')
  const locale = useLocale() as ErrorLocale
  const [data, setData] = useState<SemesterskuldData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    // t is stable for the mounted locale; the period is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const exportBase = `/api/reports/vacation-liability?period_id=${encodeURIComponent(periodId)}`
  const { totals, check } = data
  const hasDifference = !!check && (check.difference2920 !== 0 || check.difference2940 !== 0)

  if (data.rows.length === 0 && totals.totalLiability === 0 && (!check || !hasDifference)) {
    return <EmptyState icon={Palmtree} title={t('ss_empty_title')} description={t('ss_empty_desc')} />
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu
        items={[
          { format: 'pdf', href: `${exportBase}&format=pdf` },
          { format: 'xlsx', href: `${exportBase}&format=xlsx` },
        ]}
      />

      <p className="text-[12.5px] text-muted-foreground tabular-nums">
        {t('ss_summary', { date: data.asOfDate, start: data.vacationYearStart })}
        {' · '}
        {data.closedYear ? t('ss_basis_closed', { date: data.closedYear.end }) : t('ss_basis_open')}
      </p>

      {hasDifference && <AttnLine>{t('ss_check_difference')}</AttnLine>}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto stagger-enter">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ss_col_employee')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_days')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_taken')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_remaining')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_saved')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_2920')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_2940')}</TableHead>
                  <TableHead className="text-right">{t('ss_col_total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.employeeId}>
                    <TableCell>{row.employeeName}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysEntitled)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysTaken)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysRemaining)}</TableCell>
                    <TableCell className={NUM}>{DAYS.format(row.vacationDaysSaved)}</TableCell>
                    <TableCell className={NUM}>{formatAmount(row.accruedAmount)}</TableCell>
                    <TableCell className={NUM}>{formatAmount(row.accruedAvgifter)}</TableCell>
                    <TableCell className={NUM}>{formatAmount(row.totalLiability)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5} className="font-medium">{t('ss_total')}</TableCell>
                  <TableCell className={`${NUM} font-medium`}>{formatAmount(totals.accruedAmount)}</TableCell>
                  <TableCell className={`${NUM} font-medium`}>{formatAmount(totals.accruedAvgifter)}</TableCell>
                  <TableCell className={`${NUM} font-medium`}>{formatAmount(totals.totalLiability)}</TableCell>
                </TableRow>
                {check && (
                  <>
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        {t('ss_check_booked', { date: data.asOfDate })}
                      </TableCell>
                      <TableCell className={`${NUM} text-muted-foreground`}>{formatAmount(check.booked2920)}</TableCell>
                      <TableCell className={`${NUM} text-muted-foreground`}>{formatAmount(check.booked2940)}</TableCell>
                      <TableCell className={`${NUM} text-muted-foreground`}>
                        {formatAmount(Math.round((check.booked2920 + check.booked2940) * 100) / 100)}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">{t('ss_check_difference_label')}</TableCell>
                      <TableCell className={NUM}>{formatAmount(check.difference2920)}</TableCell>
                      <TableCell className={NUM}>{formatAmount(check.difference2940)}</TableCell>
                      <TableCell className={NUM}>
                        {formatAmount(Math.round((check.difference2920 + check.difference2940) * 100) / 100)}
                      </TableCell>
                    </TableRow>
                  </>
                )}
              </TableFooter>
            </Table>
          </div>
        </CardContent>
      </Card>

      {totals.advanceVacationDebt !== 0 && (
        <p className="text-[12.5px] text-muted-foreground tabular-nums">
          {t('ss_advance_debt', { amount: formatAmount(totals.advanceVacationDebt) })}
        </p>
      )}
    </div>
  )
}
