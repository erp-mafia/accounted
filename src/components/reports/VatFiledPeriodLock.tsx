'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { saveSettingsInDialog } from '@/components/settings/use-save-settings'
import { useCompanySettings } from '@/components/settings/useSettings'
import { useCompany } from '@/contexts/CompanyContext'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { refKeys } from '@/lib/reference-data/keys'
import { cn, formatDate } from '@/lib/utils'
import { filedPeriodLock } from '@/lib/vat/filed-period-lock'
import type { VatFilingRecord } from '@/lib/vat/filing-record'
import type { CompanySettings } from '@/types'

/**
 * The lock state of a filed period, as a part of its filed line on the
 * Moms page (it sits inside that line's paragraph): the books locked
 * through the period is the normal state and reads as muted text; a period
 * whose last day is still open offers "Lås bokföringen t.o.m. <last day>" to
 * an owner or admin, the only ones who may change company settings. Nothing
 * is said when the räkenskapsår already holds the period, or to a member who
 * could not act on it. Never a second attention line: the page's one is
 * VatFiledChangesLine.
 *
 * The offer is where a filing ends, because that is the moment the period is
 * done: both ways of recording a filing (Markera som inlämnad, a signed
 * declaration found at Skatteverket) leave the person on this line.
 *
 * Confirming saves bookkeeping_locked_through through the settings save. It
 * only moves the lock date forward: the stored date is read again first, and
 * one that already covers the period stands. The dialog says what the lock
 * stops, the bokslut of an unclosed räkenskapsår behind it included.
 */
export function VatFiledPeriodLock({ record, periodLabel }: { record: VatFilingRecord; periodLabel: string }) {
  const t = useTranslations('reports')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { company, role } = useCompany()
  const { mutate } = useSWRConfig()
  const { settings, updateSettings } = useCompanySettings()
  const { periods: fiscalYears, isLoading: fiscalYearsLoading } = useFiscalPeriods()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (!settings || fiscalYearsLoading) return null
  const lock = filedPeriodLock(record.period_end, settings.bookkeeping_locked_through, fiscalYears)
  if (lock.state === 'year_shut') return null
  const canLock = role === 'owner' || role === 'admin'
  const lastDay = formatDate(record.period_end)

  // Every way out of the dialog (Avbryt, Esc, a click outside) leaves it as it
  // opens next time: a refusal shown now must not greet the next attempt.
  function close() {
    if (busy) return
    setOpen(false)
    setFailure(null)
  }

  async function lockBooks() {
    setBusy(true)
    setFailure(null)
    try {
      // Judged on the lock date as it is stored now, read again through the
      // settings cache: this page's copy may be older than the row (another
      // person, the automatic lock). A date that already covers the period
      // stands, so the lock never moves back from here.
      const stored = (await mutate(refKeys.companySettings(company?.id ?? null))) as CompanySettings | null | undefined
      const now = filedPeriodLock(record.period_end, (stored ?? settings)?.bookkeeping_locked_through, fiscalYears)
      if (now.state === 'open') {
        const refusal = await saveSettingsInDialog({ bookkeeping_locked_through: now.lockThrough }, locale)
        if (refusal) {
          setFailure(refusal)
          return
        }
        updateSettings({ bookkeeping_locked_through: now.lockThrough })
      }
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {lock.state === 'locked' ? (
        <>
          {' · '}
          {t('vat_filing_books_locked', { date: formatDate(lock.through) })}
        </>
      ) : canLock ? (
        <>
          {' · '}
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setOpen(true)}>
            {t('vat_filing_lock_books', { date: lastDay })}
          </button>
        </>
      ) : null}

      {canLock && (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
          <DialogContent size="confirm">
            <DialogHeader>
              <DialogTitle>{t('vat_lock_books_title', { date: lastDay })}</DialogTitle>
              <DialogDescription className="text-[13px] leading-5">
                {t('vat_lock_books_body', { period: periodLabel })}
                {lock.state === 'open' && lock.openYearEnd && (
                  <> {t('vat_lock_books_open_year', { date: formatDate(lock.openYearEnd) })}</>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogConsequence aria-live="polite" className={cn('tabular-nums', failure && 'text-destructive')}>
                {failure ?? t('vat_lock_books_consequence', { date: lastDay })}
              </DialogConsequence>
              <Button variant="ghost" onClick={close} disabled={busy}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={() => void lockBooks()} loading={busy}>
                {t('vat_lock_books_confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
