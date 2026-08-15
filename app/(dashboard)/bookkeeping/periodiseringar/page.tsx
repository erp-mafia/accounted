'use client'

// Periodiseringar: löpande accrual schedules (förutbetalda kostnader 17xx /
// förutbetalda intäkter 29xx) skapade från fakturarader. Djupt regulatorisk
// bokföringsyta → svenska i båda locales, i linje med bokslutsguiden.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, RowFoldout } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { getErrorMessage } from '@/lib/errors/get-error-message'
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
const SCHEDULE_STATUS_TEXT: Record<AccrualScheduleStatus, string> = {
  active: 'Aktiv',
  completed: 'Avslutad',
  cancelled: 'Makulerad',
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
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [schedules, setSchedules] = useState<ScheduleWithInstallments[]>([])
  const [dueCount, setDueCount] = useState(0)
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isPosting, setIsPosting] = useState(false)
  const [postConfirmOpen, setPostConfirmOpen] = useState(false)
  const [dissolveTarget, setDissolveTarget] = useState<ScheduleWithInstallments | null>(null)

  const fetchSchedules = useCallback(async (filter: StatusFilter) => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/bookkeeping/accruals?status=${filter}`)
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry' }))
      setSchedules(json.data ?? [])
      setDueCount(json.due_count ?? 0)
      if (filter === 'active') setActiveCount((json.data ?? []).length)
    } catch (error) {
      toast({
        title: 'Kunde inte ladda periodiseringar',
        description: getErrorMessage(error, { context: 'journal_entry' }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

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
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry' }))
      const result = json.data as { posted: number; failed: number }
      toast({
        title:
          result.failed > 0
            ? 'Periodiseringar bokförda med fel'
            : 'Periodiseringar bokförda',
        description:
          result.failed > 0
            ? `${result.posted} verifikat bokfördes, ${result.failed} misslyckades: se felmeddelandet på respektive månad.`
            : `${result.posted} verifikat bokfördes.`,
        variant: result.failed > 0 ? 'destructive' : undefined,
      })
      await fetchSchedules(statusFilter)
    } catch (error) {
      toast({
        title: 'Bokföringen misslyckades',
        description: getErrorMessage(error, { context: 'journal_entry' }),
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
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry' }))
      toast({
        title: 'Periodiseringen upplöst',
        description: `Återstående ${formatCurrency(json.data.amount)} bokfördes i ett verifikat.`,
      })
      setDissolveTarget(null)
      await fetchSchedules(statusFilter)
    } catch (error) {
      toast({
        title: 'Upplösningen misslyckades',
        description: getErrorMessage(error, { context: 'journal_entry' }),
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
        title="Periodiseringar"
        help={
          <HelpPopover>
            <p>
              Periodisera en fakturarad när du registrerar en leverantörsfaktura eller
              skapar en kundfaktura, så fördelas beloppet över månaderna här. Månadens
              andel bokförs automatiskt den sista dagen i varje månad.
            </p>
          </HelpPopover>
        }
      />

      {dueCount > 0 ? (
        <AttnLine
          action={
            canWrite
              ? {
                  label: isPosting ? 'Bokför…' : 'Bokför förfallna',
                  onClick: () => {
                    if (!isPosting) setPostConfirmOpen(true)
                  },
                }
              : undefined
          }
        >
          {dueCount === 1
            ? '1 månad väntar på att bokföras.'
            : `${dueCount} månader väntar på att bokföras.`}{' '}
          Förfallna månader bokförs annars automatiskt varje natt.
        </AttnLine>
      ) : blockedInstallments > 0 ? (
        <AttnLine>
          {blockedInstallments === 1
            ? '1 månad kunde inte bokföras automatiskt: öppna raden för felmeddelandet.'
            : `${blockedInstallments} månader kunde inte bokföras automatiskt: öppna raden för felmeddelandet.`}
        </AttnLine>
      ) : null}

      {/* Toolbar: status seg (concept scene 33) */}
      <SegmentedControl
        value={statusFilter}
        onChange={setStatusFilter}
        options={[
          { value: 'active', label: 'Aktiva', count: activeCount ?? undefined },
          { value: 'completed', label: 'Avslutade' },
          { value: 'all', label: 'Alla' },
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
          icon={CalendarClock}
          title="Inga periodiseringar"
          description="Periodisera en fakturarad när du registrerar en leverantörsfaktura eller skapar en kundfaktura, så fördelas beloppet automatiskt över månaderna här."
        />
      ) : (
        <>
          <div className="overflow-x-auto" role="region" aria-label="Periodiseringar">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Beskrivning</th>
                  <th className={TH_CLASS}>Konto</th>
                  <th className={TH_CLASS}>Period</th>
                  <th className={cn(TH_CLASS, 'text-right')}>Totalt</th>
                  <th className={cn(TH_CLASS, 'text-right')}>Kvar</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={cn(TH_CLASS, 'w-28')} />
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
                        <td className={cn(TD_CLASS, 'max-w-[320px]')}>
                          <span className="block truncate" title={schedule.description ?? ''}>
                            {schedule.description || '-'}
                          </span>
                          {sourceHref && (
                            <Link
                              href={sourceHref}
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                            >
                              {schedule.supplier_invoice_id ? 'Leverantörsfaktura' : 'Kundfaktura'}
                            </Link>
                          )}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                          {schedule.balance_account} → {schedule.target_account}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                          {formatDate(schedule.period_start)} till {formatDate(schedule.period_end)}
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
                              {SCHEDULE_STATUS_TEXT.cancelled}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {SCHEDULE_STATUS_TEXT[schedule.status]}
                            </span>
                          )}
                        </td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                          {canWrite && schedule.status === 'active' && remaining > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setDissolveTarget(schedule)
                              }}
                              className={cn(
                                QUIET_LINK_CLASS,
                                'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
                              )}
                            >
                              Lös upp nu
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr data-no-stagger className="hover:bg-transparent">
                          <td colSpan={7} className="border-b border-border bg-muted/30 p-0">
                            <RowFoldout>
                              <div className="px-6 py-4">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                      <th className="pb-2">Månad</th>
                                      <th className="pb-2 text-right">Belopp</th>
                                      <th className="pb-2 pl-6">Status</th>
                                      <th className="pb-2 pl-6">Verifikat</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {schedule.installments.map((installment) => (
                                      <tr key={installment.id} className="border-t border-border/60">
                                        <td className="py-1.5 tabular-nums">
                                          {monthLabel(installment.period_month)}
                                        </td>
                                        <td className="py-1.5 text-right tabular-nums">
                                          {formatCurrency(installment.amount)}
                                        </td>
                                        <td className="py-1.5 pl-6">
                                          {installment.status === 'posted' ? (
                                            <span className="text-xs text-muted-foreground">Bokförd</span>
                                          ) : installment.status === 'cancelled' ? (
                                            <Badge variant="outline" className="font-normal">Makulerad</Badge>
                                          ) : installment.last_error ? (
                                            <span className="inline-flex items-center gap-1.5">
                                              <Badge variant="destructive" className="font-normal">Fel</Badge>
                                              <span className="text-xs text-muted-foreground">
                                                {installment.last_error}
                                              </span>
                                            </span>
                                          ) : (
                                            <span className="text-xs text-muted-foreground">Väntar</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pl-6">
                                          {installment.journal_entry_id ? (
                                            <Link
                                              href={`/bookkeeping/${installment.journal_entry_id}`}
                                              className="text-xs underline-offset-2 hover:underline"
                                            >
                                              Öppna verifikat
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

          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Månadens andel bokförs automatiskt den sista dagen i varje månad. Öppna en rad
            för att se varje månads verifikat.
          </p>
        </>
      )}

      <ConfirmDialog
        open={postConfirmOpen}
        onOpenChange={setPostConfirmOpen}
        title="Bokför förfallna månader?"
        description={
          dueCount === 1
            ? 'Ett verifikat bokförs för den väntande månaden.'
            : `${dueCount} verifikat bokförs, ett per väntande månad.`
        }
        confirmLabel="Bokför"
        onConfirm={handlePostDue}
      />

      <ConfirmDialog
        open={dissolveTarget !== null}
        onOpenChange={(open) => !open && setDissolveTarget(null)}
        title="Lös upp periodiseringen nu?"
        description={
          dissolveTarget
            ? `Återstående ${formatCurrency(dissolveRemaining)} bokförs i ett verifikat daterat idag, och periodiseringen avslutas.`
            : undefined
        }
        confirmLabel="Lös upp nu"
        onConfirm={handleDissolve}
      >
        {dissolveTarget && (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{dissolveTarget.description || 'Periodisering'}</p>
            <p className="tabular-nums text-muted-foreground">
              {dissolveTarget.target_account} ← {dissolveTarget.balance_account} ·{' '}
              {formatDate(dissolveTarget.period_start)} till {formatDate(dissolveTarget.period_end)}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
