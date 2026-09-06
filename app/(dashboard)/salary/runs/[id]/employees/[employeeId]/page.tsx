'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Calculator, Loader2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { SalaryCalendar } from '@/components/salary/SalaryCalendar'
import { SalaryOverridePanel } from '@/components/salary/SalaryOverridePanel'
import { cn, formatCurrency } from '@/lib/utils'
import type { SalaryRun, SalaryRunEmployee, SalaryLineItem, SalaryLineItemType, EmployeeMasked } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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
  expense_reimbursement: 'li_expense_reimbursement',
  net_deduction_advance: 'li_net_deduction_advance',
  net_deduction_union: 'li_net_deduction_union',
  net_deduction_benefit_payment: 'li_net_deduction_benefit_payment',
  net_deduction_other: 'li_net_deduction_other',
  oresavrundning: 'li_oresavrundning',
  correction: 'li_correction',
  other: 'li_other',
}

// Same chip vocabulary as the Löner list and the run header (chips mark
// exceptions): booked renders as muted text, everything else as a chip.
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  draft: 'secondary',
  review: 'secondary',
  approved: 'secondary',
  paid: 'success',
  booked: 'success',
  corrected: 'outline',
}

interface DetailResponse {
  run: SalaryRun
  runEmployee: SalaryRunEmployee & { employee: EmployeeMasked; line_items: SalaryLineItem[] }
}

export default function SalaryRunEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>
}) {
  const t = useTranslations('salary_run_employee')
  const tSalary = useTranslations('salary')
  const { id: runId, employeeId } = use(params)
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [removingLineId, setRemovingLineId] = useState<string | null>(null)
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
      const runJson = await runRes.json().catch(() => null)
      const sreJson = await sreRes.json().catch(() => null)
      // Map the parsed body plus the status, never `new Error(json.error)`:
      // the routes answer thrown errors with the canonical envelope
      // `{ error: { code, message } }`, and the Error constructor stringifies
      // that object to "[object Object]", which falls through to the generic
      // "Något gick fel" and discards the route's own Swedish reason.
      if (!runRes.ok) {
        setError(getUserErrorMessage(runJson, { statusCode: runRes.status }))
        return
      }
      if (!sreRes.ok) {
        setError(getUserErrorMessage(sreJson, { statusCode: sreRes.status }))
        return
      }
      setData({ run: runJson.data, runEmployee: sreJson.data })
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
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
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // Same reason as in load(): the calculate route builds its refusals
        // with errorResponse(), so `json.error` is the envelope object.
        setError(getUserErrorMessage(json, { statusCode: res.status }))
        return
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setCalculating(false)
    }
  }

  // Utlägg lines (#2331) are the only lines this page lets the user remove:
  // they were added from the run page with one click and must be just as
  // easy to take off again. The claim goes back to Att göra.
  const handleRemoveLine = async (lineId: string) => {
    setRemovingLineId(lineId)
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${runId}/lines/${lineId}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(getUserErrorMessage(json, { statusCode: res.status }))
        return
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      setRemovingLineId(null)
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
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back_to_run')}
        </Link>
        <p className="text-sm text-destructive">{error ?? t('error_load_employee')}</p>
      </div>
    )
  }

  const { run, runEmployee } = data
  const employee = runEmployee.employee
  const lineItems = runEmployee.line_items ?? []
  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const readOnly = run.status !== 'draft' && run.status !== 'review'
  // Utlägg lines can be taken off the payslip only while the run is a draft
  // (the line commands' gate); the column exists only then.
  const canRemoveClaimLines = run.status === 'draft'
  const statusLabel = tSalary(`status_${run.status}`)

  const taxValue = runEmployee.tax_withheld_override ?? runEmployee.tax_withheld
  const taxOverridden = runEmployee.tax_withheld_override !== null
  const avgifterOverridden = runEmployee.avgifter_amount_override !== null
  const kpis: Array<{ label: string; value: number; accent?: boolean; overridden?: boolean }> = [
    { label: t('gross'), value: runEmployee.gross_salary },
    { label: t('tax'), value: taxValue, overridden: taxOverridden },
    {
      label: t('net'),
      value: runEmployee.net_salary + (runEmployee.tax_withheld - taxValue),
      accent: true,
      overridden: taxOverridden,
    },
    {
      label: t('avgifter'),
      value: runEmployee.avgifter_amount_override ?? runEmployee.avgifter_amount,
      overridden: avgifterOverridden,
    },
  ]
  const absenceCounts = [
    { label: t('sick_days'), days: liveCounts?.sick ?? runEmployee.sick_days },
    { label: t('vab_days'), days: liveCounts?.vab ?? runEmployee.vab_days },
    { label: t('parental_days'), days: liveCounts?.parental ?? runEmployee.parental_days },
  ]

  return (
    <div className="space-y-8 stagger-enter">
      {/* Back link on its own quiet row */}
      <div>
        <Link
          href={`/salary/runs/${runId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back_to_run')}
        </Link>
      </div>

      {/* Header: serif name with the run's status as the one status element,
          a quiet meta line, and the next step on the right. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl leading-8 tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            {run.status === 'booked' ? (
              <span className="text-sm text-muted-foreground">{statusLabel}</span>
            ) : (
              <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'}>{statusLabel}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="tabular-nums">{employee.personnummer_masked}</span>
            {' · '}
            <span className="tabular-nums">{t('payslip_period', { period: periodLabel })}</span>
          </p>
        </div>
        {run.status === 'draft' && (
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={handleCalculate} disabled={calculating}>
              {calculating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Calculator className="mr-2 h-4 w-4" />
              )}
              {t('calculate')}
            </Button>
          </div>
        )}
      </div>

      {/* Summary: flat label/number pairs, no tiles. The override is the
          exception, so it is a chip next to the label. */}
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        {kpis.map(({ label, value, accent, overridden }) => (
          <div key={label} className="min-w-0">
            <p className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              {label}
              {overridden && <Badge variant="warning">{t('adjusted_badge')}</Badge>}
            </p>
            <p className={cn('mt-1 font-display text-xl tabular-nums leading-none', accent && 'text-success')}>
              {formatCurrency(value)}
            </p>
          </div>
        ))}
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

      {/* Unified calendar: worked time (for hourly) + absence on the same grid.
          The how-to lives behind the kicker's "?" (convention 7). */}
      <DetailSection
        kicker={t('time_absence_title')}
        help={
          <HelpPopover>
            {employee.salary_type === 'hourly'
              ? t('calendar_hint_hourly')
              : t('calendar_hint_monthly')}
          </HelpPopover>
        }
      >
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
        <div className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
          {absenceCounts.map(({ label, days }) => (
            <div key={label} className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 text-sm tabular-nums">{t('days_count', { days })}</p>
            </div>
          ))}
        </div>
      </DetailSection>

      {/* Line items: the list-page table idiom straight on the panel. */}
      <DetailSection kicker={t('line_items_title', { count: lineItems.length })}>
        {lineItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('no_line_items')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'pl-0')}>{t('th_type')}</th>
                  <th className={TH_CLASS}>{t('th_description')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_quantity')}</th>
                  <th className={cn(TH_CLASS, 'text-right', !canRemoveClaimLines && 'pr-0')}>{t('th_amount')}</th>
                  {canRemoveClaimLines && (
                    <th className={cn(TH_CLASS, 'pr-0 text-right')}>
                      <span className="sr-only">{t('th_actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <tr key={li.id} className={cn(canRemoveClaimLines && 'group')}>
                    <td className={cn(TD_CLASS, 'pl-0 text-muted-foreground')}>
                      {LINE_ITEM_TYPE_KEYS[li.item_type] ? t(LINE_ITEM_TYPE_KEYS[li.item_type]) : li.item_type}
                    </td>
                    <td className={TD_CLASS}>{li.description}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{li.quantity ?? '-'}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums', !canRemoveClaimLines && 'pr-0')}>
                      {formatCurrency(li.amount)}
                    </td>
                    {canRemoveClaimLines && (
                      <td className={cn(TD_CLASS, 'pr-0 text-right')}>
                        {li.source_expense_claim_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn('-my-1 h-8 w-8 text-muted-foreground hover:text-foreground', HOVER_REVEAL_CLASS)}
                            onClick={() => handleRemoveLine(li.id)}
                            disabled={removingLineId === li.id}
                            aria-label={t('remove_expense_claim_line_aria')}
                            title={t('remove_expense_claim_line_aria')}
                          >
                            {removingLineId === li.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <X className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DetailSection>
    </div>
  )
}
