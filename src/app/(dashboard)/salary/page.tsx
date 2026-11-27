'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { PageHeaderActions } from '@/components/ui/page-header-actions'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { BanknotesIcon, PlusIcon, UsersIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompanySettings, useEmployees } from '@/lib/reference-data/hooks'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
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

/** Runs the landing lists before the "Visa alla" line: a year of months. */
const RUNS_SHOWN = 12

/**
 * Löner landing (concept scene 22): header + the lönekörningar dry-table,
 * nothing else. The open run's row is the way into the flow (chip + payout
 * date); AGI, skatt, blockers and semester live on the run detail and the
 * employee register.
 */
export default function SalaryPage() {
  const [runs, setRuns] = useState<SalaryRun[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  // The run list could not be read: the page says so in place of the list
  // instead of drawing the first-run start card over runs it never saw.
  const [runsFailed, setRunsFailed] = useState(false)
  // The list loads every run; past RUNS_SHOWN the rest wait behind one line.
  const [showAllRuns, setShowAllRuns] = useState(false)
  // The active roster from the session cache: the start card counts it.
  const { employees, isLoading: employeesLoading, error: employeesError, refresh: retryEmployees } = useEmployees()
  const loading = runsLoading || employeesLoading
  // The month being created (formatRunPeriod), 'default' when the server
  // picks it; null when nothing is being started.
  const [startingKey, setStartingKey] = useState<string | null>(null)
  // The months "Starta lönekörning" offers: the default month (one click on
  // the button face) and the recent months behind its caret. Known only once
  // the run list has loaded; null means "let the server decide" and the
  // button keeps its plain label rather than naming a month it cannot know.
  const [choices, setChoices] = useState<RunPeriodChoice[] | null>(null)
  // Whether a month with a run may get an extra run (several runs in one
  // month, SALARY_EXTRA_RUNS_COMPANY_IDS): the run list says so.
  const [extraRuns, setExtraRuns] = useState(false)
  const { canWrite } = useCanWrite()
  const { settings } = useCompanySettings()
  const { toast } = useToast()
  const router = useRouter()
  const locale = useLocale() as ErrorLocale
  const t = useTranslations('salary')
  const tStart = useTranslations('start_cards')
  // The top bar says what the menu row says (design.md convention 2).
  const tNav = useTranslations('nav')

  const load = useCallback(async () => {
    const runsRes = await fetch('/api/salary/runs').catch(() => null)
    if (runsRes?.ok) {
      const { data, extra_runs: extraRunsOn } = await runsRes.json()
      setRuns(data || [])
      setExtraRuns(extraRunsOn === true)
      setChoices(runPeriodChoices(data || [], new Date()))
      setRunsFailed(false)
    } else {
      setChoices(null)
      setRunsFailed(true)
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
  async function startRun(period: RunPeriod | null, extraRun = false) {
    setStartingKey(period ? formatRunPeriod(period) : 'default')
    try {
      const res = await fetch('/api/salary/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          period
            ? {
                period_year: period.period_year,
                period_month: period.period_month,
                ...(extraRun ? { extra_run: true } : {}),
              }
            : {},
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
    } catch (err) {
      // A network failure used to end in silence: the button just stopped.
      toast({
        title: t('start_run_failed'),
        description: getErrorMessage(err, { context: 'salary', locale }),
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
    // A month with a run gets an extra run where the company has several
    // runs in one month: for the employees no other run of it pays.
    const extra = choice.hasRun && extraRuns
    return {
      key,
      // Same YYYY-MM the new run gets in the table below and in its own title.
      label: extra ? t('start_extra_run_for_period', { period: key }) : t('start_run_for_period', { period: key }),
      icon: PlusIcon,
      description: extra
        ? t('start_extra_run_choice')
        : choice.hasRun
          ? t('start_run_choice_exists')
          : paymentDate && agiPeriod
            ? t('start_run_choice_payout', {
                date: formatDate(paymentDate),
                agi_period: formatAgiPeriodDashed(agiPeriod),
              })
            : undefined,
      disabled: (choice.hasRun && !extra) || (startingKey !== null && startingKey !== key),
      disabledTitle: choice.hasRun && !extra ? t('start_run_choice_exists') : undefined,
      busy: startingKey === key,
      onSelect: () => startRun(choice, extra),
    }
  })

  // First time: no run and nobody to pay. The start card below leads with
  // adding an employee, and the top bar does not offer a run that would be
  // created empty. A roster that could not be read is not "nobody".
  const firstTime = !loading && !runsFailed && !employeesError && runs.length === 0 && employees.length === 0

  const header = (
    <div className="page-header page-header-wrap flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="page-header-title">{tNav('v2_salary_runs')}</h1>
      <PageHeaderActions className="flex items-center gap-4">
        <Link href="/salary/employees" className={QUIET_LINK_CLASS}>
          {t('employees')}
        </Link>
        {canWrite &&
          !firstTime &&
          (choices ? (
            <SplitButton
              options={startOptions}
              initialModeKey={defaultChoice ? formatRunPeriod(defaultChoice) : undefined}
            />
          ) : (
            <Button size="toolbar" onClick={() => startRun(null)} disabled={loading} loading={startingKey !== null}>
              {startingKey === null && <PlusIcon className="h-4 w-4" />}
              {t('start_run')}
            </Button>
          ))}
      </PageHeaderActions>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-8">
        {header}
        <LateReveal>
          {[1, 2, 3].map(i => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="ml-auto h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </LateReveal>
      </div>
    )
  }

  if (runsFailed && runs.length === 0) {
    return (
      <div className="space-y-8">
        {header}
        <LoadError
          title={t('runs_load_failed')}
          onRetry={() => {
            setRunsLoading(true)
            void load()
          }}
        />
      </div>
    )
  }

  // No runs and a roster that could not be read: unknown, not "nobody to
  // pay", so no start card that asks for a first employee.
  if (employeesError && employees.length === 0 && runs.length === 0) {
    return (
      <div className="space-y-8">
        {header}
        <LoadError title={t('employees_load_failed')} onRetry={() => void retryEmployees()} />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {header}

      {firstTime || (runs.length === 0 && employees.length === 0) ? (
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
          <EmptyState icon={UsersIcon} title={t('onboarding_title')} description={t('onboarding_description')} />
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
              <EmptyState icon={BanknotesIcon} title={t('empty_runs_title')} description={t('empty_runs_description')} />
            )
          ) : (
            <div className="-mx-2 overflow-x-auto">
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
                  {(showAllRuns ? runs : runs.slice(0, RUNS_SHOWN)).map(run => {
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
                            {(run.run_number ?? 1) > 1
                              ? t('run_period_extra', { period: formatRunPeriod(run), number: run.run_number ?? 1 })
                              : formatRunPeriod(run)}
                          </Link>
                        </td>
                        {/* overflow-hidden: see #2003, nothing in this cell
                            truncates so it must clip. */}
                        <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden whitespace-nowrap date-figures')}>
                          <span className="inline-flex items-center gap-2">
                            {statusDisplay && statusDisplay.chip === null ? (
                              <span className="text-muted-foreground">{statusLabel}</span>
                            ) : (
                              <Badge variant={statusDisplay?.chip ?? 'secondary'} className="font-normal">
                                {statusLabel}
                              </Badge>
                            )}
                            {inFlight && (
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {t('run_payout_note', { date: formatDate(run.payment_date) })}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums sm:table-cell')}>
                          {employeeCount ?? ''}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                          {formatRowAmount(run.total_gross)}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                          {formatRowAmount(run.total_net)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!showAllRuns && runs.length > RUNS_SHOWN && (
                <button
                  type="button"
                  onClick={() => setShowAllRuns(true)}
                  className="px-4 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  {t('show_all_runs', { count: runs.length })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
