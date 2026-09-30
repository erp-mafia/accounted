'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
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
import { cn, formatCurrency } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { SalaryJournalReport } from '@/lib/reports/salary-journal'

/**
 * Lönejournal on screen: booked salary runs per employee and month for a
 * calendar year (payroll follows the inkomstår, not the räkenskapsår), with
 * the existing xlsx export. Only booked runs count, as in the export.
 */

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

export function LonejournalView() {
  const t = useTranslations('lonejournal')
  const locale = useLocale()
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [monthFrom, setMonthFrom] = useState(1)
  const [monthTo, setMonthTo] = useState(12)

  // Fetch outcome tagged with the key it was requested under, so a stale
  // response never paints over the current picker state.
  const [result, setResult] = useState<{ key: string; data?: SalaryJournalReport; error?: string } | null>(null)

  const query = `year=${year}&month_from=${monthFrom}&month_to=${monthTo}`
  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/salary-journal?${query}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setResult({ key: query, error: getErrorMessage(json, { statusCode: res.status }) })
          return
        }
        setResult({ key: query, data: json.data as SalaryJournalReport })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: query, error: t('load_failed') })
      })
    return () => {
      cancelled = true
    }
  }, [query, t])

  const monthName = (month: number) =>
    new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2026, month - 1, 1))

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i)
  const upToDate = result !== null && result.key === query
  const report = upToDate ? result.data ?? null : null
  const error = upToDate ? result.error ?? null : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('year_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(monthFrom)}
          onValueChange={(v) => {
            const from = Number(v)
            setMonthFrom(from)
            if (monthTo < from) setMonthTo(from)
          }}
        >
          <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('month_from_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {monthName(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[13px] text-muted-foreground">-</span>
        <Select
          value={String(monthTo)}
          onValueChange={(v) => {
            const to = Number(v)
            setMonthTo(to)
            if (monthFrom > to) setMonthFrom(to)
          }}
        >
          <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-auto gap-1.5')} aria-label={t('month_to_label')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {monthName(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/salary-journal/xlsx?${query}` }]} />
      </div>

      {!upToDate ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error || !report ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            <AlertCircle className="mx-auto mb-2 h-6 w-6" />
            {error ?? t('load_failed')}
          </CardContent>
        </Card>
      ) : report.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col_employee')}</TableHead>
                  <TableHead>{t('col_period')}</TableHead>
                  <TableHead className="text-right">{t('col_gross')}</TableHead>
                  <TableHead className="text-right">{t('col_tax')}</TableHead>
                  <TableHead className="text-right">{t('col_net')}</TableHead>
                  <TableHead className="text-right">{t('col_avgifter')}</TableHead>
                  <TableHead className="text-right">{t('col_vacation')}</TableHead>
                  <TableHead className="text-right">{t('col_total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="stagger-enter">
                {report.rows.map((row, i) => (
                  <TableRow key={`${row.employeeId}-${row.periodYear}-${row.periodMonth}-${i}`}>
                    <TableCell data-ph-mask>{row.employeeName}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.periodYear}-{String(row.periodMonth).padStart(2, '0')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.grossSalary)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.taxWithheld)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.netSalary)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.avgifterAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.vacationAccrual)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(row.totalEmployerCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="font-medium">
                    {t('total')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.grossSalary)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.taxWithheld)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.netSalary)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.avgifterAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.vacationAccrual)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(report.totals.totalEmployerCost)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">{t('booked_only_note')}</p>
    </div>
  )
}
