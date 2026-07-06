'use client'

// Periodiseringar: löpande accrual schedules (förutbetalda kostnader 17xx /
// förutbetalda intäkter 29xx) skapade från fakturarader. Djupt regulatorisk
// bokföringsyta → svenska i båda locales, i linje med bokslutsguiden.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, CalendarClock, ChevronDown, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
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

const SCHEDULE_BADGE: Record<
  AccrualScheduleStatus,
  { label: string; variant: 'secondary' | 'success' | 'outline' }
> = {
  active: { label: 'Aktiv', variant: 'secondary' },
  completed: { label: 'Avslutad', variant: 'success' },
  cancelled: { label: 'Makulerad', variant: 'outline' },
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
  const [isLoading, setIsLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [isPosting, setIsPosting] = useState(false)
  const [dissolveTarget, setDissolveTarget] = useState<ScheduleWithInstallments | null>(null)
  const [isDissolving, setIsDissolving] = useState(false)

  const fetchSchedules = useCallback(async (filter: StatusFilter) => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/bookkeeping/accruals?status=${filter}`)
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { context: 'journal_entry' }))
      setSchedules(json.data ?? [])
      setDueCount(json.due_count ?? 0)
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
    setIsDissolving(true)
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
    } finally {
      setIsDissolving(false)
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

  return (
    <div className="space-y-8">
      <PageHeader title="Periodiseringar" />

      {(dueCount > 0 || blockedInstallments > 0) && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/40 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="text-sm">
              <p className="font-medium">
                {dueCount > 0
                  ? `${dueCount} ${dueCount === 1 ? 'månad väntar' : 'månader väntar'} på att bokföras`
                  : 'Periodiseringar med fel'}
              </p>
              <p className="text-muted-foreground">
                {blockedInstallments > 0
                  ? `${blockedInstallments} ${blockedInstallments === 1 ? 'månad kunde' : 'månader kunde'} inte bokföras automatiskt: öppna raden för felmeddelandet.`
                  : 'Förfallna månader bokförs automatiskt varje natt, eller direkt här.'}
              </p>
            </div>
          </div>
          {canWrite && dueCount > 0 && (
            <Button onClick={handlePostDue} disabled={isPosting} className="shrink-0">
              {isPosting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Bokför…
                </>
              ) : (
                'Bokför förfallna'
              )}
            </Button>
          )}
        </div>
      )}

      <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
        <TabsList>
          <TabsTrigger value="active">Aktiva</TabsTrigger>
          <TabsTrigger value="completed">Avslutade</TabsTrigger>
          <TabsTrigger value="all">Alla</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </CardContent>
        </Card>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Inga periodiseringar"
          description="Periodisera en fakturarad när du registrerar en leverantörsfaktura eller skapar en kundfaktura, så fördelas beloppet automatiskt över månaderna här."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Beskrivning</TableHead>
                  <TableHead>Konto</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Totalt</TableHead>
                  <TableHead className="text-right">Kvar</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((schedule) => {
                  const dissolved = sumPosted(schedule.installments)
                  const remaining =
                    schedule.status === 'cancelled'
                      ? 0
                      : roundOre(schedule.total_amount - dissolved)
                  const isOpen = expanded.has(schedule.id)
                  const badge = SCHEDULE_BADGE[schedule.status]
                  const sourceHref = schedule.supplier_invoice_id
                    ? `/supplier-invoices/${schedule.supplier_invoice_id}`
                    : schedule.invoice_id
                      ? `/invoices/${schedule.invoice_id}`
                      : null
                  return (
                    <Fragment key={schedule.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => toggleExpanded(schedule.id)}
                      >
                        <TableCell className="pr-0">
                          <ChevronDown
                            className={cn(
                              'h-4 w-4 text-muted-foreground transition-transform duration-150',
                              isOpen && 'rotate-180',
                            )}
                            aria-hidden="true"
                          />
                        </TableCell>
                        <TableCell className="max-w-[320px]">
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
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {schedule.balance_account} → {schedule.target_account}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDate(schedule.period_start)} till {formatDate(schedule.period_end)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(schedule.total_amount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(remaining)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {canWrite && schedule.status === 'active' && remaining > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                setDissolveTarget(schedule)
                              }}
                            >
                              Lös upp nu
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={8} className="bg-muted/30 p-0">
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
                                          <Badge variant="success">Bokförd</Badge>
                                        ) : installment.status === 'cancelled' ? (
                                          <Badge variant="outline">Makulerad</Badge>
                                        ) : installment.last_error ? (
                                          <span className="inline-flex items-center gap-1.5">
                                            <Badge variant="destructive">Fel</Badge>
                                            <span className="text-xs text-muted-foreground">
                                              {installment.last_error}
                                            </span>
                                          </span>
                                        ) : (
                                          <Badge variant="outline">Väntar</Badge>
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
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {dissolveTarget && (
        <ConfirmationDialog
          open={!!dissolveTarget}
          onOpenChange={(open) => !open && setDissolveTarget(null)}
          onConfirm={handleDissolve}
          isSubmitting={isDissolving}
          title="Lös upp periodiseringen nu?"
          warningText={`Återstående ${formatCurrency(
            Math.round(
              (dissolveTarget.total_amount - sumPosted(dissolveTarget.installments)) * 100,
            ) / 100,
          )} bokförs i ett verifikat daterat idag, och periodiseringen avslutas.`}
          confirmLabel="Lös upp nu"
        >
          <div className="space-y-1 text-sm">
            <p className="font-medium">{dissolveTarget.description || 'Periodisering'}</p>
            <p className="tabular-nums text-muted-foreground">
              {dissolveTarget.target_account} ← {dissolveTarget.balance_account} ·{' '}
              {formatDate(dissolveTarget.period_start)} till {formatDate(dissolveTarget.period_end)}
            </p>
          </div>
        </ConfirmationDialog>
      )}
    </div>
  )
}
