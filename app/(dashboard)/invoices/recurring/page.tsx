'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
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
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
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
    const next = s.status === 'active' ? 'paused' : 'active'
    // Reactivating an auto-send schedule resumes automatic emails to the
    // customer, so make the user consciously confirm they mean to turn it on.
    if (
      next === 'active' &&
      s.auto_send &&
      !confirm(t('resume_autosend_confirm', { name: s.name }))
    ) {
      return
    }
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
  }

  async function runNow(s: ScheduleRow) {
    // In-flight guard: a second click while the request runs would create a
    // duplicate invoice for the customer.
    if (runningId) return
    if (!confirm(t('run_now_confirm', { name: s.name }))) return
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
    if (!confirm(t('delete_confirm', { name: s.name }))) {
      return
    }
    const res = await fetch(`/api/invoices/recurring/${s.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: t('schedule_deleted_title') })
      fetchSchedules()
    } else {
      toast({ title: t('schedule_delete_failed_title'), variant: 'destructive' })
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
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('loading')}
          </CardContent>
        </Card>
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Repeat}
              title={t('empty_title')}
              description={t('empty_description')}
              actionLabel={canWrite ? t('new_schedule') : undefined}
              onAction={canWrite ? openNewSchedule : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_name')}</TableHead>
                  <TableHead>{t('th_customer')}</TableHead>
                  <TableHead className="tabular-nums">{t('th_day')}</TableHead>
                  <TableHead className="tabular-nums">{t('th_next_run')}</TableHead>
                  <TableHead>{t('th_status')}</TableHead>
                  <TableHead className="tabular-nums text-right">{t('th_generated')}</TableHead>
                  <TableHead className="text-right">{t('th_actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow
                    key={s.id}
                    className={canWrite ? 'cursor-pointer' : undefined}
                    onClick={canWrite ? () => openEdit(s.id) : undefined}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {s.name}
                        {s.last_run_warning && (
                          <AlertTriangle
                            className="h-4 w-4 text-warning-foreground"
                            aria-label={s.last_run_warning}
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.customer?.name ?? '-'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {s.day_of_month}
                      <span className="text-muted-foreground">
                        {' · '}
                        {t('send_time', {
                          time: `${String(s.send_hour ?? 8).padStart(2, '0')}:00`,
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDate(s.next_run_date)}</TableCell>
                    <TableCell>
                      {s.status === 'active' ? (
                        <Badge variant="success">{t('status_active')}</Badge>
                      ) : (
                        <Badge variant="secondary">{t('status_paused')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-right">
                      {s.generated_count}
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canWrite && (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={runningId !== null}
                              onClick={() => runNow(s)}
                            >
                              {t('run_now')}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => togglePause(s)}
                            >
                              {s.status === 'active' ? t('pause') : t('resume')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteSchedule(s)}
                            >
                              {t('delete')}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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
    </div>
  )
}
