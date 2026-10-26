'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ExclamationTriangleIcon, SpinnerIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { formatDate } from '@/lib/utils'
import type { FiscalYearReopenBlocker, FiscalYearReopenEligibility } from '@/types'

interface FiscalYearReopenDialogProps {
  periodId: string
  periodName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful reopen so the parent can refetch. */
  onReopened: () => void
}

/**
 * The owner reopens a year closed with a bokslut in Accounted (crm#1290).
 * Same shape as FiscalYearResetDialog: a preview with the gates that refuse
 * it, what the reopen does (the verifikat it reverses by storno, the unsigned
 * årsredovisning it supersedes), and a typed confirmation: the owner's
 * statement about the årsredovisning plus the year's name. Every gate and the
 * confirmation are enforced again server-side.
 */
export function FiscalYearReopenDialog({
  periodId,
  periodName,
  open,
  onOpenChange,
  onReopened,
}: FiscalYearReopenDialogProps) {
  const t = useTranslations('settings_bookkeeping')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const loadFailedMessage = t('fy_reopen_closed_load_failed')
  const [eligibility, setEligibility] = useState<FiscalYearReopenEligibility | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isReopening, setIsReopening] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [confirmedStatement, setConfirmedStatement] = useState(false)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadEligibility() {
      setIsLoading(true)
      setLoadError(null)
      setEligibility(null)
      try {
        const response = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/reopen`, {
          cache: 'no-store',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          if (!cancelled) {
            setLoadError(getUserErrorMessage(body, { locale: errorLocale, fallback: loadFailedMessage }))
          }
          return
        }
        if (!cancelled) setEligibility(body.data as FiscalYearReopenEligibility)
      } catch (error) {
        if (!cancelled) {
          setLoadError(getUserErrorMessage(error, { locale: errorLocale, fallback: loadFailedMessage }))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadEligibility()
    return () => {
      cancelled = true
    }
  }, [periodId, errorLocale, loadFailedMessage, open])

  function resetForm() {
    setEligibility(null)
    setLoadError(null)
    setConfirmName('')
    setConfirmedStatement(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isReopening) return
    onOpenChange(nextOpen)
    if (!nextOpen) resetForm()
  }

  function blockerMessage(blocker: FiscalYearReopenBlocker): string {
    switch (blocker.code) {
      case 'not_closed_with_bokslut':
        return t('fy_reopen_closed_blocker_not_closed_with_bokslut')
      case 'closed_externally':
        return t('fy_reopen_closed_blocker_closed_externally')
      case 'annual_report_submitted':
        return t('fy_reopen_closed_blocker_annual_report_submitted')
      case 'annual_report_signed':
        return t('fy_reopen_closed_blocker_annual_report_signed')
      case 'later_year_closed':
        return t('fy_reopen_closed_blocker_later_year_closed')
      case 'next_year_locked':
        return t('fy_reopen_closed_blocker_next_year_locked', { name: blocker.name ?? '' })
      case 'company_lock_date':
        return t('fy_reopen_closed_blocker_company_lock_date', { date: blocker.date ?? '' })
      case 'registry_unavailable':
        return t('fy_reopen_closed_blocker_registry_unavailable')
      case 'annual_report_registered':
        return t('fy_reopen_closed_blocker_annual_report_registered')
      case 'form_not_supported':
        return t('fy_reopen_closed_blocker_form_not_supported')
      default:
        return t('fy_reopen_closed_blocker_other')
    }
  }

  const confirmationName = eligibility?.period.name ?? periodName
  const canReopen =
    eligibility?.eligible === true &&
    confirmedStatement &&
    confirmName.trim() === confirmationName.trim() &&
    !isReopening

  async function handleReopen() {
    if (!canReopen) return
    setIsReopening(true)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_name: confirmName,
          confirm_annual_report_not_adopted: confirmedStatement,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast({
          title: t('fy_reopen_closed_failed_title'),
          description: getUserErrorMessage(body, { locale: errorLocale, fallback: t('fy_reopen_closed_failed_default') }),
          variant: 'destructive',
        })
        setIsReopening(false)
        // A run that stopped midway is resumable: the year is open now, so
        // the parent's list must show it as it is.
        onReopened()
        return
      }

      toast({
        title: t('fy_reopen_closed_success_title', { name: confirmationName }),
        description: t('fy_reopen_closed_success_description'),
      })
      setIsReopening(false)
      onOpenChange(false)
      resetForm()
      onReopened()
    } catch (error) {
      toast({
        title: t('fy_reopen_closed_failed_title'),
        description: getUserErrorMessage(error, { locale: errorLocale, fallback: t('fy_reopen_closed_failed_default') }),
        variant: 'destructive',
      })
      setIsReopening(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('fy_reopen_closed_dialog_title', { name: periodName })}</DialogTitle>
          <DialogDescription>{t('fy_reopen_closed_dialog_description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <SpinnerIcon className="mr-2 h-4 w-4 animate-spin" />
            {t('fy_reopen_closed_checking')}
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
                  <ExclamationTriangleIcon className="h-4 w-4" />
                  {t('fy_reopen_closed_blocked_title')}
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {eligibility.blockers.map((blocker) => (
                    <li key={blocker.code}>{blockerMessage(blocker)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-medium">{t('fy_reopen_closed_summary_heading')}</h3>
              <dl className="divide-y divide-border border-y border-border">
                <div className="flex items-center justify-between py-2 text-sm">
                  <dt className="text-muted-foreground">{t('fy_reopen_closed_summary_year')}</dt>
                  <dd className="font-medium">
                    {eligibility.period.name}
                    <span className="ml-2 text-muted-foreground tabular-nums">
                      {formatDate(eligibility.period.period_start)} -{' '}
                      {formatDate(eligibility.period.period_end)}
                    </span>
                  </dd>
                </div>
                {eligibility.entries.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between py-2 text-sm">
                    <dt className="text-muted-foreground">
                      {t('fy_reopen_closed_summary_reversed')}: {t(`fy_reopen_closed_entry_${entry.kind}`)}
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {entry.voucher_series ?? 'A'}
                      {entry.voucher_number} · {formatDate(entry.entry_date)}
                    </dd>
                  </div>
                ))}
              </dl>
              {eligibility.resume ? (
                <p className="mt-2 text-xs text-muted-foreground">{t('fy_reopen_closed_resume_note')}</p>
              ) : null}
              {eligibility.annual_report.versions_to_supersede > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">{t('fy_reopen_closed_annual_report_note')}</p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">{t('fy_reopen_closed_tax_note')}</p>
            </div>

            {eligibility.annual_report.agm_date ? (
              <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  {t('fy_reopen_closed_agm_warning', { date: formatDate(eligibility.annual_report.agm_date) })}
                </span>
              </div>
            ) : null}

            {eligibility.eligible ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="fy-reopen-statement"
                    checked={confirmedStatement}
                    onCheckedChange={(checked) => setConfirmedStatement(checked === true)}
                  />
                  <Label htmlFor="fy-reopen-statement" className="font-normal leading-5">
                    {t('fy_reopen_closed_confirm_statement', { name: confirmationName })}
                  </Label>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fy-reopen-name">
                    {t.rich('fy_reopen_closed_confirm_name', {
                      name: confirmationName,
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </Label>
                  <Input
                    id="fy-reopen-name"
                    value={confirmName}
                    onChange={(event) => setConfirmName(event.target.value)}
                    placeholder={confirmationName}
                    autoComplete="off"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isReopening}>
            {t('fy_confirm_cancel')}
          </Button>
          {eligibility?.eligible ? (
            <Button variant="destructive" onClick={handleReopen} disabled={!canReopen} loading={isReopening}>
              {isReopening ? t('fy_reopen_closed_submitting') : t('fy_reopen_closed_submit')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
