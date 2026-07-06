'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Calculator, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SalaryCalendar } from '@/components/salary/SalaryCalendar'
import { SalaryOverridePanel } from '@/components/salary/SalaryOverridePanel'
import { formatCurrency } from '@/lib/utils'
import type { SalaryRun, SalaryRunEmployee, SalaryLineItem, SalaryLineItemType, Employee } from '@/types'

/** Translation keys in the `salary_run_employee` namespace. */
const LINE_ITEM_TYPE_KEYS: Record<SalaryLineItemType, string> = {
  monthly_salary: 'li_monthly_salary',
  hourly_salary: 'li_hourly_salary',
  overtime: 'li_overtime',
  overtime_50: 'li_overtime_50',
  overtime_100: 'li_overtime_100',
  ob_weekday_evening: 'li_ob_weekday_evening',
  ob_weekend: 'li_ob_weekend',
  ob_night: 'li_ob_night',
  ob_holiday: 'li_ob_holiday',
  bonus: 'li_bonus',
  commission: 'li_commission',
  gross_deduction_pension: 'li_gross_deduction_pension',
  gross_deduction_other: 'li_gross_deduction_other',
  benefit_car: 'li_benefit_car',
  benefit_housing: 'li_benefit_housing',
  benefit_meals: 'li_benefit_meals',
  benefit_wellness: 'li_benefit_wellness',
  benefit_bike: 'li_benefit_bike',
  benefit_other: 'li_benefit_other',
  sick_karens: 'li_sick_karens',
  sick_day2_14: 'li_sick_day2_14',
  sick_day15_plus: 'li_sick_day15_plus',
  vab: 'li_vab',
  parental_leave: 'li_parental_leave',
  unpaid_leave: 'li_unpaid_leave',
  vacation: 'li_vacation',
  semesterersattning: 'li_semesterersattning',
  traktamente_taxfree: 'li_traktamente_taxfree',
  traktamente_taxable: 'li_traktamente_taxable',
  mileage_taxfree: 'li_mileage_taxfree',
  mileage_taxable: 'li_mileage_taxable',
  net_deduction_advance: 'li_net_deduction_advance',
  net_deduction_union: 'li_net_deduction_union',
  net_deduction_benefit_payment: 'li_net_deduction_benefit_payment',
  net_deduction_other: 'li_net_deduction_other',
  correction: 'li_correction',
  other: 'li_other',
}

interface DetailResponse {
  run: SalaryRun
  runEmployee: SalaryRunEmployee & { employee: Employee; line_items: SalaryLineItem[] }
}

export default function SalaryRunEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>
}) {
  const t = useTranslations('salary_run_employee')
  const { id: runId, employeeId } = use(params)
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  // Live counts pushed from the calendar: overrides the stale snapshot from
  // the last calculation so badges update immediately on absence save.
  const [liveCounts, setLiveCounts] = useState<{ sick: number; vab: number; parental: number } | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [runRes, sreRes] = await Promise.all([
        fetch(`/api/salary/runs/${runId}`),
        fetch(`/api/salary/runs/${runId}/employees/${employeeId}`),
      ])
      const runJson = await runRes.json()
      const sreJson = await sreRes.json()
      if (!runRes.ok) throw new Error(runJson.error || t('error_load_run'))
      if (!sreRes.ok) throw new Error(sreJson.error || t('error_load_employee'))
      setData({ run: runJson.data, runEmployee: sreJson.data })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('unknown_error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, employeeId])

  const handleCalculate = async () => {
    setCalculating(true)
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${runId}/calculate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error || t('error_calculate'))
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('unknown_error'))
    } finally {
      setCalculating(false)
    }
  }

  const periodStart = useMemo(() => {
    if (!data) return ''
    const y = data.run.period_year
    const m = data.run.period_month
    return `${y}-${String(m).padStart(2, '0')}-01`
  }, [data])

  const periodEnd = useMemo(() => {
    if (!data) return ''
    const y = data.run.period_year
    const m = data.run.period_month
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  }, [data])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        <Link
          href={`/salary/runs/${runId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> {t('back_to_run')}
        </Link>
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error ?? t('error_load_employee')}
        </div>
      </div>
    )
  }

  const { run, runEmployee } = data
  const employee = runEmployee.employee
  const lineItems = runEmployee.line_items ?? []
  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const readOnly = run.status !== 'draft' && run.status !== 'review'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-3">
        <Link
          href={`/salary/runs/${runId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> {t('back_to_run')}
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="font-display text-2xl tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="text-sm text-muted-foreground tabular-nums">
              {employee.personnummer} · {t('payslip_period', { period: periodLabel })}
            </p>
          </div>
          {run.status === 'draft' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCalculate}
              disabled={calculating}
            >
              {calculating ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Calculator className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('calculate')}
            </Button>
          )}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label={t('gross')} value={runEmployee.gross_salary} />
        <SummaryCard
          label={t('tax')}
          value={runEmployee.tax_withheld_override ?? runEmployee.tax_withheld}
          overridden={runEmployee.tax_withheld_override !== null}
        />
        <SummaryCard
          label={t('net')}
          value={runEmployee.net_salary + (runEmployee.tax_withheld - (runEmployee.tax_withheld_override ?? runEmployee.tax_withheld))}
          accent
          overridden={runEmployee.tax_withheld_override !== null}
        />
        <SummaryCard
          label={t('avgifter')}
          value={runEmployee.avgifter_amount_override ?? runEmployee.avgifter_amount}
          overridden={runEmployee.avgifter_amount_override !== null}
        />
      </div>

      {/* Advanced mode: per-employee override of tax / arbetsgivaravgift */}
      {run.status === 'review' && (
        <SalaryOverridePanel
          runId={runId}
          employeeId={employeeId}
          taxWithheld={runEmployee.tax_withheld}
          taxOverride={runEmployee.tax_withheld_override}
          avgifterAmount={runEmployee.avgifter_amount}
          avgifterOverride={runEmployee.avgifter_amount_override}
          avgifterBasis={runEmployee.avgifter_basis}
          avgifterBasisOverride={runEmployee.avgifter_basis_override}
          reason={runEmployee.override_reason}
          onSaved={load}
          disabled={readOnly}
        />
      )}

      {/* Unified calendar: worked time (for hourly) + absence on the same grid */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('time_absence_title')}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {employee.salary_type === 'hourly'
              ? t('calendar_hint_hourly')
              : t('calendar_hint_monthly')}
          </p>
        </CardHeader>
        <CardContent>
          <SalaryCalendar
            employeeId={employee.id}
            salaryType={employee.salary_type}
            periodStart={periodStart}
            periodEnd={periodEnd}
            salaryRunEmployeeId={runEmployee.id}
            readOnly={readOnly}
            onChange={load}
            onAbsenceCountsChange={setLiveCounts}
          />
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <AbsenceCount label={t('sick_days')} days={liveCounts?.sick ?? runEmployee.sick_days} />
            <AbsenceCount label={t('vab_days')} days={liveCounts?.vab ?? runEmployee.vab_days} />
            <AbsenceCount label={t('parental_days')} days={liveCounts?.parental ?? runEmployee.parental_days} />
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('line_items_title', { count: lineItems.length })}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {lineItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t('no_line_items')}
            </p>
          ) : (
            <table className="w-full">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="px-4 py-2">{t('th_type')}</th>
                  <th className="px-4 py-2">{t('th_description')}</th>
                  <th className="px-4 py-2 text-right">{t('th_quantity')}</th>
                  <th className="px-4 py-2 text-right">{t('th_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <tr key={li.id} className="border-b last:border-0">
                    <td className="px-4 py-2 text-xs text-muted-foreground">{LINE_ITEM_TYPE_KEYS[li.item_type] ? t(LINE_ITEM_TYPE_KEYS[li.item_type]) : li.item_type}</td>
                    <td className="px-4 py-2 text-sm">{li.description}</td>
                    <td className="px-4 py-2 text-sm text-right tabular-nums">{li.quantity ?? '-'}</td>
                    <td className="px-4 py-2 text-sm text-right tabular-nums">{formatCurrency(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({ label, value, accent, overridden }: { label: string; value: number; accent?: boolean; overridden?: boolean }) {
  const t = useTranslations('salary_run_employee')
  return (
    <div className={`rounded-md border bg-card p-3 ${accent ? 'ring-1 ring-primary/40' : ''} ${overridden ? 'ring-1 ring-warning/40' : ''}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {overridden && <span className="text-[10px] uppercase tracking-wider text-warning">{t('adjusted_badge')}</span>}
      </div>
      <div className="mt-0.5 text-lg font-medium tabular-nums">{formatCurrency(value)}</div>
    </div>
  )
}

function AbsenceCount({ label, days }: { label: string; days: number }) {
  const t = useTranslations('salary_run_employee')
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{t('days_count', { days })}</div>
    </div>
  )
}
