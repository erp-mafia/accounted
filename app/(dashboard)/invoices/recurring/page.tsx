'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import { Plus, Repeat, Lock, AlertTriangle } from 'lucide-react'
import NewRecurringScheduleDialog from '@/components/invoices/NewRecurringScheduleDialog'
import type { RecurringInvoiceSchedule, Customer } from '@/types'

type ScheduleRow = RecurringInvoiceSchedule & {
  customer?: Pick<Customer, 'id' | 'name' | 'email'>
}

export default function RecurringInvoicesPage() {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const { dialogProps, confirm: confirmAction } = useDestructiveConfirm()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('invoice_recurring')

  // The "Nytt schema" modal is driven by the URL (?new=1) so every entry
  // point (the header button, the empty state, and the legacy
  // /invoices/recurring/new redirect) opens the same dialog, and the
  // browser back button closes it. Same pattern as /invoices.
  const showNewSchedule = searchParams.has('new')
  const closeNewSchedule = () => router.replace('/invoices/recurring', { scroll: false })
  const openNewSchedule = () => router.push('/invoices/recurring?new=1', { scroll: false })

  // Editing reuses the same modal, driven by ?edit=<id>. The schedule is taken
  // from the already-loaded list (it carries items + send_hour), so clicking a
  // row opens a prefilled form with no extra fetch.
  const editId = searchParams.get('edit')
  const editSchedule = editId ? schedules.find((s) => s.id === editId) : undefined
  const closeEdit = () => router.replace('/invoices/recurring', { scroll: false })
  const openEdit = (id: string) => router.push(`/invoices/recurring?edit=${id}`, { scroll: false })

  async function fetchSchedules() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/invoices/recurring')
      if (!res.ok) throw new Error('failed')
      const json = await res.json()
      setSchedules(json.data ?? [])
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchSchedules()
  }, [])

  async function togglePause(s: ScheduleRow) {
    // In-flight guard: the confirm dialog closes before the PATCH settles,
    // so a second click would fire a duplicate request.
    if (togglingId) return
    const next = s.status === 'active' ? 'paused' : 'active'
    // Reactivating an auto-send schedule resumes automatic emails to the
    // customer, so make the user consciously confirm they mean to turn it on.
    if (next === 'active' && s.auto_send) {
      const ok = await confirmAction({
        title: t('resume_autosend_confirm_title'),
        description: t('resume_autosend_confirm', { name: s.name }),
        confirmLabel: t('resume'),
        variant: 'warning',
      })
      if (!ok) return
    }
    setTogglingId(s.id)
    try {
      const res = await fetch(`/api/invoices/recurring/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (res.ok) {
        toast({
          title: next === 'paused' ? t('schedule_paused_title') : t('schedule_resumed_title'),
        })
        fetchSchedules()
      } else {
        toast({
          title: t('schedule_update_failed_title'),
          variant: 'destructive',
        })
      }
    } finally {
      setTogglingId(null)
    }
  }

  async function runNow(s: ScheduleRow) {
    // In-flight guard: a second click while the request runs would create a
    // duplicate invoice for the customer.
    if (runningId) return
    const ok = await confirmAction({
      title: t('run_now_confirm_title'),
      description: t('run_now_confirm', { name: s.name }),
      confirmLabel: t('run_now'),
      variant: 'warning',
    })
    if (!ok) return
    setRunningId(s.id)
    try {
      const res = await fetch(`/api/invoices/recurring/${s.id}/run`, { method: 'POST' })
      if (res.ok) {
        const json = await res.json().catch(() => ({}))
        const warning = (json?.data?.warning as string | null | undefined) ?? undefined
        toast({
          title: t('run_now_success_title'),
          description: warning,
          variant: warning ? 'destructive' : undefined,
        })
        fetchSchedules()
      } else {
        toast({ title: t('run_now_failed_title'), variant: 'destructive' })
      }
    } finally {
      setRunningId(null)
    }
  }

  async function deleteSchedule(s: ScheduleRow) {
    // In-flight guard: the confirm dialog closes before the DELETE settles,
    // so a second click would fire a duplicate request.
    if (deletingId) return
    const ok = await confirmAction({
      title: t('delete_confirm_title'),
      description: t('delete_confirm', { name: s.name }),
      confirmLabel: t('delete'),
      variant: 'destructive',
    })
    if (!ok) return
    setDeletingId(s.id)
    try {
      const res = await fetch(`/api/invoices/recurring/${s.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('schedule_deleted_title') })
        fetchSchedules()
      } else {
        toast({ title: t('schedule_delete_failed_title'), variant: 'destructive' })
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          canWrite ? (
            <Button onClick={openNewSchedule}>
              <Plus className="mr-2 h-4 w-4" />
              {t('new_schedule')}
            </Button>
          ) : (
            <Button disabled title={t('viewer_disabled_tooltip')}>
              <Lock className="mr-2 h-4 w-4" />
              {t('new_schedule')}
            </Button>
          )
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_schedule') : undefined}
          onAction={canWrite ? openNewSchedule : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_name')}</th>
                <th className={TH_CLASS}>{t('th_customer')}</th>
                <th className={TH_CLASS}>{t('th_day')}</th>
                <th className={TH_CLASS}>{t('th_next_run')}</th>
                <th className={TH_CLASS}>{t('th_status')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('th_generated')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('th_actions')}</th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {schedules.map((s) => (
                <tr
                  key={s.id}
                  className={cn(
                    'group transition-colors duration-150 hover:bg-secondary/35',
                    canWrite && 'cursor-pointer',
                  )}
                  onClick={canWrite ? () => openEdit(s.id) : undefined}
                >
                  <td className={`${TD_CLASS} font-medium`}>
                    <div className="flex items-center gap-2">
                      {/* Focusable edit affordance: the row onClick is mouse-only,
                          so keyboard users open the editor through the name. */}
                      {canWrite ? (
                        <button
                          type="button"
                          className="hover:underline underline-offset-4"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(s.id)
                          }}
                        >
                          {s.name}
                        </button>
                      ) : (
                        s.name
                      )}
                      {s.last_run_warning && (
                        <AlertTriangle
                          className="h-4 w-4 text-attn"
                          aria-label={s.last_run_warning}
                        />
                      )}
                    </div>
                  </td>
                  <td className={`${TD_CLASS} text-muted-foreground`}>
                    {s.customer?.name ?? '-'}
                  </td>
                  <td className={`${TD_CLASS} tabular-nums`}>
                    {s.day_of_month}
                    <span className="text-muted-foreground">
                      {' · '}
                      {t('send_time', {
                        time: `${String(s.send_hour ?? 8).padStart(2, '0')}:00`,
                      })}
                      {/* Monthly is the norm; only a deviating cadence is
                          worth a label (chips-mark-exceptions convention). */}
                      {(s.interval_months ?? 1) > 1 && (
                        <>
                          {' · '}
                          {s.interval_months === 3
                            ? t('interval_quarterly')
                            : s.interval_months === 6
                              ? t('interval_semiannual')
                              : s.interval_months === 12
                                ? t('interval_yearly')
                                : t('interval_every_n', { n: s.interval_months })}
                        </>
                      )}
                    </span>
                  </td>
                  <td className={`${TD_CLASS} tabular-nums`}>{formatDate(s.next_run_date)}</td>
                  <td className={TD_CLASS}>
                    {s.status === 'active' ? (
                      <span className="text-xs text-muted-foreground">{t('status_active')}</span>
                    ) : (
                      <Badge variant="outline" className="font-normal">{t('status_paused')}</Badge>
                    )}
                  </td>
                  <td className={`${TD_CLASS} tabular-nums text-right`}>
                    {s.generated_count}
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {canWrite && (
                      <div
                        className="flex justify-end gap-4 whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                          disabled={runningId !== null}
                          onClick={() => runNow(s)}
                        >
                          {t('run_now')}
                        </button>
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                          disabled={togglingId !== null}
                          onClick={() => togglePause(s)}
                        >
                          {s.status === 'active' ? t('pause') : t('resume')}
                        </button>
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                          disabled={deletingId !== null}
                          onClick={() => deleteSchedule(s)}
                        >
                          {t('delete')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewRecurringScheduleDialog
        open={showNewSchedule}
        onOpenChange={(open) => {
          if (!open) closeNewSchedule()
        }}
        onSaved={() => {
          closeNewSchedule()
          fetchSchedules()
        }}
      />

      <NewRecurringScheduleDialog
        open={!!editSchedule}
        schedule={editSchedule}
        onOpenChange={(open) => {
          if (!open) closeEdit()
        }}
        onSaved={() => {
          closeEdit()
          fetchSchedules()
        }}
      />

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
