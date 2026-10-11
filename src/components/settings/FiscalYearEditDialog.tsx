'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
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
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { fiscalYearName, isDerivedFiscalYearName } from '@/lib/bookkeeping/suggest-fiscal-period'
import type { FiscalPeriod } from '@/types'

interface FiscalYearEditDialogProps {
  period: FiscalPeriod
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void
}

/**
 * Edit the name and dates of one OPEN fiscal year (issue #2287). A thin
 * surface over PATCH /api/bookkeeping/fiscal-periods/[id], which allows a
 * rename at any time on an open year and a re-date as long as nothing the
 * year holds is affected (crm#1010: a first year recorded one day late is
 * corrected here even with vouchers posted). The posted count from the
 * entry-count endpoint is shown as information, not a gate: whether the new
 * dates are allowed is decided server-side, by the guarded
 * redate_fiscal_period RPC, and every refusal (which names what blocks, for
 * example the vouchers that would end up outside) is shown verbatim so the
 * user can correct and retry without leaving the dialog. Only changed fields
 * are sent, so a pure rename never runs the date checks.
 */
export function FiscalYearEditDialog({
  period,
  open,
  onOpenChange,
  onSaved,
}: FiscalYearEditDialogProps) {
  const t = useTranslations('settings_bookkeeping')
  const errorLocale = useLocale() as ErrorLocale
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
  const [isSaving, setIsSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadPostedCount() {
      try {
        const response = await fetch(
          `/api/bookkeeping/fiscal-periods/${period.id}/entry-count`,
          { cache: 'no-store' },
        )
        if (!response.ok) return
        const body = (await response.json()) as { data?: { posted_count?: number } }
        if (!cancelled) setPostedCount(body.data?.posted_count ?? 0)
      } catch {
        // Information only: the dates are checked server-side on save.
      }
    }

    void loadPostedCount()
    return () => {
      cancelled = true
    }
  }, [open, period.id])

  // A date input yields '' while incomplete and a full YYYY-MM-DD otherwise:
  // only derive a name once both ends are known.
  function updateDates(start: string, end: string) {
    setPeriodStart(start)
    setPeriodEnd(end)
    if (nameFollowsDates && start && end) setName(fiscalYearName(start, end))
  }

  const trimmedName = name.trim()
  const payload: { name?: string; period_start?: string; period_end?: string } = {}
  // "Changed" compares the raw input with the stored name, so a stored name
  // with stray whitespace does not read as dirty on open; the trimmed value
  // is what gets sent once the user has actually edited it.
  const nameChanged = name !== period.name
  if (nameChanged && trimmedName) payload.name = trimmedName
  if (periodStart && periodStart !== period.period_start) payload.period_start = periodStart
  if (periodEnd && periodEnd !== period.period_end) payload.period_end = periodEnd
  const endBeforeStart = !!periodStart && !!periodEnd && periodEnd <= periodStart
  const datesIncomplete = !periodStart || !periodEnd
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
        // The route's refusals (BFL 3 kap. shapes, overlap, and every blocker
        // redate_fiscal_period names) are Swedish domain copy and stay
        // verbatim in both locales, so the envelope is read without the UI
        // locale: the registry's English for FISCAL_PERIOD_DATES_BLOCKED is
        // written for agents and would replace the named blockers.
        setSubmitError(getUserErrorMessage(body, { fallback: t('fy_edit_failed_default') }))
        return
      }
      toast({ title: t('fy_edit_success') })
      onOpenChange(false)
      onSaved()
    } catch (error) {
      setSubmitError(getUserErrorMessage(error, { locale: errorLocale, fallback: t('fy_edit_failed_default') }))
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
                aria-describedby="fy-edit-dates-note"
                onChange={(event) => updateDates(periodStart, event.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>

          {/* One quiet sentence on what posted vouchers mean for the dates. */}
          <p id="fy-edit-dates-note" className="text-xs text-muted-foreground">
            {postedCount !== null && postedCount > 0
              ? t('fy_edit_dates_posted_note', { count: postedCount })
              : null}
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
          <Button onClick={handleSave} disabled={!canSave} loading={isSaving}>
            {isSaving ? t('fy_edit_saving') : t('fy_edit_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
