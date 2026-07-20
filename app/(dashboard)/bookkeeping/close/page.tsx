import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ChevronLeft, ChevronRight, CheckCircle2, Lock } from 'lucide-react'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import {
  buildMonthEndReadinessReport,
  getCloseRunOperations,
} from '@/lib/close-run'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { formatDate } from '@/lib/utils'
import { CloseRunLockAction } from '@/components/close-run/CloseRunLockAction'
import type { MonthEndCheckStatus } from '@/lib/close-run'

export const dynamic = 'force-dynamic'

/** Previous calendar month relative to an ISO date (the default close target). */
function previousMonth(today: string): string {
  const [year, month] = today.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 2, 1))
  return d.toISOString().slice(0, 7)
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7)
}

const CHECK_BADGES: Record<Exclude<MonthEndCheckStatus, 'pass'>, 'destructive' | 'warning' | 'outline'> = {
  blocker: 'destructive',
  warning: 'warning',
  unknown: 'outline',
}

/**
 * Månadsavslut (the granskningskö run view, v1): month readiness checklist +
 * the run's staged operations + the staged month lock. The agent (or the
 * accountant) stages; approval happens in Granskning (/pending); the
 * executor re-verifies at commit. dev_docs/niche_factory.md §0.
 */
export default async function CloseRunPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const params = await searchParams
  const requested = params.month
  const month =
    requested && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : previousMonth(getSwedishLocalDate())

  // Run ops need the service client: pending_operations SELECT RLS is
  // per-user, but the run view must show operations staged by agents and
  // colleagues too. companyId comes from the caller's own validated
  // membership (getActiveCompanyId), which is the tenant boundary here.
  const [report, runOps, t] = await Promise.all([
    buildMonthEndReadinessReport(supabase, companyId, month),
    getCloseRunOperations(createServiceClient(), companyId, month),
    getTranslations('close_run'),
  ])

  const blockers = report.checks.filter((c) => c.status === 'blocker' || c.status === 'unknown')
  const pendingLock = runOps.find(
    (op) => op.operationType === 'set_bookkeeping_locked_through' && op.status === 'pending',
  )

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          <div className="flex items-center gap-2">
            <Link
              href={`/bookkeeping/close?month=${shiftMonth(month, -1)}`}
              aria-label={t('prev_month')}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors duration-150"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Link>
            <span className="text-sm tabular-nums min-w-[80px] text-center">{month}</span>
            <Link
              href={`/bookkeeping/close?month=${shiftMonth(month, 1)}`}
              aria-label={t('next_month')}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors duration-150"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        }
      />

      {/* Status line */}
      {report.alreadyLocked ? (
        <p className="text-sm text-muted-foreground" role="status">
          <Lock className="inline h-4 w-4 mr-2 align-[-2px]" aria-hidden />
          {t('already_locked', { date: formatDate(report.lockedThrough as string) })}
        </p>
      ) : report.ready ? (
        <p className="text-sm text-muted-foreground" role="status">
          <CheckCircle2 className="inline h-4 w-4 mr-2 align-[-2px]" aria-hidden />
          {t('ready')}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground tabular-nums" role="status">
          {t('not_ready', { count: blockers.length })}
        </p>
      )}

      {/* Readiness checklist */}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {report.checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-4 px-6 py-4">
                <div className="min-w-0">
                  <p className="text-sm">{t(`checks.${check.key}`)}</p>
                  {check.amount !== undefined && check.amount !== 0 && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t('difference', { amount: check.amount })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {check.count !== null && check.count > 0 && (
                    <span className="font-display text-base tabular-nums">{check.count}</span>
                  )}
                  {check.status === 'pass' ? (
                    <span className="text-sm text-muted-foreground">{t('status.pass')}</span>
                  ) : (
                    <Badge variant={CHECK_BADGES[check.status]}>
                      {t(`status.${check.status}`)}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Run operations */}
      {runOps.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="px-6 py-4 border-b border-border">
              <p className="text-sm font-medium">{t('run_title')}</p>
            </div>
            <ul className="divide-y divide-border">
              {runOps.map((op) => (
                <li key={op.id} className="flex items-center justify-between gap-4 px-6 py-3">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{op.title}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(op.createdAt)}
                    </p>
                  </div>
                  {op.status === 'pending' ? (
                    <Badge variant="secondary">{t('op_status.pending')}</Badge>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t(`op_status.${op.status}` as never)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Terminal action */}
      {!report.alreadyLocked && (
        <CloseRunLockAction
          month={month}
          lockDate={report.end}
          ready={report.ready}
          pendingLockStaged={Boolean(pendingLock)}
        />
      )}
    </div>
  )
}
