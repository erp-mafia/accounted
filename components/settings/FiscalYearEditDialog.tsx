'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
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
import { fiscalYearName, isDerivedFiscalYearName } from '@/lib/bookkeeping/suggest-fiscal-period'
import type { FiscalPeriod } from '@/types'

interface FiscalYearEditDialogProps {
  period: FiscalPeriod
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void
}

/** Read a user-facing message from either a legacy `{ error: string }` body
 *  (what the fiscal-periods PATCH route returns) or the canonical
 *  `{ error: { message } }` envelope. */
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
 * Edit the name and dates of one OPEN fiscal year (issue #2287). A thin
 * surface over PATCH /api/bookkeeping/fiscal-periods/[id], which already
 * allows a rename at any time on an open year and a re-date only while the
 * year has no posted vouchers. The dialog mirrors those two rules with the
 * route's own reasons: the posted count comes from the entry-count endpoint
 * on open (dates read-only above zero), and every refusal from the route is
 * shown verbatim so the user can correct and retry without leaving the
 * dialog. Only changed fields are sent, so a pure rename never trips the
 * voucher check. Every guard is re-enforced server-side.
 */
export function FiscalYearEditDialog({
  period,
  open,
  onOpenChange,
  onSaved,
}: FiscalYearEditDialogProps) {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()

  const [name, setName] = useState(period.name)
  // The name follows the dates while it is still the app's own derived name
  // ("Räkenskapsår 2027"), the same rule as CreatePeriodDialog: a seed name
  // that never matched its dates is corrected together with them, and the
  // user watches it change. A hand-written name is never overwritten.
  const [nameFollowsDates, setNameFollowsDates] = useState(() =>
    isDerivedFiscalYearName(period.name),
  )
  const [periodStart, setPeriodStart] = useState(period.period_start)
  const [periodEnd, setPeriodEnd] = useState(period.period_end)
  const [postedCount, setPostedCount] = useState<number | null>(null)
  const [countFailed, setCountFailed] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadPostedCount() {
      setIsChecking(true)
      setCountFailed(false)
      try {
        const response = await fetch(
          `/api/bookkeeping/fiscal-periods/${period.id}/entry-count`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error('entry-count failed')
        const body = (await response.json()) as { data?: { posted_count?: number } }
        if (!cancelled) setPostedCount(body.data?.posted_count ?? 0)
      } catch {
        if (!cancelled) setCountFailed(true)
      } finally {
        if (!cancelled) setIsChecking(false)
      }
    }

    void loadPostedCount()
    return () => {
      cancelled = true
    }
  }, [open, period.id])

  // Dates open up only once the check has come back with zero posted
  // vouchers; while checking, or if the check failed, they stay read-only
  // and the sentence below the fields says why. The name is always editable.
  const datesEditable = !isChecking && !countFailed && postedCount === 0

  // A date input yields '' while incomplete and a full YYYY-MM-DD otherwise:
  // only derive a name once both ends are known.
  function updateDates(start: string, end: string) {
    setPeriodStart(start)
    setPeriodEnd(end)
    if (nameFollowsDates && start && end) setName(fiscalYearName(start, end))
  }

  const trimmedName = name.trim()
  const payload: { name?: string; period_start?: string; period_end?: string } = {}
  if (trimmedName && trimmedName !== period.name) payload.name = trimmedName
  if (datesEditable) {
    if (periodStart && periodStart !== period.period_start) payload.period_start = periodStart
    if (periodEnd && periodEnd !== period.period_end) payload.period_end = periodEnd
  }
  const endBeforeStart = datesEditable && !!periodStart && !!periodEnd && periodEnd <= periodStart
  const datesIncomplete = datesEditable && (!periodStart || !periodEnd)
  const isDirty = Object.keys(payload).length > 0
  const canSave =
    isDirty && trimmedName.length > 0 && !endBeforeStart && !datesIncomplete && !isSaving

  function handleOpenChange(nextOpen: boolean) {
    if (isSaving) return
    onOpenChange(nextOpen)
  }

  async function handleSave() {
    if (!canSave) return
    setIsSaving(true)
    setSubmitError(null)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        // The route's refusals (BFL 3 kap. shapes, overlap, posted vouchers)
        // are Swedish domain copy and stay verbatim in both locales.
        setSubmitError(readApiError(body, t('fy_edit_failed_default')))
        return
      }
      toast({ title: t('fy_edit_success') })
      onOpenChange(false)
      onSaved()
    } catch (error) {
      setSubmitError(
        error instanceof Error ? getUserErrorMessage(error) : t('fy_edit_failed_default'),
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('fy_edit_dialog_title')}</DialogTitle>
          <DialogDescription>{t('fy_edit_dialog_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fy-edit-name">{t('fy_edit_name_label')}</Label>
            <Input
              id="fy-edit-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameFollowsDates(false)
              }}
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="fy-edit-start">{t('fy_edit_start_label')}</Label>
              <Input
                id="fy-edit-start"
                type="date"
                value={periodStart}
                disabled={!datesEditable}
                aria-describedby="fy-edit-dates-note"
                onChange={(event) => updateDates(event.target.value, periodEnd)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy-edit-end">{t('fy_edit_end_label')}</Label>
              <Input
                id="fy-edit-end"
                type="date"
                value={periodEnd}
                disabled={!datesEditable}
                aria-describedby="fy-edit-dates-note"
                onChange={(event) => updateDates(periodStart, event.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>

          {/* One quiet sentence on why the dates are read-only, in the
              route's own terms (posted vouchers). */}
          <p id="fy-edit-dates-note" className="text-xs text-muted-foreground">
            {isChecking ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('fy_edit_dates_checking')}
              </span>
            ) : countFailed ? (
              t('fy_edit_dates_check_failed')
            ) : postedCount !== null && postedCount > 0 ? (
              t('fy_edit_dates_blocked_posted', { count: postedCount })
            ) : null}
          </p>

          {endBeforeStart ? (
            <p className="text-xs text-destructive">{t('fy_edit_end_before_start')}</p>
          ) : null}
          {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSaving}>
            {t('fy_confirm_cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('fy_edit_saving')}
              </>
            ) : (
              t('fy_edit_save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
