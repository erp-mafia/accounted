'use client'

import { use, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Calculator, Loader2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { SalaryCalendar } from '@/components/salary/SalaryCalendar'
import { SalaryOverridePanel } from '@/components/salary/SalaryOverridePanel'
import { AddPayslipLineDialog } from '@/components/salary/AddPayslipLineDialog'
import { isManualPayslipLineType, manualLineCapsFromRunParams } from '@/lib/salary/manual-payslip-lines'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { hasCustomDeviationWindow } from '@/lib/salary/deviation-period'
import { payslipCalendarWindow } from '@/lib/salary/payslip-calendar'
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

/** A line as the detail route returns it: the source columns say where it came from. */
type LineRow = SalaryLineItem & {
  source_recurring_line_id?: string | null
  source_benefit_id?: string | null
}

interface DetailResponse {
  run: SalaryRun
  runEmployee: SalaryRunEmployee & { employee: EmployeeMasked; line_items: LineRow[] }
}

/**
 * Lines the user may take off a draft payslip: an utlägg line (added with one
 * click on the run page, #2331) and a one-off line added by hand here. Lines
 * the calculation or a recurring line derives are left alone: recalculation
 * would only bring them back.
 */
function isRemovableLine(li: LineRow): boolean {
  if (li.source_expense_claim_id) return true
  return isManualPayslipLineType(li.item_type) && !li.source_recurring_line_id && !li.source_benefit_id
}

export default function SalaryRunEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string; employeeId: string }>
}) {
  const t = useTranslations('salary_run_employee')
  const tSalary = useTranslations('salary')
  const tRun = useTranslations('salary_run')
  const { id: runId, employeeId } = use(params)
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [removingLineId, setRemovingLineId] = useState<string | null>(null)
  const [addingLine, setAddingLine] = useState(false)
  // Live counts pushed from the calendar: overrides the stale snapshot from
  // the last calculation so badges update immediately on absence save.
  const [liveCounts, setLiveCounts] = useState<{ sick: number; vab: number; parental: number } | null>(null)

  // Reloads overlap now that the content stays mounted while one is in
  // flight (save twice in the calendar, or save and recalculate): only the
  // newest request may write state, or an older response lands last.
  const loadSeq = useRef(0)

  const load = async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const [runRes, sreRes] = await Promise.all([
        fetch(`/api/salary/runs/${runId}`),
        fetch(`/api/salary/runs/${runId}/employees/${employeeId}`),
      ])
      const runJson = await runRes.json().catch(() => null)
      const sreJson = await sreRes.json().catch(() => null)
      if (seq !== loadSeq.current) return
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
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? getUserErrorMessage(e) : t('unknown_error'))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
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

  // Removes an utlägg line (#2331: added from the run page with one click,
  // just as easy to take off again; the claim goes back to Att göra) or a
  // one-off line added with "Lägg till rad". See isRemovableLine.
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

  // Only data that belongs to the payslip in the URL is shown; anything else
  // counts as "not loaded yet". Compared case-insensitively: Postgres matches
  // a hand-typed uppercase uuid, and the row comes back in lowercase.
  const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const current =
    data && sameId(data.run.id, runId) && sameId(data.runEmployee.employee_id, employeeId) ? data : null

  // The calendar works in the window the engine reads this run's absence and
  // worked days from (the avvikelseperiod), which is not the pay month on a
  // company that runs "föregående månads avvikelser".
  const calendarWindow = useMemo(
    () => (current ? payslipCalendarWindow(current.run) : null),
    [current],
  )

  // The spinner replaces the page on the FIRST load only. A reload after a
  // save or a recalculation keeps the content mounted: unmounting it reset
  // the calendar to its opening month on every saved post, and took the
  // selection, the scroll position and any open dialog with it.
  if (!current && loading) {
    return (
      <div role="status" aria-label={t('loading')} className="space-y-8">
        <Skeleton className="h-8 w-64" />
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-28" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    )
  }

  if (!current || !calendarWindow) {
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

  const { run, runEmployee } = current
  const employee = runEmployee.employee
  const lineItems = runEmployee.line_items ?? []
  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const readOnly = run.status !== 'draft' && run.status !== 'review'
  // Lines can be added to and taken off the payslip only while the run is a
  // draft (the line commands' gate); the button and the column exist only then.
  const canEditLines = run.status === 'draft'
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
    <div className="space-y-8 stagger-enter" aria-busy={loading}>
      {/* Header: the page-header hooks turn it into the top bar (convention
          2), like the run and employee pages. The way back to the run is a
          quiet arrow before the name instead of a row of its own; the run's
          status is the one status element, the meta line stays inline, and
          the next step sits on the right. */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="page-header-lead min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/salary/runs/${runId}`}
              aria-label={t('back_to_run')}
              title={t('back_to_run')}
              className="inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            {run.status === 'booked' ? (
              <span className="text-sm text-muted-foreground">{statusLabel}</span>
            ) : (
              <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'}>{statusLabel}</Badge>
            )}
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('loading')} />
            )}
          </div>
          <p className="page-header-meta mt-1 text-sm text-muted-foreground">
            <span className="tabular-nums">{employee.personnummer_masked}</span>
            {' · '}
            <span className="tabular-nums">{t('payslip_period', { period: periodLabel })}</span>
            {/* Same note as the run header: say which days this payslip reads
                when they are not the pay month, since the calendar opens there. */}
            {hasCustomDeviationWindow(run) && (
              <>
                {' · '}
                <span className="tabular-nums">
                  {tRun('deviation_period_note', {
                    start: formatDate(calendarWindow.start),
                    end: formatDate(calendarWindow.end),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
        {run.status === 'draft' && (
          <div className="page-header-action flex shrink-0 items-center gap-2">
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

      {/* A failed reload or recalculation is said under the bar, with the
          payslip still on screen, instead of replacing the page. */}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

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
          periodStart={calendarWindow.start}
          periodEnd={calendarWindow.end}
          hoursPerWeek={employee.hours_per_week}
          workdaysPerWeek={employee.workdays_per_week}
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

      {/* Line items: the list-page table idiom straight on the panel. One-off
          lines (milersättning, traktamente, bonus, a deduction) are added
          from the kicker's action; utlägg from the run page. */}
      <DetailSection
        kicker={t('line_items_title', { count: lineItems.length })}
        aside={
          canEditLines ? (
            <Button type="button" size="sm" variant="outline" className="-my-1" onClick={() => setAddingLine(true)}>
              {t('add_line')}
            </Button>
          ) : undefined
        }
      >
        {canEditLines && (
          <AddPayslipLineDialog
            open={addingLine}
            onOpenChange={setAddingLine}
            runId={runId}
            salaryRunEmployeeId={runEmployee.id}
            taxFreeCaps={manualLineCapsFromRunParams(run.calculation_params)}
            onAdded={load}
          />
        )}
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
                  <th className={cn(TH_CLASS, 'text-right', !canEditLines && 'pr-0')}>{t('th_amount')}</th>
                  {canEditLines && (
                    <th className={cn(TH_CLASS, 'pr-0 text-right')}>
                      <span className="sr-only">{t('th_actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <tr key={li.id} className={cn(canEditLines && 'group')}>
                    <td className={cn(TD_CLASS, 'pl-0 text-muted-foreground')}>
                      {LINE_ITEM_TYPE_KEYS[li.item_type] ? t(LINE_ITEM_TYPE_KEYS[li.item_type]) : li.item_type}
                    </td>
                    <td className={TD_CLASS}>{li.description}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{li.quantity ?? '-'}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums', !canEditLines && 'pr-0')}>
                      {formatCurrency(li.amount)}
                    </td>
                    {canEditLines && (
                      <td className={cn(TD_CLASS, 'pr-0 text-right')}>
                        {isRemovableLine(li) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn('-my-1 h-8 w-8 text-muted-foreground hover:text-foreground', HOVER_REVEAL_CLASS)}
                            onClick={() => handleRemoveLine(li.id)}
                            disabled={removingLineId === li.id}
                            aria-label={li.source_expense_claim_id ? t('remove_expense_claim_line_aria') : t('remove_line_aria')}
                            title={li.source_expense_claim_id ? t('remove_expense_claim_line_aria') : t('remove_line_aria')}
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
