'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { HandCoins, Loader2, Plus, Users } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { EmployeeMasked, SalaryRun } from '@/types'

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'status_draft',
  review: 'status_review',
  approved: 'status_approved',
  paid: 'status_paid',
  booked: 'status_booked',
  corrected: 'status_corrected',
}

// In-flight states all wear the quiet beige chip (concept scene 22's Utkast
// look): the payout-date note beside the chip carries the urgency, not an
// ochre border. Booked renders as muted text, corrected as the outline
// exception.
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  draft: 'secondary',
  review: 'secondary',
  approved: 'secondary',
  paid: 'success',
  booked: 'success',
  corrected: 'outline',
}

/**
 * Löner landing (concept scene 22): header + the lönekörningar dry-table,
 * nothing else. The open run's row is the way into the flow (chip + payout
 * date); AGI, skatt, blockers and semester live on the run detail and the
 * employee register.
 */
export default function SalaryPage() {
  const [runs, setRuns] = useState<SalaryRun[]>([])
  const [employees, setEmployees] = useState<EmployeeMasked[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const router = useRouter()
  const t = useTranslations('salary')
  const tStart = useTranslations('start_cards')

  const load = useCallback(async () => {
    const [runsRes, empRes] = await Promise.all([
      fetch('/api/salary/runs').catch(() => null),
      fetch('/api/salary/employees').catch(() => null),
    ])
    if (runsRes?.ok) {
      const { data } = await runsRes.json()
      setRuns(data || [])
    }
    if (empRes?.ok) {
      const { data } = await empRes.json()
      setEmployees(data || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // One-click run creation: the API seeds all active employees, calculates,
  // and resolves period/pay-date/series defaults from settings.
  async function startRun() {
    setStarting(true)
    try {
      const res = await fetch('/api/salary/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const json = await res.json().catch(() => null)
      if (res.status === 201 && json?.data?.id) {
        router.push(`/salary/runs/${json.data.id}`)
        return
      }
      const existingId = json?.error?.details?.existingId
      if (res.status === 409 && existingId) {
        toast({ title: t('run_exists_opening') })
        router.push(`/salary/runs/${existingId}`)
        return
      }
      toast({
        title: t('start_run_failed'),
        description: getErrorMessage(json, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    } finally {
      setStarting(false)
    }
  }

  const periodOf = (r: SalaryRun) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`

  const header = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
      <div className="flex items-center gap-4">
        <Link href="/salary/employees" className={QUIET_LINK_CLASS}>
          {t('employees')}
        </Link>
        {canWrite && (
          <Button onClick={startRun} disabled={starting || loading}>
            {starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            {t('start_run')}
          </Button>
        )}
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
              primary={{ label: tStart('salary_primary_add'), href: '/salary/employees/new' }}
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
                  primary={{ label: tStart('salary_primary_run'), onClick: startRun }}
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
                            {periodOf(run)}
                          </Link>
                        </td>
                        {/* overflow-hidden: see #2003, nothing in this cell
                            truncates so it must clip. */}
                        <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden whitespace-nowrap')}>
                          <span className="inline-flex items-center gap-2">
                            {run.status === 'booked' ? (
                              <span className="text-muted-foreground">{t('status_booked')}</span>
                            ) : (
                              <Badge variant={STATUS_VARIANTS[run.status] || 'secondary'} className="font-normal">
                                {STATUS_LABEL_KEYS[run.status] ? t(STATUS_LABEL_KEYS[run.status]) : run.status}
                              </Badge>
                            )}
                            {inFlight && (
                              <span className="text-[11.5px] text-muted-foreground tabular-nums">
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
