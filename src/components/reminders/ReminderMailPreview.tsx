'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ReminderLevel } from '@/lib/reminders/policy'
import type { ReminderPreview } from '@/lib/reminders/preview'
import { errorLocale, fetchReminderPreview, type ReminderCall } from './reminders-client'

/** Height of the mail frame: about one screen of a reminder mail. */
const FRAME_CLASS = 'h-[420px] w-full rounded-lg bg-control shadow-raised'

/**
 * The reminder mail for one invoice (or, without one, the company's latest
 * overdue invoice) at a level, or at the level a pick would send. Each
 * answer is kept per invoice, level and attempt, so switching back to a
 * level shows it at once; a retry asks again.
 */
export function useReminderPreview(invoiceId: string | undefined, level: ReminderLevel | undefined, enabled = true) {
  const locale = errorLocale(useLocale())
  const [attempt, setAttempt] = useState(0)
  const [reads, setReads] = useState<Readonly<Record<string, ReminderCall<ReminderPreview>>>>({})
  const key = `${locale}|${invoiceId ?? ''}|${level ?? ''}|${attempt}`
  const known = Object.hasOwn(reads, key)

  useEffect(() => {
    if (!enabled || known) return
    let cancelled = false
    void fetchReminderPreview(locale, { invoiceId, level }).then((result) => {
      if (!cancelled) setReads((previous) => ({ ...previous, [key]: result }))
    })
    return () => {
      cancelled = true
    }
  }, [enabled, known, key, locale, invoiceId, level])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { result: enabled && known ? reads[key] : null, retry }
}

/**
 * The subject over the mail itself, in a frame with an empty sandbox: the
 * template's HTML runs no script and opens no link from here.
 */
export function ReminderMailPreview({
  result,
  onRetry,
}: {
  result: ReminderCall<ReminderPreview> | null
  onRetry: () => void
}) {
  const t = useTranslations('reminders_setup')

  if (!result) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className={FRAME_CLASS} />
      </div>
    )
  }
  if (!result.ok) {
    if (result.code === 'REMINDER_NO_INVOICE_TO_PREVIEW') {
      return <p className="text-[13px] text-muted-foreground">{t('preview_no_invoice')}</p>
    }
    return (
      <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <span>{result.message}</span>
        <Button variant="outline" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="break-words text-[13px]">
        <span className="text-muted-foreground">{t('preview_subject')}</span>{' '}
        <span data-ph-mask="">{result.data.subject}</span>
      </p>
      <iframe
        title={t('preview_frame_title')}
        srcDoc={result.data.html}
        sandbox=""
        data-ph-mask=""
        className={FRAME_CLASS}
      />
    </div>
  )
}
