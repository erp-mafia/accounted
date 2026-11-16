'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { resultSentenceKey, summariseSendResults, type PickedSendResult } from '@/lib/reminders/turn-on'
import { cn } from '@/lib/utils'

/**
 * What a picked send did, one sentence per invoice. Invoices the bank check
 * held back (no bank synced in 24 hours) can go again once the person ticks
 * that they checked the invoice is unpaid: that answer replaces the first.
 */
export function ReminderSendResults({
  results,
  describe,
  canWrite,
  onAttestedRetry,
}: {
  results: readonly PickedSendResult[]
  /** Names an invoice in its row (customer and number); left out for a single invoice. */
  describe?: (invoiceId: string) => string
  canWrite: boolean
  onAttestedRetry: (invoiceIds: string[]) => Promise<void>
}) {
  const t = useTranslations('reminders_setup')
  const [attested, setAttested] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const summary = summariseSendResults(results)
  const notSent = summary.skipped + summary.failed
  const retryCount = summary.bankRetryIds.length

  const sentence = (result: PickedSendResult) => {
    const key = resultSentenceKey(result)
    if (key !== 'result_sent') return t(key)
    const level = result.level
    return t('result_sent', { name: level ? t(`level_name_${level}`) : t('level_name_unknown') })
  }

  async function retry() {
    setRetrying(true)
    try {
      await onAttestedRetry(summary.bankRetryIds)
      setAttested(false)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <section className="space-y-3" aria-live="polite">
      {results.length > 1 && (
        <p className="text-[13px]">
          {t('results_sent', { count: summary.sent })}
          {notSent > 0 && <> {t('results_not_sent', { count: notSent })}</>}
        </p>
      )}
      <ul className="divide-y divide-border border-y border-border">
        {results.map((result) => (
          <li key={result.invoice_id} className="py-2 text-[13px]">
            {describe && (
              <span className="block truncate" data-ph-mask="">
                {describe(result.invoice_id)}
              </span>
            )}
            <span
              className={cn(
                'block',
                describe && 'text-xs',
                result.status === 'failed' ? 'text-destructive' : result.status === 'skipped' && 'text-muted-foreground',
              )}
            >
              {sentence(result)}
            </span>
          </li>
        ))}
      </ul>
      {retryCount > 0 && canWrite && (
        <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
          <label className="flex items-start gap-3 text-[13px]">
            <Checkbox
              checked={attested}
              onCheckedChange={(next) => setAttested(next === true)}
              disabled={retrying}
              className="mt-0.5"
            />
            <span>{t('bank_retry_attest', { count: retryCount })}</span>
          </label>
          <Button variant="outline" disabled={!attested} loading={retrying} onClick={() => void retry()}>
            {t('bank_retry_send', { count: retryCount })}
          </Button>
        </div>
      )}
    </section>
  )
}
