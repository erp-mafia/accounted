'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { EmptyState } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { HandCoins, Plus, Users } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompanySettings, useEmployees } from '@/lib/reference-data/hooks'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { agiReportingPeriod, formatAgiPeriodDashed } from '@/lib/salary/agi/reporting-period'
import {
  defaultRunPaymentDate,
  formatRunPeriod,
  runPeriodChoices,
  type RunPeriod,
  type RunPeriodChoice,
} from '@/lib/salary/next-run-period'
import type { SalaryRun } from '@/types'
import { salaryRunStatusDisplay } from '@/lib/salary/run-status-display'

/**
 * Löner landing (concept scene 22): header + the lönekörningar dry-table,
 * nothing else. The open run's row is the way into the flow (chip + payout
 * date); AGI, skatt, blockers and semester live on the run detail and the
 * employee register.
 */
export default function SalaryPage() {
  const [runs, setRuns] = useState<SalaryRun[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  // The active roster from the session cache: the start card counts it.
  const { employees, isLoading: employeesLoading } = useEmployees()
  const loading = runsLoading || employeesLoading
  // The month being created (formatRunPeriod), 'default' when the server
  // picks it; null when nothing is being started.
  const [startingKey, setStartingKey] = useState<string | null>(null)
  // The months "Starta lönekörning" offers: the default month (one click on
  // the button face) and the recent months behind its caret. Known only once
  // the run list has loaded; null means "let the server decide" and the
  // button keeps its plain label rather than naming a month it cannot know.
  const [choices, setChoices] = useState<RunPeriodChoice[] | null>(null)
  const { canWrite } = useCanWrite()
  const { settings } = useCompanySettings()
  const { toast } = useToast()
  const router = useRouter()
  const locale = useLocale() as ErrorLocale
  const t = useTranslations('salary')
  const tStart = useTranslations('start_cards')

  const load = useCallback(async () => {
    const runsRes = await fetch('/api/salary/runs').catch(() => null)
    if (runsRes?.ok) {
      const { data } = await runsRes.json()
      setRuns(data || [])
      setChoices(runPeriodChoices(data || [], new Date()))
    } else {
      setChoices(null)
    }
    setRunsLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // One-click run creation: the API seeds all active employees, calculates,
  // and resolves pay-date/series defaults from settings. The period is the one
  // the button or its menu names, sent explicitly so the click creates exactly
  // that month; null lets the server pick. A month that has a run by now
  // (someone else started it meanwhile) answers 409 and is opened instead.
  async function startRun(period: RunPeriod | null) {
    setStartingKey(period ? formatRunPeriod(period) : 'default')
    try {
      const res = await fetch('/api/salary/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          period ? { period_year: period.period_year, period_month: period.period_month } : {},
        ),
      })
      const json = await res.json().catch(() => null)
      if (res.status === 201 && json?.data?.id) {
        router.push(`/salary/runs/${json.data.id}`)
        return
      }
      // The route names the month in Swedish (SALARY_RUN_DUPLICATE_PERIOD),
      // so the refusal reads the same here as in every other surface.
      const message = getErrorMessage(json, { context: 'salary', statusCode: res.status, locale })
      const existingId = json?.error?.details?.existingId
      if (res.status === 409 && existingId) {
        toast({ title: message, description: t('run_exists_opening') })
        router.push(`/salary/runs/${existingId}`)
        return
      }
      toast({
        title: t('start_run_failed'),
        description: message,
        variant: 'destructive',
      })
    } finally {
      setStartingKey(null)
    }
  }

  const defaultChoice = choices?.find((choice) => choice.isDefault) ?? null
  // Each month says what the route will write before the click: the payment
  // date (the pay day setting in that month, the same rule the route uses)
  // and the AGI month it falls in, since the declaration follows the payout
  // month. Without a settings row the date is left out rather than guessed.
  const startOptions: SplitButtonOption[] = (choices ?? []).map((choice) => {
    const key = formatRunPeriod(choice)
    const paymentDate = settings ? defaultRunPaymentDate(choice, settings.salary_pay_day) : null
    const agiPeriod = paymentDate
      ? agiReportingPeriod({
          payment_date: paymentDate,
          period_year: choice.period_year,
          period_month: choice.period_month,
        })
      : null
    return {
      key,
      // Same YYYY-MM the new run gets in the table below and in its own title.
      label: t('start_run_for_period', { period: key }),
      icon: Plus,
      description: choice.hasRun
        ? t('start_run_choice_exists')
        : paymentDate && agiPeriod
          ? t('start_run_choice_payout', {
              date: formatDate(paymentDate),
              agi_period: formatAgiPeriodDashed(agiPeriod),
            })
          : undefined,
      disabled: choice.hasRun || (startingKey !== null && startingKey !== key),
      disabledTitle: choice.hasRun ? t('start_run_choice_exists') : undefined,
      busy: startingKey === key,
      onSelect: () => startRun(choice),
    }
  })

  const header = (
    <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
      <div className="flex items-center gap-4">
        <Link href="/salary/employees" className={QUIET_LINK_CLASS}>
          {t('employees')}
        </Link>
        {canWrite &&
          (choices ? (
            <SplitButton
              options={startOptions}
              initialModeKey={defaultChoice ? formatRunPeriod(defaultChoice) : undefined}
            />
          ) : (
            <Button size="sm" onClick={() => startRun(null)} disabled={loading} loading={startingKey !== null}>
              {startingKey === null && <Plus className="mr-2 h-4 w-4" />}
              {t('start_run')}
            </Button>
          ))}
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-8">
        {header}
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {header}

      {runs.length === 0 && employees.length === 0 ? (
        canWrite ? (
          <div className="animate-fade-in">
            <StartCard
              card="stopwatch"
              layout="side-right"
              eyebrow={tStart('salary_eyebrow_start')}
              title={tStart('salary_title')}
              body={tStart('salary_body_no_employees')}
              primary={{ label: tStart('salary_primary_add'), href: '/salary/employees?new=1' }}
            />
          </div>
        ) : (
          <EmptyState icon={Users} title={t('onboarding_title')} description={t('onboarding_description')} />
        )
      ) : (
        <div>
          {runs.length === 0 ? (
            canWrite ? (
              <div className="animate-fade-in">
                <StartCard
                  card="stopwatch"
                  layout="side-right"
                  eyebrow={tStart('salary_eyebrow_next')}
                  title={tStart('salary_title')}
                  body={tStart('salary_body_ready', { count: employees.length })}
                  primary={{ label: tStart('salary_primary_run'), onClick: () => startRun(defaultChoice) }}
                />
              </div>
            ) : (
              <EmptyState icon={HandCoins} title={t('empty_runs_title')} description={t('empty_runs_description')} />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('th_period')}</th>
                    <th className={cn(TH_CLASS, 'w-full')}>{t('th_status')}</th>
                    <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('th_employees')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('th_gross')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('th_net')}</th>
                  </tr>
                </thead>
                <tbody className="stagger-enter">
                  {runs.slice(0, 12).map(run => {
                    // PostgREST count embed: employee_count is [{ count: n }].
                    const employeeCount = (
                      run as SalaryRun & { employee_count?: { count: number }[] }
                    ).employee_count?.[0]?.count
                    const inFlight = run.status !== 'booked' && run.status !== 'corrected'
                    // The same status as the run header and the payslip page
                    // (lib/salary/run-status-display.ts): in-flight states wear
                    // the beige chip, paid and booked are muted text.
                    const statusDisplay = salaryRunStatusDisplay(run.status)
                    const statusLabel = statusDisplay ? t(statusDisplay.labelKey) : run.status
                    return (
                      <tr
                        key={run.id}
                        className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                        onClick={() => router.push(`/salary/runs/${run.id}`)}
                      >
                        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                          <Link
                            href={`/salary/runs/${run.id}`}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {formatRunPeriod(run)}
                          </Link>
                        </td>
                        {/* overflow-hidden: see #2003, nothing in this cell
                            truncates so it must clip. */}
                        <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden whitespace-nowrap')}>
                          <span className="inline-flex items-center gap-2">
                            {statusDisplay && statusDisplay.chip === null ? (
                              <span className="text-muted-foreground">{statusLabel}</span>
                            ) : (
                              <Badge variant={statusDisplay?.chip ?? 'secondary'} className="font-normal">
                                {statusLabel}
                              </Badge>
                            )}
                            {inFlight && (
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {t('run_payout_note', { date: formatDate(run.payment_date) })}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums sm:table-cell')}>
                          {employeeCount ?? ''}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                          {formatCurrency(run.total_gross)}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                          {formatCurrency(run.total_net)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
