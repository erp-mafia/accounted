'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { Plus, Lock, Unlock, Loader2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'
import { suggestSeedDate } from '@/lib/bookkeeping/suggest-fiscal-period'

/** Status of a fiscal period, in legal precedence: closed > locked > open. */
function periodStatus(p: FiscalPeriod): 'closed' | 'locked' | 'open' {
  if (p.is_closed) return 'closed'
  if (p.locked_at) return 'locked'
  return 'open'
}

const STATUS_VARIANT: Record<'closed' | 'locked' | 'open', 'secondary' | 'warning' | 'success'> = {
  closed: 'secondary',
  locked: 'warning',
  open: 'success',
}

export function FiscalYearsManager() {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const { role } = useCompany()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [mutatingId, setMutatingId] = useState<string | null>(null)

  // Only owners/admins may change a period's lock state. The API enforces this
  // too (requireWrite); this just hides controls a viewer/member can't use.
  const canManage = role === 'owner' || role === 'admin'

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/fiscal-periods')
      if (!res.ok) throw new Error('fetch failed')
      const { data } = await res.json()
      setPeriods((data as FiscalPeriod[]) || [])
      setHasError(false)
    } catch {
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchPeriods() }, [fetchPeriods])

  // Newest first: matches the API's ordering and reads most-recent-at-top.
  const sorted = [...periods].sort((a, b) => b.period_start.localeCompare(a.period_start))

  async function runLockAction(period: FiscalPeriod, action: 'lock' | 'unlock') {
    setMutatingId(period.id)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}/${action}`, {
        method: 'POST',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Surface the backend's message verbatim: e.g. "X affärstransaktion(er)
        // saknar bokföring", which tells the user exactly what to fix first.
        throw new Error(body?.error?.message || t('fy_action_error'))
      }
      toast({ title: action === 'lock' ? t('fy_lock_success') : t('fy_unlock_success') })
      await fetchPeriods()
    } catch (err) {
      toast({
        title: t('fy_action_error'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setMutatingId(null)
    }
  }

  async function handleLock(period: FiscalPeriod) {
    const ok = await confirm({
      title: t('fy_lock_confirm_title'),
      description: t('fy_lock_confirm_body', { name: period.name }),
      confirmLabel: t('fy_action_lock'),
      cancelLabel: t('fy_confirm_cancel'),
      variant: 'warning',
    })
    if (ok) await runLockAction(period, 'lock')
  }

  async function handleUnlock(period: FiscalPeriod) {
    const ok = await confirm({
      title: t('fy_unlock_confirm_title'),
      description: t('fy_unlock_confirm_body', { name: period.name }),
      confirmLabel: t('fy_action_unlock'),
      cancelLabel: t('fy_confirm_cancel'),
      variant: 'warning',
    })
    if (ok) await runLockAction(period, 'unlock')
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('fy_heading')}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          disabled={isLoading}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t('fy_create')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('fy_help')}</p>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : hasError ? (
        <p className="text-sm text-muted-foreground">{t('fy_load_error')}</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('fy_empty')}</p>
      ) : (
        <div className="divide-y divide-border">
          {sorted.map((p) => {
            const status = periodStatus(p)
            const isMutating = mutatingId === p.id
            return (
              <div key={p.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                    {formatDate(p.period_start)} - {formatDate(p.period_end)}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Badge variant={STATUS_VARIANT[status]}>{t(`fy_status_${status}`)}</Badge>
                  {canManage && status === 'open' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isMutating}
                      onClick={() => handleLock(p)}
                    >
                      {isMutating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Lock className="mr-1.5 h-4 w-4" />
                          {t('fy_action_lock')}
                        </>
                      )}
                    </Button>
                  )}
                  {canManage && status === 'locked' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isMutating}
                      onClick={() => handleUnlock(p)}
                    >
                      {isMutating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Unlock className="mr-1.5 h-4 w-4" />
                          {t('fy_action_unlock')}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <CreatePeriodDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entryDate={suggestSeedDate(periods, new Date().toISOString().split('T')[0])}
        periods={periods}
        onCreated={fetchPeriods}
      />

      <DestructiveConfirmDialog {...dialogProps} />
    </section>
  )
}
