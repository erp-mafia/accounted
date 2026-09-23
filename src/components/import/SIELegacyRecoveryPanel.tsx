'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { SlideOver, SlideOverBody, SlideOverClose, SlideOverContent, SlideOverFooter } from '@/components/ui/slide-over'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { legacySIENextStep, type SIELegacyRecoveryAssessment } from '@/lib/import/sie-legacy-recovery'
import { formatDate } from '@/lib/utils'

/** Show advisory legacy-year evidence without enabling any bookkeeping action. */
export default function SIELegacyRecoveryPanel({ importId, filename, onClose, onCloseAutoFocus }: {
  importId: string
  filename: string
  onClose: () => void
  onCloseAutoFocus: () => void
}) {
  const t = useTranslations('import.sie_recovery')
  const userLocale = useLocale()
  const locale = userLocale === 'en' ? 'en' : 'sv'
  const [assessment, setAssessment] = useState<SIELegacyRecoveryAssessment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`/api/import/sie/${importId}/recovery`, { signal: controller.signal })
        const payload = await response.json()
        if (controller.signal.aborted) return
        if (!response.ok) {
          setError(getErrorMessage(payload, { locale }))
          return
        }
        setError(null)
        setAssessment(payload.data)
      } catch (err) {
        if (!controller.signal.aborted) setError(getErrorMessage(err, { locale }))
      }
    })()
    return () => controller.abort()
  }, [importId, attempt, locale])

  const period = assessment?.period
  return (
    <SlideOver open onOpenChange={open => { if (!open) onClose() }}>
      <SlideOverContent onCloseAutoFocus={event => {
        event.preventDefault()
        onCloseAutoFocus()
      }}>
        <div className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle className="font-display text-lg leading-6">{t('title')}</DialogTitle>
          <DialogDescription data-ph-mask="" className="mt-2 break-words">{filename}</DialogDescription>
        </div>
        <SlideOverBody className="space-y-6">
          {error ? (
            <div className="space-y-3" role="alert">
              <p className="text-sm">{t('loadError')}</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" className="min-h-10" onClick={() => {
                setError(null)
                setAssessment(null)
                setAttempt(value => value + 1)
              }}>{t('refresh')}</Button>
            </div>
          ) : !assessment ? (
            <div role="status" aria-label={t('loading')} className="space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              <p className="text-sm leading-6">{t('reviewRequired')}</p>
              <p className="text-sm text-muted-foreground">{t(`resolution.${assessment.periodResolution}`)}</p>
              {period && assessment.entries && (
                <section className="space-y-3" aria-label={t('periodEntries')}>
                  <h3 className="text-sm tabular-nums">{formatDate(period.period_start)} / {formatDate(period.period_end)}</h3>
                  <p className="text-sm text-muted-foreground">{t('periodScope')}</p>
                  <dl className="divide-y divide-border text-sm">
                    {([
                      ['allEntries', assessment.entries.all],
                      ['postedEntries', assessment.entries.posted],
                      ['importEntries', assessment.entries.importOrOpening],
                    ] as const).map(([label, count]) => (
                      <div key={label} className="flex items-start justify-between gap-4 py-3">
                        <dt>{t(label)}</dt><dd className="tabular-nums">{count.toLocaleString(locale)}</dd>
                      </div>
                    ))}
                    <div className="flex items-start justify-between gap-4 py-3">
                      <dt>{t('periodState')}</dt>
                      <dd>{t(period.is_closed ? 'closed' : period.locked_at ? 'locked' : 'open')}</dd>
                    </div>
                  </dl>
                  {period.import_hold && (
                    <p className="text-sm">
                      {t('importHold')}{' '}
                      <Link href={`/import?mode=sie&job=${period.import_hold}`} className="underline underline-offset-4">{t('openJob')}</Link>
                    </p>
                  )}
                </section>
              )}
              <dl className="divide-y divide-border text-sm">
                <div className="space-y-1 py-3">
                  <dt className="font-medium">{t('companyLock')}</dt>
                  <dd className="text-muted-foreground">{!assessment.companyLock.known ? t('unknown') :
                    assessment.companyLock.through ? formatDate(assessment.companyLock.through) : t('noCompanyLock')}</dd>
                </div>
                <div className="space-y-1 py-3">
                  <dt className="font-medium">{t('archive')}</dt>
                  <dd className="text-muted-foreground">{t(assessment.hasArchiveReference ? 'archiveReferenced' : 'archiveMissing')}</dd>
                </div>
              </dl>
              {legacySIENextStep(assessment) === 'reset_year' ? (
                <p className="text-sm leading-6 text-muted-foreground">
                  {t('nextStepResetYear')}{' '}
                  <Link href="/settings/bookkeeping" className="underline underline-offset-4">{t('openFiscalYears')}</Link>
                </p>
              ) : (
                <p className="text-sm leading-6 text-muted-foreground">{t('nextStep')}</p>
              )}
            </>
          )}
        </SlideOverBody>
        <SlideOverFooter>
          <SlideOverClose asChild><Button variant="outline" className="min-h-10">{t('close')}</Button></SlideOverClose>
        </SlideOverFooter>
      </SlideOverContent>
    </SlideOver>
  )
}
