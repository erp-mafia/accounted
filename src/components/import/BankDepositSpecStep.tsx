'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { CheckCircleIcon, ExclamationCircleIcon, SpinnerIcon } from '@/components/icons'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { AttachSummary } from '@/lib/import/bgmax/attach'

/** What POST /api/import/bank-file/deposit-specification answers. */
type DepositSpecResponse = AttachSummary & {
  filename: string
  date_from: string | null
  date_to: string | null
  rejected_deposits: number
}

interface BankDepositSpecStepProps {
  /** The BG Max file the bank-file parse recognized (crm#1170). */
  file: File
  onNewImport: () => void
}

/**
 * Bankgirot's deposit specification (BG Max) in the bank-file import: the
 * file creates no bank rows, it attaches each deposit's payments to the row
 * that is the deposit. Shows what would be attached (the route's preview),
 * attaches on one click, and says what is left: deposits whose row has not
 * synced attach when the same file is uploaded again.
 */
export default function BankDepositSpecStep({ file, onNewImport }: BankDepositSpecStepProps) {
  const t = useTranslations('import')
  const [summary, setSummary] = useState<DepositSpecResponse | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(
    async (apply: boolean) => {
      setBusy(true)
      setError(null)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('apply', String(apply))
        const res = await fetch('/api/import/bank-file/deposit-specification', { method: 'POST', body: formData })
        const body = await res.json()
        if (!res.ok) {
          setError(getErrorMessage(body, { statusCode: res.status }))
          return
        }
        setSummary(body.data as DepositSpecResponse)
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [file],
  )

  useEffect(() => {
    void send(false)
  }, [send])

  const unmatched = summary?.outcomes.filter((o) => o.status !== 'matched') ?? []

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div>
          <p className="font-display text-xl">{summary?.applied ? t('bgmax_result_title') : t('bgmax_title')}</p>
          {!summary?.applied && <p className="mt-1 text-sm text-muted-foreground">{t('bgmax_intro')}</p>}
        </div>

        {!summary && busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            {t('bgmax_loading')}
          </div>
        )}

        {error && (
          <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
            <ExclamationCircleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">{t('bgmax_error_title')}</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              {t('bgmax_summary', {
                deposits: summary.deposits,
                payments: summary.payments,
                from: summary.date_from ? formatDate(summary.date_from) : '',
                to: summary.date_to ? formatDate(summary.date_to) : '',
              })}
            </p>
            {summary.applied ? (
              <>
                <div className="flex items-center gap-2">
                  <CheckCircleIcon className="h-4 w-4 flex-shrink-0 text-success" />
                  {t('bgmax_result', { payments: summary.matched_payments, rows: summary.matched_deposits })}
                </div>
                {summary.ready_rows > 0 && <p>{t('bgmax_result_ready', { count: summary.ready_rows })}</p>}
              </>
            ) : summary.matched_deposits > 0 ? (
              <p>{t('bgmax_preview_matched', { payments: summary.matched_payments, rows: summary.matched_deposits })}</p>
            ) : (
              <p>{t('bgmax_preview_none')}</p>
            )}
            {summary.rejected_deposits > 0 && (
              <p className="text-muted-foreground">{t('bgmax_rejected', { count: summary.rejected_deposits })}</p>
            )}
          </div>
        )}

        {unmatched.length > 0 && (
          <div className="space-y-1">
            <ul className="divide-y divide-border rounded-lg border border-border text-[13px]">
              {unmatched.map((o, index) => (
                <li key={`${o.date}-${o.amount}-${index}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="tabular-nums">{formatDate(o.date)}</span>
                  <span className="flex-1 truncate text-muted-foreground">
                    {o.status === 'ambiguous' ? t('bgmax_ambiguous') : t('bgmax_no_row')}
                  </span>
                  <span className="tabular-nums">{formatCurrency(o.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] text-muted-foreground">{t('bgmax_unmatched_note', { count: unmatched.length })}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {summary && !summary.applied && summary.matched_deposits > 0 && (
            <Button onClick={() => void send(true)} loading={busy}>
              {t('bgmax_apply')}
            </Button>
          )}
          {summary?.applied && summary.matched_deposits > 0 && (
            <Button asChild>
              <Link href="/transactions">{t('bgmax_result_link')}</Link>
            </Button>
          )}
          <Button variant="outline" onClick={onNewImport} disabled={busy && Boolean(summary)}>
            {summary?.applied ? t('bgmax_new_import') : t('bgmax_other_file')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
