'use client'

import { useTranslations } from 'next-intl'
import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Plus, Lock, Unlock, Loader2, Eraser } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'
import { FiscalYearResetDialog } from '@/components/settings/FiscalYearResetDialog'
import { suggestSeedDate } from '@/lib/bookkeeping/suggest-fiscal-period'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/** Status of a fiscal period, in legal precedence: closed > locked > open. */
function periodStatus(p: FiscalPeriod): 'closed' | 'locked' | 'open' {
  if (p.is_closed) return 'closed'
  if (p.locked_at) return 'locked'
  return 'open'
}

// Open is the normal state and renders as muted text; only the deviations
// (locked/closed) get a chip (UI-migration convention 5).
const STATUS_VARIANT: Record<'closed' | 'locked', 'secondary' | 'warning'> = {
  closed: 'secondary',
  locked: 'warning',
}

export function FiscalYearsManager() {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const { role } = useCompany()
  const { dialogProps, confirm } = useDestructiveConfirm()
  // Session-cached registry (lib/reference-data): the same list every
  // picker renders, so a lock/unlock/reset here is visible everywhere the
  // moment the cache is invalidated below.
  const { periods, isLoading, error: periodsError } = useFiscalPeriods()
  const hasError = !!periodsError && periods.length === 0
  const [dialogOpen, setDialogOpen] = useState(false)
  const [mutatingId, setMutatingId] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<FiscalPeriod | null>(null)

  // Only owners/admins may change a period's lock state. The API enforces this
  // too (requireWrite); this just hides controls a viewer/member can't use.
  const canManage = role === 'owner' || role === 'admin'

  const refreshPeriods = useCallback(() => invalidateReferenceData('ref:fiscal-periods'), [])

  // Newest first: matches the API's ordering and reads most-recent-at-top.
  const sorted = [...periods].sort((a, b) => b.period_start.localeCompare(a.period_start))

  async function runLockAction(
    period: FiscalPeriod,
    action: 'lock' | 'unlock' | 'reopen-external',
  ) {
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
      toast({
        title:
          action === 'lock'
            ? t('fy_lock_success')
            : action === 'unlock'
              ? t('fy_unlock_success')
              : t('fy_reopen_success'),
      })
      await refreshPeriods()
    } catch (err) {
      toast({
        title: t('fy_action_error'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
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

  // Undo "klarmarkera" (year marked as closed in a previous bookkeeping
  // system). Only offered while the closed state still comes from that mark:
  // a year closed by a real year-end run keeps its closing entry and stays
  // closed here.
  async function handleReopen(period: FiscalPeriod) {
    const ok = await confirm({
      title: t('fy_reopen_confirm_title'),
      description: t('fy_reopen_confirm_body', { name: period.name }),
      confirmLabel: t('fy_action_reopen'),
      cancelLabel: t('fy_confirm_cancel'),
      variant: 'warning',
    })
    if (ok) await runLockAction(period, 'reopen-external')
  }

  return (
    <SettingsGroup label={t('fy_heading')} help={t('fy_help')}>
      {isLoading ? (
        <div className="space-y-2 px-1 py-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : hasError ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{t('fy_load_error')}</p>
      ) : sorted.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{t('fy_empty')}</p>
      ) : (
        // Period rows: flat hairline list, no cards.
        sorted.map((p) => {
          const status = periodStatus(p)
          const isMutating = mutatingId === p.id
          const closedExternally = status === 'closed' && p.closed_externally === true
          const canReopen = canManage && closedExternally && !p.closing_entry_id
          return (
            <div key={p.id} className="flex items-center gap-3 border-b border-border px-1 py-3">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                  {formatDate(p.period_start)} - {formatDate(p.period_end)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {status === 'open' ? (
                  <span className="text-xs text-muted-foreground">{t('fy_status_open')}</span>
                ) : (
                  <Badge variant={STATUS_VARIANT[status]}>
                    {closedExternally ? t('fy_status_closed_external') : t(`fy_status_${status}`)}
                  </Badge>
                )}
                {canManage && status === 'open' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
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
                {canManage && status === 'open' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={isMutating}
                    onClick={() => setResetTarget(p)}
                  >
                    <Eraser className="mr-1.5 h-4 w-4" />
                    {t('fy_action_reset')}
                  </Button>
                )}
                {canManage && status === 'locked' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
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
                {canReopen && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={isMutating}
                    onClick={() => handleReopen(p)}
                  >
                    {isMutating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Unlock className="mr-1.5 h-4 w-4" />
                        {t('fy_action_reopen')}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )
        })
      )}

      {/* Trailing quiet action: create the next fiscal year. */}
      <div className="px-1 pt-3">
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDialogOpen(true)}
          disabled={isLoading}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t('fy_create')}
        </Button>
      </div>

      <CreatePeriodDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entryDate={suggestSeedDate(periods, new Date().toISOString().split('T')[0])}
        periods={periods}
        onCreated={refreshPeriods}
      />

      {resetTarget && (
        <FiscalYearResetDialog
          periodId={resetTarget.id}
          periodName={resetTarget.name}
          open={resetTarget !== null}
          onOpenChange={(open) => {
            if (!open) setResetTarget(null)
          }}
          onReset={refreshPeriods}
        />
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </SettingsGroup>
  )
}
