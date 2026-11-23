'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  ArrowUpTrayIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  SpinnerIcon,
} from '@/components/icons'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { HOSTED_MAX_UPLOAD_BYTES, isHostedDeployment } from '@/lib/documents/upload-size'
import type { KustomPayout } from '@/lib/webshop-orders/kustom-settlement'

const ACCEPTED_EXTENSIONS = ['.csv', '.txt']

/** POST /api/webshop-orders/kustom-settlement, `data`. */
interface KustomImportResult {
  payout: KustomPayout
  sales: number
  refunds: number
  inserted: number
  updated: number
  unchanged: number
  frozen_flagged: number
  sales_held: number
  returns_held: number
  returns_left_out: { count: number; total: number }
}

/**
 * Kustom settlement report onto the Orders page (the Import page's Kustom
 * row). One file is one payout: its sales and returns land on the Orders
 * page, and the payout's own numbers are shown for booking its bank row.
 */
export default function KustomSettlementImport() {
  const t = useTranslations('import')
  const errorLocale = useLocale() as ErrorLocale
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<KustomImportResult | null>(null)

  const upload = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      const name = file.name.toLowerCase()
      if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return
      // The host refuses a larger body before the route runs, with a plain
      // 413 that says nothing; one payout's report is far below it.
      if (isHostedDeployment() && file.size > HOSTED_MAX_UPLOAD_BYTES) {
        setError(t('kustom_file_too_large', { max: HOSTED_MAX_UPLOAD_BYTES / 1024 / 1024 }))
        return
      }
      setError(null)
      setIsLoading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/webshop-orders/kustom-settlement', { method: 'POST', body: formData })
        const json: unknown = await res.json().catch(() => null)
        if (!res.ok) {
          setError(
            getErrorMessage(json, { statusCode: res.status, locale: errorLocale, fallback: t('kustom_error_title') }),
          )
          return
        }
        setResult((json as { data: KustomImportResult }).data)
      } catch (err) {
        setError(getErrorMessage(err, { locale: errorLocale, fallback: t('kustom_error_title') }))
      } finally {
        setIsLoading(false)
      }
    },
    [errorLocale, t],
  )

  if (result) {
    const { payout } = result
    const money = (amount: number) => formatCurrency(amount, payout.currency)
    // The payout's own terms, each with the sign it has on the payout;
    // a term the report leaves at zero is not shown.
    const lines = (
      [
        [t('kustom_payout_sales'), payout.sales],
        [t('kustom_payout_returns'), -payout.returns],
        [t('kustom_payout_reversals'), -payout.reversals],
        [t('kustom_payout_fees'), -payout.fees],
        [t('kustom_payout_fee_vat'), -payout.feeVat],
        [t('kustom_payout_holdback'), -payout.holdback],
        [t('kustom_payout_release'), payout.release],
        [t('kustom_payout_other'), payout.other],
      ] as Array<[string, number]>
    ).filter(([, amount], i) => i < 2 || amount !== 0)
    return (
      <div className="space-y-6">
        <Card>
          <CardContent>
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <CheckCircleIcon className="h-12 w-12 text-success" />
              <div>
                <p className="text-[15px] font-medium leading-[22px] text-strong">{t('kustom_result_title')}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('kustom_result_summary', { sales: result.sales, refunds: result.refunds, inserted: result.inserted })}
                </p>
                {result.sales_held > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('kustom_result_sales_held', { count: result.sales_held })}
                  </p>
                )}
                {result.returns_held > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('kustom_result_returns_held', { count: result.returns_held })}
                  </p>
                )}
                {result.returns_left_out.count > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('kustom_result_returns_left_out', {
                      count: result.returns_left_out.count,
                      amount: money(result.returns_left_out.total),
                    })}
                  </p>
                )}
                {result.frozen_flagged > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('kustom_result_frozen', { count: result.frozen_flagged })}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {payout.payoutDate
                ? t('kustom_payout_title_dated', { date: formatDate(payout.payoutDate) })
                : t('kustom_payout_title')}
            </CardTitle>
            <CardDescription>{t('kustom_payout_description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1 text-sm">
              {lines.map(([label, amount]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{money(amount)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4 border-t pt-1 font-medium">
                <dt>{t('kustom_payout_settlement')}</dt>
                <dd className="tabular-nums">{money(payout.settlement)}</dd>
              </div>
            </dl>
            {payout.reversals > 0 && (
              <p className="mt-3 text-sm text-muted-foreground">{t('kustom_payout_reversal_note')}</p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/orders">{t('kustom_result_open_orders')}</Link>
          </Button>
          <Button variant="outline" onClick={() => setResult(null)}>
            {t('kustom_result_new_import')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowUpTrayIcon className="h-5 w-5" />
            {t('kustom_upload_title')}
            <HelpPopover className="shrink-0">
              <p>{t('kustom_howto_steps')}</p>
              <p className="mt-2">{t('kustom_howto_note')}</p>
            </HelpPopover>
          </CardTitle>
          <CardDescription>{t('kustom_upload_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FileDropzone
            onFile={upload}
            accept={ACCEPTED_EXTENSIONS.join(',')}
            disabled={isLoading}
            invalid={!!error}
            label={t('kustom_tap_select')}
            className="relative p-8 text-center"
          >
            {isLoading ? (
              <div className="space-y-4">
                <DocumentTextIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t('kustom_reading')}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <ArrowUpTrayIcon className="mx-auto h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="font-medium hidden sm:block">{t('kustom_drop_here')}</p>
                  <p className="font-medium sm:hidden">{t('kustom_tap_select')}</p>
                  <p className="text-sm text-muted-foreground">{t('kustom_file_types')}</p>
                </div>
              </div>
            )}
          </FileDropzone>

          {error && (
            <div className="bg-destructive/8 p-4 rounded-lg flex gap-3">
              <ExclamationCircleIcon className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">{t('kustom_error_title')}</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
