'use client'

// Periodiseringar: running accrual schedules (förutbetalda kostnader 17xx,
// upplupna kostnader 29xx / förutbetalda intäkter 29xx, upplupna intäkter
// 17xx) created from
// invoice lines. Not on the stays-Swedish list (.claude/rules/i18n.md), so
// the chrome reads the `periodiseringar` namespace; account numbers and
// server error texts pass through as they are.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { CalendarDaysIcon } from '@/components/icons'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, RowFoldout } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { AccrualReplanDialog, canReplanSchedule } from '@/components/bookkeeping/AccrualReplanDialog'
import type {
  AccrualSchedule,
  AccrualScheduleInstallment,
  AccrualScheduleStatus,
} from '@/types'

type ScheduleWithInstallments = AccrualSchedule & {
  installments: AccrualScheduleInstallment[]
}

type StatusFilter = 'active' | 'completed' | 'all'

// Chips mark exceptions (design.md): Aktiv/Avslutad are normal states and
// render as muted text; only Makulerad deviates.
const SCHEDULE_STATUS_KEY: Record<AccrualScheduleStatus, 'status_active' | 'status_completed' | 'status_cancelled'> = {
  active: 'status_active',
  completed: 'status_completed',
  cancelled: 'status_cancelled',
}

function monthLabel(periodMonth: string): string {
  return periodMonth.slice(0, 7)
}

function sumPosted(installments: AccrualScheduleInstallment[]): number {
  return (
    Math.round(
      installments
        .filter((i) => i.status === 'posted')
        .reduce((sum, i) => sum + i.amount, 0) * 100,
    ) / 100
  )
}

export default function AccrualSchedulesPage() {
  const t = useTranslations('periodiseringar')
  const tNav = useTranslations('nav')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const tAccruals = useTranslations('accruals')

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [schedules, setSchedules] = useState<ScheduleWithInstallments[]>([])
  const [dueCount, setDueCount] = useState(0)
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isPosting, setIsPosting] = useState(false)
  const [postConfirmOpen, setPostConfirmOpen] = useState(false)
  const [dissolveTarget, setDissolveTarget] = useState<ScheduleWithInstallments | null>(null)
  const [replanTarget, setReplanTarget] = useState<ScheduleWithInstallments | null>(null)

  const fetchSchedules = useCallback(async (filter: StatusFilter) => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/bookkeeping/accruals?status=${filter}`)
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry', locale }))
      setSchedules(json.data ?? [])
      setDueCount(json.due_count ?? 0)
      if (filter === 'active') setActiveCount((json.data ?? []).length)
    } catch (error) {
      toast({
        title: t('load_failed'),
        description: getErrorMessage(error, { context: 'journal_entry', locale }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t, locale])

  useEffect(() => {
    fetchSchedules(statusFilter)
  }, [statusFilter, fetchSchedules])

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handlePostDue() {
    setIsPosting(true)
    try {
      const res = await fetch('/api/bookkeeping/accruals/post-due', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry', locale }))
      const result = json.data as { posted: number; failed: number }
      toast({
        title: result.failed > 0 ? t('post_partial_title') : t('post_done_title'),
        description:
          result.failed > 0
            ? t('post_partial_description', { posted: result.posted, failed: result.failed })
            : t('post_done_description', { posted: result.posted }),
        variant: result.failed > 0 ? 'destructive' : undefined,
      })
      await fetchSchedules(statusFilter)
    } catch (error) {
      toast({
        title: t('post_failed_title'),
        description: getErrorMessage(error, { context: 'journal_entry', locale }),
        variant: 'destructive',
      })
    } finally {
      setIsPosting(false)
    }
  }

  async function handleDissolve() {
    if (!dissolveTarget) return
    try {
      const res = await fetch(`/api/bookkeeping/accruals/${dissolveTarget.id}/dissolve`, {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry', locale }))
      toast({
        title: t('dissolve_done_title'),
        description: t('dissolve_done_description', { amount: formatCurrency(json.data.amount) }),
      })
      setDissolveTarget(null)
      await fetchSchedules(statusFilter)
    } catch (error) {
      toast({
        title: t('dissolve_failed_title'),
        description: getErrorMessage(error, { context: 'journal_entry', locale }),
        variant: 'destructive',
      })
    }
  }

  const blockedInstallments = useMemo(
    () =>
      schedules.reduce(
        (count, schedule) =>
          count +
          schedule.installments.filter((i) => i.status === 'pending' && i.last_error).length,
        0,
      ),
    [schedules],
  )

  const dissolveRemaining = dissolveTarget
    ? roundOre(dissolveTarget.total_amount - sumPosted(dissolveTarget.installments))
    : 0

  return (
    <div className="space-y-8">
      <PageHeader
        title={tNav('periodiseringar')}
        help={
          <HelpPopover>
            <p>{t('help')}</p>
          </HelpPopover>
        }
      />

      {dueCount > 0 ? (
        <AttnLine
          action={
            canWrite
              ? {
                  label: isPosting ? t('posting') : t('post_due'),
                  onClick: () => {
                    if (!isPosting) setPostConfirmOpen(true)
                  },
                }
              : undefined
          }
        >
          {t('due_months', { count: dueCount })} {t('due_nightly')}
        </AttnLine>
      ) : blockedInstallments > 0 ? (
        <AttnLine>
          {t('blocked_months', { count: blockedInstallments })}
        </AttnLine>
      ) : null}

      {/* Toolbar: status seg (concept scene 33) */}
      <SegmentedControl
        value={statusFilter}
        onChange={setStatusFilter}
        options={[
          { value: 'active', label: t('filter_active'), count: activeCount ?? undefined },
          { value: 'completed', label: t('filter_completed') },
          { value: 'all', label: t('filter_all') },
        ]}
      />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarDaysIcon}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      ) : (
        <>
          <div className="overflow-x-auto" role="region" aria-label={tNav('periodiseringar')}>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_description')}</th>
                  <th className={TH_CLASS}>{t('col_account')}</th>
                  <th className={TH_CLASS}>{t('col_period')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_total')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_remaining')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                  <th className={cn(TH_CLASS, 'w-56')} />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {schedules.map((schedule) => {
                  const dissolved = sumPosted(schedule.installments)
                  const remaining =
                    schedule.status === 'cancelled'
                      ? 0
                      : roundOre(schedule.total_amount - dissolved)
                  const isOpen = expanded.has(schedule.id)
                  const sourceHref = schedule.supplier_invoice_id
                    ? `/supplier-invoices/${schedule.supplier_invoice_id}`
                    : schedule.invoice_id
                      ? `/invoices/${schedule.invoice_id}`
                      : null
                  return (
                    <Fragment key={schedule.id}>
                      <tr
                        className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                        onClick={() => toggleExpanded(schedule.id)}
                      >
                        {/* One line per row (convention 4): the source
                            invoice link lives in the foldout below. */}
                        <td className={cn(TD_CLASS, 'max-w-[320px]')}>
                          <span className="block truncate" title={schedule.description ?? ''}>
                            {schedule.description || '-'}
                          </span>
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                          {schedule.balance_account} → {schedule.target_account}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                          {t('period_range', {
                            from: formatDate(schedule.period_start),
                            to: formatDate(schedule.period_end),
                          })}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                          {formatCurrency(schedule.total_amount)}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                          {formatCurrency(remaining)}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                          {schedule.status === 'cancelled' ? (
                            <Badge variant="outline" className="font-normal">
                              {t(SCHEDULE_STATUS_KEY.cancelled)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t(SCHEDULE_STATUS_KEY[schedule.status])}
                            </span>
                          )}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                          {canWrite && canReplanSchedule(schedule) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setReplanTarget(schedule)
                              }}
                              className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, 'mr-4')}
                            >
                              {tAccruals('replan_action')}
                            </button>
                          )}
                          {canWrite && schedule.status === 'active' && remaining > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setDissolveTarget(schedule)
                              }}
                              className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                            >
                              {t('dissolve_now')}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr data-no-stagger className="hover:bg-transparent">
                          <td colSpan={7} className="border-b border-border bg-muted/30 p-0">
                            <RowFoldout>
                              <div className="space-y-3 px-6 py-4">
                                {sourceHref && (
                                  <Link href={sourceHref} className={QUIET_LINK_CLASS}>
                                    {schedule.supplier_invoice_id
                                      ? t('source_supplier_invoice')
                                      : t('source_customer_invoice')}
                                  </Link>
                                )}
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                      <th className="pb-2">{t('col_month')}</th>
                                      <th className="pb-2 text-right">{t('col_amount')}</th>
                                      <th className="pb-2 pl-6">{t('col_status')}</th>
                                      <th className="pb-2 pl-6">{t('col_voucher')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {schedule.installments.map((installment) => (
                                      <tr key={installment.id} className="border-t border-border">
                                        <td className="py-1.5 tabular-nums">
                                          {monthLabel(installment.period_month)}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {formatCurrency(installment.amount)}
                                        </td>
                                        <td className="py-1.5 pl-6">
                                          {installment.status === 'posted' ? (
                                            <span className="text-xs text-muted-foreground">{t('installment_posted')}</span>
                                          ) : installment.status === 'cancelled' ? (
                                            <Badge variant="outline" className="font-normal">{t('status_cancelled')}</Badge>
                                          ) : installment.last_error ? (
                                            <span className="inline-flex items-center gap-1.5">
                                              <Badge variant="destructive" className="font-normal">{t('installment_error')}</Badge>
                                              <span className="text-xs text-muted-foreground">
                                                {installment.last_error}
                                              </span>
                                            </span>
                                          ) : (
                                            <span className="text-xs text-muted-foreground">{t('installment_pending')}</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pl-6">
                                          {installment.journal_entry_id ? (
                                            <Link
                                              href={`/bookkeeping/${installment.journal_entry_id}`}
                                              className="text-xs underline-offset-2 hover:underline"
                                            >
                                              {t('open_voucher')}
                                            </Link>
                                          ) : (
                                            <span className="text-xs text-muted-foreground">-</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </RowFoldout>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <AccrualReplanDialog
        schedule={replanTarget}
        onOpenChange={(open) => !open && setReplanTarget(null)}
        onReplanned={() => {
          setReplanTarget(null)
          void fetchSchedules(statusFilter)
        }}
      />

      <ConfirmDialog
        open={postConfirmOpen}
        onOpenChange={setPostConfirmOpen}
        title={t('post_confirm_title')}
        description={t('post_confirm_description', { count: dueCount })}
        confirmLabel={t('post_confirm')}
        onConfirm={handlePostDue}
      />

      <ConfirmDialog
        open={dissolveTarget !== null}
        onOpenChange={(open) => !open && setDissolveTarget(null)}
        title={t('dissolve_confirm_title')}
        description={
          dissolveTarget
            ? t('dissolve_confirm_description', { amount: formatCurrency(dissolveRemaining) })
            : undefined
        }
        confirmLabel={t('dissolve_now')}
        onConfirm={handleDissolve}
      >
        {dissolveTarget && (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{dissolveTarget.description || t('fallback_description')}</p>
            <p className="tabular-nums text-muted-foreground">
              {dissolveTarget.target_account} ← {dissolveTarget.balance_account} ·{' '}
              {t('period_range', {
                from: formatDate(dissolveTarget.period_start),
                to: formatDate(dissolveTarget.period_end),
              })}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
