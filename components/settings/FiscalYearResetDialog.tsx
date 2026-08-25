'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { formatDate } from '@/lib/utils'
import type { FiscalYearResetBlocker, FiscalYearResetEligibility } from '@/types'

interface FiscalYearResetDialogProps {
  periodId: string
  periodName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful reset so the parent can refetch. */
  onReset: () => void
}

function readApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

/**
 * Destructive fiscal-year reset (issue #1883): hard-deletes ALL vouchers in
 * one OPEN fiscal year after typed confirmation of the year's label. Mirrors
 * the CompanyMigrationResetDialog pattern: eligibility preview with blockers,
 * a clear statement of what is deleted (voucher count, year label) and what
 * is NOT (documents are detached, never deleted: BFL 7 kap), and a
 * type-the-name confirmation. Every guard is re-enforced server-side.
 */
export function FiscalYearResetDialog({
  periodId,
  periodName,
  open,
  onOpenChange,
  onReset,
}: FiscalYearResetDialogProps) {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const loadFailedMessage = t('fy_reset_load_failed')
  const [eligibility, setEligibility] = useState<FiscalYearResetEligibility | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [confirmName, setConfirmName] = useState('')

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadEligibility() {
      setIsLoading(true)
      setLoadError(null)
      setEligibility(null)
      try {
        const response = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/reset`,
          { cache: 'no-store' },
        )
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(readApiError(body, loadFailedMessage))
        }
        if (!cancelled) setEligibility(body.data as FiscalYearResetEligibility)
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? getUserErrorMessage(error) : loadFailedMessage,
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadEligibility()
    return () => {
      cancelled = true
    }
  }, [periodId, loadFailedMessage, open])

  function resetForm() {
    setEligibility(null)
    setLoadError(null)
    setConfirmName('')
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isResetting) return
    onOpenChange(nextOpen)
    if (!nextOpen) resetForm()
  }

  function blockerMessage(blocker: FiscalYearResetBlocker): string {
    switch (blocker.code) {
      case 'period_closed':
        return t('fy_reset_blocker_closed')
      case 'period_locked':
        return t('fy_reset_blocker_locked')
      case 'company_lock_date':
        return t('fy_reset_blocker_lock_date', { date: blocker.date ?? '' })
      case 'year_end_state':
        return t('fy_reset_blocker_year_end')
      case 'arsredovisning_state':
        return t('fy_reset_blocker_arsredovisning')
      case 'next_year_dependency':
        return t('fy_reset_blocker_next_year')
      case 'vat_declared':
        return t('fy_reset_blocker_vat')
      case 'agi_declared':
        return t('fy_reset_blocker_agi')
      case 'rot_rut_state':
        return t('fy_reset_blocker_rot_rut')
      case 'cross_year_reference':
        return t('fy_reset_blocker_cross_year')
      default:
        return t('fy_reset_blocker_other')
    }
  }

  const confirmationName = eligibility?.period.name ?? periodName
  const canReset =
    eligibility?.eligible === true &&
    confirmName.trim() === confirmationName.trim() &&
    !isResetting

  async function handleReset() {
    if (!canReset) return
    setIsResetting(true)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/reset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm_name: confirmName }),
        },
      )
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(readApiError(body, t('fy_reset_failed_default')))
      }

      const deleted = (body.data as { deleted?: number } | undefined)?.deleted ?? 0
      toast({
        title: t('fy_reset_success_title'),
        description: t('fy_reset_success_description', { count: deleted }),
      })
      setIsResetting(false)
      onOpenChange(false)
      resetForm()
      onReset()
    } catch (error) {
      toast({
        title: t('fy_reset_failed_title'),
        description:
          error instanceof Error
            ? getUserErrorMessage(error)
            : t('fy_reset_failed_default'),
        variant: 'destructive',
      })
      setIsResetting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('fy_reset_dialog_title', { name: periodName })}</DialogTitle>
          <DialogDescription>{t('fy_reset_dialog_description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('fy_reset_checking')}
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        ) : eligibility ? (
          <div className="space-y-5">
            {eligibility.blockers.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {t('fy_reset_blocked_title')}
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {eligibility.blockers.map((blocker) => (
                    <li key={blocker.code}>{blockerMessage(blocker)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-medium">{t('fy_reset_summary_heading')}</h3>
              <dl className="divide-y divide-border border-y border-border">
                <div className="flex items-center justify-between py-2 text-sm">
                  <dt className="text-muted-foreground">{t('fy_reset_summary_year')}</dt>
                  <dd className="font-medium">
                    {eligibility.period.name}
                    <span className="ml-2 text-muted-foreground tabular-nums">
                      {formatDate(eligibility.period.period_start)} -{' '}
                      {formatDate(eligibility.period.period_end)}
                    </span>
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2 text-sm">
                  <dt className="text-muted-foreground">{t('fy_reset_summary_vouchers')}</dt>
                  <dd className="tabular-nums font-medium">{eligibility.counts.vouchers}</dd>
                </div>
                <div className="flex items-center justify-between py-2 text-sm">
                  <dt className="text-muted-foreground">{t('fy_reset_summary_documents')}</dt>
                  <dd className="tabular-nums font-medium">
                    {eligibility.counts.documents_to_detach}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('fy_reset_documents_note')}
              </p>
            </div>

            {eligibility.eligible ? (
              <div className="space-y-2">
                <Label htmlFor="fy-reset-name">
                  {t.rich('fy_reset_confirm_name', {
                    name: confirmationName,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </Label>
                <Input
                  id="fy-reset-name"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder={confirmationName}
                  autoComplete="off"
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isResetting}
          >
            {t('fy_confirm_cancel')}
          </Button>
          {eligibility?.eligible ? (
            <Button variant="destructive" onClick={handleReset} disabled={!canReset}>
              {isResetting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('fy_reset_resetting')}
                </>
              ) : (
                t('fy_reset_submit')
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
