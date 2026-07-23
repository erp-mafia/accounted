'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ArrowRight, CalendarClock, CheckCircle2, HandCoins, Loader2, Plus, UserX, Users } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { VacationBalanceCard } from '@/components/salary/VacationBalanceCard'
import { useAgiSubmission } from '@/lib/hooks/use-agi-submission'
import { deriveAgiFilingState } from '@/lib/salary/agi-submission-state'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { Employee, SalaryRun } from '@/types'

const supabase = createClient()

const STATUS_LABEL_KEYS: Record<string, string> = {
  draft: 'status_draft',
  review: 'status_review',
  approved: 'status_approved',
  paid: 'status_paid',
  booked: 'status_booked',
  corrected: 'status_corrected',
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  draft: 'secondary',
  review: 'warning',
  approved: 'default',
  paid: 'success',
  booked: 'success',
  corrected: 'outline',
}

interface TaxPaymentState {
  tax_payment_file_generated_at: string | null
  tax_paid_at: string | null
}

export default function SalaryPage() {
  const [runs, setRuns] = useState<SalaryRun[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [payDay, setPayDay] = useState(25)
  const [agiDeadline, setAgiDeadline] = useState<{ due_date: string; title: string } | null>(null)
  const [taxPayment, setTaxPayment] = useState<TaxPaymentState | null>(null)
  // The Skatteverket connection previously worked but now needs re-consent:
  // the skattekonto sync (which auto-settles the tax card) is paused.
  const [skvNeedsReconsent, setSkvNeedsReconsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [markingPaid, setMarkingPaid] = useState(false)
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const { toast } = useToast()
  const router = useRouter()
  const t = useTranslations('salary')
  const tp = useTranslations('salary_payments')

  const load = useCallback(async () => {
    // Everything loads in parallel; the tax-payment fetch is the only
    // dependent request and chains directly off the runs response instead of
    // waiting for the whole batch. Was three sequential legs (batch → tax
    // payment → SKV status), now the longest chain is runs → tax payment.
    const runsPromise: Promise<SalaryRun[]> = fetch('/api/salary/runs')
      .then(async res => (res.ok ? (await res.json()).data || [] : []))
      .catch(() => [])

    // Latest booked run drives the "skatt att betala" card. Resolves to
    // undefined ("leave state unchanged") when there is no booked run or the
    // fetch fails, mirroring the old sequential behavior on reloads.
    const taxPaymentPromise: Promise<TaxPaymentState | null | undefined> = runsPromise
      .then(async loadedRuns => {
        const latestBooked = loadedRuns.find(r => r.status === 'booked')
        if (!latestBooked) return undefined
        const period = `${latestBooked.period_year}-${String(latestBooked.period_month).padStart(2, '0')}`
        const txRes = await fetch(`/api/skatteverket/tax-payments/${period}`)
        if (!txRes.ok) return undefined
        return (await txRes.json()).data ?? null
      })
      .catch(() => undefined)

    const [loadedRuns, taxPaymentData, empRes, settingsRes, skvStatus] = await Promise.all([
      runsPromise,
      taxPaymentPromise,
      fetch('/api/salary/employees').catch(() => null),
      fetch('/api/settings').catch(() => null),
      // Connection health for the tax card hint. Only needs_reconsent counts:
      // the routine short-lived token expiry is normal and must not nag. Any
      // failure (extension disabled → 503, network) silently means no hint.
      fetch('/api/extensions/ext/skatteverket/status')
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null),
    ])

    setRuns(loadedRuns)
    if (taxPaymentData !== undefined) setTaxPayment(taxPaymentData)
    if (empRes?.ok) {
      const { data } = await empRes.json()
      setEmployees(data || [])
    }
    if (settingsRes?.ok) {
      const { data } = await settingsRes.json()
      if (typeof data?.salary_pay_day === 'number') setPayDay(data.salary_pay_day)
    }
    if (skvStatus) setSkvNeedsReconsent(skvStatus.needsReconsent === true)

    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Reload after an in-page Skatteverket reconnect. The raw postMessage from
  // the BankID popup is only trusted by the component that opened and
  // source-verified the popup (SkatteverketConnectPanel / AGIPanel); this
  // page never opens the popup itself, so it consumes the verified rebroadcast
  // instead. The OAuth callback awaits the skattekonto sync + AGI
  // auto-settlement before responding, so this refetch already sees fresh
  // tax-payment state instead of racing a background job.
  useEffect(() => {
    function handleConnectionUpdated() {
      load()
    }
    window.addEventListener('skatteverket-connection-updated', handleConnectionUpdated)
    return () =>
      window.removeEventListener('skatteverket-connection-updated', handleConnectionUpdated)
  }, [load])

  // Next open AGI deadline instance - generated by the tax-deadline engine
  // when the company pays salaries; same source as the /deadlines page.
  useEffect(() => {
    if (!company) return
    const today = new Date().toISOString().split('T')[0]
    supabase
      .from('deadlines')
      .select('due_date, title')
      .eq('company_id', company.id)
      .eq('tax_deadline_type', 'arbetsgivardeklaration')
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .gte('due_date', today)
      .order('due_date')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setAgiDeadline(data ?? null))
  }, [company])

  // The active run's AGI submission record: lets the hero distinguish
  // "lämna in till Skatteverket" from "väntar på din BankID-signatur".
  // Only fetched while a booked run is still unfiled; null otherwise.
  const activeRun = runs.find(r => r.status !== 'corrected')
  const { submission: agiSubmission } = useAgiSubmission(
    activeRun && activeRun.status === 'booked' && !activeRun.agi_submitted_at
      ? `${activeRun.period_year}${String(activeRun.period_month).padStart(2, '0')}`
      : null,
  )

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

  // Inline mark-paid on the tax card: same endpoint as TaxPaymentPanel on the
  // run detail page, for users who paid Skatteverket outside the app.
  async function markTaxPaid(period: string) {
    setMarkingPaid(true)
    try {
      const res = await fetch(`/api/skatteverket/tax-payments/${period}/mark-paid`, {
        method: 'POST',
      })
      if (!res.ok) {
        const result = await res.json().catch(() => null)
        toast({
          title: tp('tax_mark_paid_failed_title'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: tp('tax_marked_paid') })
      const txRes = await fetch(`/api/skatteverket/tax-payments/${period}`)
      if (txRes.ok) {
        const tx = await txRes.json()
        setTaxPayment(tx.data)
      }
    } finally {
      setMarkingPaid(false)
    }
  }

  if (loading) {
    // Real header renders immediately; only the data surfaces are skeletons.
    return (
      <div className="space-y-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
          <div className="flex items-center gap-4">
            <Link href="/salary/employees" className={QUIET_LINK_CLASS}>
              {t('employees')}
            </Link>
            {canWrite && (
              <Button disabled>
                <Plus className="mr-2 h-4 w-4" />
                {t('start_run')}
              </Button>
            )}
          </div>
        </div>
        <Skeleton className="h-28 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  // ── Hero state machine (first match wins) ────────────────────────────────
  // activeRun is derived above the loading return (the AGI submission hook
  // needs it before any early return).
  const latestBooked = runs.find(r => r.status === 'booked')
  const periodOf = (r: SalaryRun) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`

  // Next period for the quiet state: month after the latest non-corrected run.
  const nextPeriod = (() => {
    if (!activeRun) {
      const now = new Date()
      return { year: now.getFullYear(), month: now.getMonth() + 1 }
    }
    return activeRun.period_month === 12
      ? { year: activeRun.period_year + 1, month: 1 }
      : { year: activeRun.period_year, month: activeRun.period_month + 1 }
  })()
  const nextPayDate = `${nextPeriod.year}-${String(nextPeriod.month).padStart(2, '0')}-${String(payDay).padStart(2, '0')}`

  type Hero =
    | { kind: 'onboarding' }
    | { kind: 'cta'; title: string; description: string; label: string; runId: string }
    | { kind: 'quiet' }

  const hero: Hero = (() => {
    if (runs.length === 0 && employees.length === 0) return { kind: 'onboarding' }
    if (activeRun && (activeRun.status === 'draft' || activeRun.status === 'review')) {
      return {
        kind: 'cta',
        title: t('hero_review_title', { period: periodOf(activeRun) }),
        description: t('hero_review_description', {
          count: (activeRun as SalaryRun & { employees?: unknown[] }).employees?.length ?? employees.length,
          net: formatCurrency(activeRun.total_net),
          date: formatDate(activeRun.payment_date),
        }),
        label: t('hero_review_action'),
        runId: activeRun.id,
      }
    }
    if (activeRun && activeRun.status === 'approved') {
      // A run that pays out nothing (nollkörning, or fully net-deducted) has no
      // payment file to download - don't send the user to "pay". The real next
      // step is to post it and file AGI, so shepherd them into the run instead.
      const noPayout = Math.round((activeRun.total_net ?? 0) * 100) === 0
      if (noPayout) {
        return {
          kind: 'cta',
          title: t('hero_finish_title', { period: periodOf(activeRun) }),
          description: t('hero_finish_description'),
          label: t('hero_finish_action'),
          runId: activeRun.id,
        }
      }
      return {
        kind: 'cta',
        title: t('hero_pay_title', { period: periodOf(activeRun) }),
        description: t('hero_pay_description', {
          net: formatCurrency(activeRun.total_net),
          date: formatDate(activeRun.payment_date),
        }),
        label: t('hero_pay_action'),
        runId: activeRun.id,
      }
    }
    if (activeRun && activeRun.status === 'paid') {
      return {
        kind: 'cta',
        title: t('hero_book_title', { period: periodOf(activeRun) }),
        description: t('hero_book_description'),
        label: t('hero_book_action'),
        runId: activeRun.id,
      }
    }
    if (activeRun && activeRun.status === 'booked' && !activeRun.agi_submitted_at) {
      // The underlag may already be at Skatteverket waiting for a BankID
      // signature: telling the user to "lämna in" something they already
      // submitted reads as a broken flow. Follow the real filing state.
      const agiState = deriveAgiFilingState(activeRun, agiSubmission)
      if (agiState === 'awaiting_signing' || agiState === 'underlag_submitted') {
        return {
          kind: 'cta',
          title: t('hero_agi_signing_title', { period: periodOf(activeRun) }),
          description: t('hero_agi_signing_description'),
          label: t('hero_agi_signing_action'),
          runId: activeRun.id,
        }
      }
      return {
        kind: 'cta',
        title: t('hero_agi_title', { period: periodOf(activeRun) }),
        description: t('hero_agi_description'),
        label: t('hero_agi_action'),
        runId: activeRun.id,
      }
    }
    return { kind: 'quiet' }
  })()

  // ── Blockers: active employees missing what a run needs ──────────────────
  const missingBank = employees.filter(e => !e.clearing_number || !e.bank_account_number).length
  const missingEmail = employees.filter(e => !e.email).length
  const blockerCount = missingBank + missingEmail

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 22): quiet Anställda link + primary */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex items-center gap-4">
          <Link href="/salary/employees" className={QUIET_LINK_CLASS}>
            {t('employees')}
          </Link>
          {canWrite && (
            <Button onClick={startRun} disabled={starting}>
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

      {/* Hero - the one thing to do now */}
      {hero.kind === 'onboarding' ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Users}
              title={t('onboarding_title')}
              description={t('onboarding_description')}
              actionLabel={canWrite ? t('onboarding_action') : undefined}
              actionHref={canWrite ? '/salary/employees/new' : undefined}
            />
          </CardContent>
        </Card>
      ) : hero.kind === 'cta' ? (
        /* The one thing to do now, flat on the page (concept: no card chrome) */
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-xl tracking-tight">{hero.title}</h2>
            <p className="text-sm text-muted-foreground">{hero.description}</p>
          </div>
          <Button asChild className="shrink-0">
            <Link href={`/salary/runs/${hero.runId}`}>
              {hero.label}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-xl tracking-tight">
              {t('quiet_title', {
                period: `${nextPeriod.year}-${String(nextPeriod.month).padStart(2, '0')}`,
              })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('quiet_description', { date: formatDate(nextPayDate) })}
            </p>
          </div>
          {canWrite && (
            <Button variant="outline" onClick={startRun} disabled={starting} className="shrink-0">
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('quiet_action')}
            </Button>
          )}
        </div>
      )}

      {/* Attention cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t('card_agi_title')}</p>
            </div>
            {agiDeadline ? (
              <>
                <p className="font-sans text-lg font-medium tabular-nums leading-tight">
                  {formatDate(agiDeadline.due_date)}
                </p>
                <Link
                  href="/deadlines"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  {agiDeadline.title}
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('card_agi_none')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <HandCoins className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t('card_tax_title')}</p>
            </div>
            {latestBooked ? (
              <>
                <p className="font-sans text-lg font-medium tabular-nums leading-tight">
                  {formatCurrency(latestBooked.total_tax + latestBooked.total_avgifter)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {taxPayment?.tax_paid_at
                    ? t('card_tax_paid', { date: formatDate(taxPayment.tax_paid_at) })
                    : t('card_tax_unpaid', { period: periodOf(latestBooked) })}
                </p>
                {!taxPayment?.tax_paid_at && skvNeedsReconsent && (
                  <Link
                    href="/settings/tax"
                    className="mt-1 block text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    {t('card_tax_reconnect')}
                  </Link>
                )}
                {!taxPayment?.tax_paid_at && canWrite && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => markTaxPaid(periodOf(latestBooked))}
                    disabled={markingPaid}
                  >
                    {markingPaid ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                    )}
                    {tp('tax_mark_paid_button')}
                  </Button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('card_tax_none')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <UserX className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t('card_blockers_title')}</p>
            </div>
            {blockerCount > 0 ? (
              <>
                <p className="font-sans text-lg font-medium tabular-nums leading-tight">
                  {blockerCount}
                </p>
                <Link
                  href="/salary/employees"
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  {t('card_blockers_detail', { bank: missingBank, email: missingEmail })}
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('card_blockers_none')}</p>
            )}
          </CardContent>
        </Card>

        {/* Semester (vacation ledger + year close): payroll gap-closure 3.5 */}
        <VacationBalanceCard canWrite={canWrite} />
      </div>

      {/* Lönekörningar (concept scene 22): eyebrow + dry-table. Booked
          runs are the normal state and read as muted text; everything
          mid-flow gets a chip plus the payout date. */}
      <div>
        <h2 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
          {t('runs_title')}
        </h2>
        {runs.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title={t('empty_runs_title')}
            description={t('empty_runs_description')}
            actionLabel={canWrite ? t('start_run') : undefined}
            onAction={canWrite ? startRun : undefined}
          />
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
                  const employeeCount = (run as SalaryRun & { employees?: unknown[] }).employees?.length
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
                      <td className={cn(TD_CLASS, 'max-w-0 w-full whitespace-nowrap')}>
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
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums sensitive-field')}>
                        {formatCurrency(run.total_gross)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums sensitive-field')}>
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
    </div>
  )
}
