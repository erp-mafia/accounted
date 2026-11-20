'use client'

import { useTranslations, useLocale } from 'next-intl'
import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import {
  BackspaceIcon,
  LockClosedIcon,
  LockOpenIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/icons'
import { formatDate } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'
import { FiscalYearResetDialog } from '@/components/settings/FiscalYearResetDialog'
import { FiscalYearReopenDialog } from '@/components/settings/FiscalYearReopenDialog'
import { FiscalYearEditDialog } from '@/components/settings/FiscalYearEditDialog'
import { SIEOpeningBalanceReview } from '@/components/settings/SIEOpeningBalanceReview'
import { fiscalYearShortName, suggestSeedDate } from '@/lib/bookkeeping/suggest-fiscal-period'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'

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
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { role } = useCompany()
  const { canWrite, lockedTitle } = useViewerLock()
  const { dialogProps, confirm } = useDestructiveConfirm()
  // Session-cached registry (lib/reference-data): the same list every
  // picker renders, so a lock/unlock/reset here is visible everywhere the
  // moment the cache is invalidated below.
  const { periods, isLoading, error: periodsError } = useFiscalPeriods()
  const hasError = !!periodsError && periods.length === 0
  const [dialogOpen, setDialogOpen] = useState(false)
  const [mutatingId, setMutatingId] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<FiscalPeriod | null>(null)
  const [reopenTarget, setReopenTarget] = useState<FiscalPeriod | null>(null)
  const [editTarget, setEditTarget] = useState<FiscalPeriod | null>(null)
  const [editMode, setEditMode] = useState<'edit' | 'start'>('edit')

  // Only owners/admins may change a period's lock state. The API enforces this
  // too (requireWrite); this just hides controls a viewer/member can't use.
  const canManage = role === 'owner' || role === 'admin'

  const refreshPeriods = useCallback(() => invalidateReferenceData('ref:fiscal-periods'), [])

  // Newest first: matches the API's ordering and reads most-recent-at-top.
  const sorted = [...periods].sort((a, b) => b.period_start.localeCompare(a.period_start))
  const earliestId = sorted.length > 0 ? sorted[sorted.length - 1].id : null
  const earliest = sorted.length > 0 ? sorted[sorted.length - 1] : null

  // crm#1450: an empty first year (seeded before the company existed by an
  // older onboarding) can be removed. Offered only on the earliest open year
  // of a company with more than one year and no posted verifikat in it; the
  // server checks everything else (drafts, voucher numbers, linked records).
  const [earliestPostedCount, setEarliestPostedCount] = useState<number | null>(null)
  const earliestCandidateId =
    canManage && sorted.length > 1 && earliest && periodStatus(earliest) === 'open' ? earliest.id : null
  useEffect(() => {
    setEarliestPostedCount(null)
    if (!earliestCandidateId) return
    let cancelled = false
    fetch(`/api/bookkeeping/fiscal-periods/${earliestCandidateId}/entry-count`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { posted_count?: number } } | null) => {
        if (!cancelled && typeof body?.data?.posted_count === 'number') setEarliestPostedCount(body.data.posted_count)
      })
      .catch(() => {
        // Safe to ignore: without the count Ta bort is simply not offered,
        // and the server refuses any year that is not empty anyway.
      })
    return () => {
      cancelled = true
    }
  }, [earliestCandidateId])

  async function handleDelete(period: FiscalPeriod) {
    const ok = await confirm({
      title: t('fy_delete_confirm_title', { name: period.name }),
      description: t('fy_delete_confirm_body', { name: period.name }),
      confirmLabel: t('fy_action_delete'),
      cancelLabel: t('fy_confirm_cancel'),
      variant: 'destructive',
    })
    if (!ok) return
    setMutatingId(period.id)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(getUserErrorMessage(body, { locale: errorLocale, fallback: t('fy_action_error') }))
      }
      toast({ title: t('fy_delete_success') })
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

  function openEdit(period: FiscalPeriod, mode: 'edit' | 'start') {
    setEditMode(mode)
    setEditTarget(period)
  }

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
        throw new Error(getUserErrorMessage(body, { locale: errorLocale, fallback: t('fy_action_error') }))
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
          // A year closed with a bokslut here: the owner reopens it while its
          // årsredovisning has no legal weight (crm#1290). A closing entry on
          // a year that is no longer closed is a reopen that stopped midway,
          // offered again so it can finish. The dialog shows every gate; the
          // server enforces them.
          const canReopenClosed =
            role === 'owner' && !closedExternally && Boolean(p.closing_entry_id)
          // crm#1140: the company's first year may still get its start
          // corrected within its month once it is locked or closed (the
          // registration day instead of the 1st). Posted opening balances
          // pin the start, so the action is not offered then.
          const canCorrectStart =
            canManage && status !== 'open' && p.id === earliestId && !p.opening_balance_entry_id
          const canDelete = p.id === earliestCandidateId && earliestPostedCount === 0
          return (
            <div key={p.id} className="flex flex-col items-start gap-3 border-b-hairline px-1 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{fiscalYearShortName(p.name)}</span>
                <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                  {formatDate(p.period_start)} - {formatDate(p.period_end)}
                </span>
              </div>
              <div className="flex max-w-full shrink-0 flex-wrap items-center gap-3">
                <SIEOpeningBalanceReview period={p} canManage={canManage} />
                {status === 'open' ? (
                  <span className="text-xs text-muted-foreground">{t('fy_status_open')}</span>
                ) : (
                  <Badge variant={STATUS_VARIANT[status]}>
                    {closedExternally ? t('fy_status_closed_external') : t(`fy_status_${status}`)}
                  </Badge>
                )}
                {/* Ändra is offered on open years only, like Lås and
                    Nollställ: the PATCH route refuses locked and closed years,
                    and the row already carries that chip. The one exception
                    is Rätta startdatum on the first year, below. */}
                {canManage && status === 'open' && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={isMutating}
                    onClick={() => openEdit(p, 'edit')}
                  >
                    <PencilIcon className="h-4 w-4" />
                    {t('fy_action_edit')}
                  </Button>
                )}
                {canCorrectStart && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={isMutating}
                    onClick={() => openEdit(p, 'start')}
                  >
                    <PencilIcon className="h-4 w-4" />
                    {t('fy_action_correct_start')}
                  </Button>
                )}
                {canManage && status === 'open' && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    loading={isMutating}
                    onClick={() => handleLock(p)}
                  >
                    {!isMutating && <LockClosedIcon className="h-4 w-4" />}
                    {t('fy_action_lock')}
                  </Button>
                )}
                {canManage && status === 'open' && (
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={isMutating}
                    onClick={() => setResetTarget(p)}
                  >
                    <BackspaceIcon className="h-4 w-4" />
                    {t('fy_action_reset')}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    loading={isMutating}
                    disabled={!canWrite}
                    title={lockedTitle}
                    onClick={() => handleDelete(p)}
                  >
                    {!isMutating && <TrashIcon className="h-4 w-4" />}
                    {t('fy_action_delete')}
                  </Button>
                )}
                {canManage && status === 'locked' && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    loading={isMutating}
                    onClick={() => handleUnlock(p)}
                  >
                    {!isMutating && <LockOpenIcon className="h-4 w-4" />}
                    {t('fy_action_unlock')}
                  </Button>
                )}
                {canReopen && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    loading={isMutating}
                    onClick={() => handleReopen(p)}
                  >
                    {!isMutating && <LockOpenIcon className="h-4 w-4" />}
                    {t('fy_action_reopen')}
                  </Button>
                )}
                {canReopenClosed && (
                  <Button
                    variant="outline"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={isMutating}
                    onClick={() => setReopenTarget(p)}
                  >
                    <LockOpenIcon className="h-4 w-4" />
                    {t('fy_action_reopen')}
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
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDialogOpen(true)}
          disabled={!canWrite || isLoading}
          title={lockedTitle}
        >
          <PlusIcon className="h-4 w-4" />
          {t('fy_create')}
        </Button>
      </div>

      <CreatePeriodDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entryDate={suggestSeedDate(periods, todayIsoStockholm())}
        periods={periods}
        onCreated={refreshPeriods}
      />

      {editTarget && (
        <FiscalYearEditDialog
          key={`${editTarget.id}-${editMode}`}
          period={editTarget}
          mode={editMode}
          open={editTarget !== null}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null)
          }}
          onSaved={refreshPeriods}
        />
      )}

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

      {reopenTarget && (
        <FiscalYearReopenDialog
          periodId={reopenTarget.id}
          periodName={reopenTarget.name}
          open={reopenTarget !== null}
          onOpenChange={(open) => {
            if (!open) setReopenTarget(null)
          }}
          onReopened={refreshPeriods}
        />
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </SettingsGroup>
  )
}
