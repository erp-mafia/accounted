'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Download, Loader2, CheckCircle2, ExternalLink } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { postAction } from '@/lib/browser/post-action'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { roundOre } from '@/lib/money'

interface TaxPaymentPanelProps {
  /** YYYY-MM */
  period: string
  totalTax: number
  totalAvgifter: number
  paymentFileGeneratedAt: string | null
  taxPaidAt: string | null
  readOnly?: boolean
  onChange?: () => void
}

/**
 * Generates a Bankgirot LB-fil for paying skatt + arbetsgivaravgifter for an
 * AGI period to Skatteverket Bankgiro 5050-1055 with the company's
 * Skattekontot OCR.
 */
export function TaxPaymentPanel({
  period,
  totalTax,
  totalAvgifter,
  paymentFileGeneratedAt,
  taxPaidAt,
  readOnly,
  onChange,
}: TaxPaymentPanelProps) {
  const t = useTranslations('salary_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [downloading, setDownloading] = useState(false)
  const [marking, setMarking] = useState(false)
  const [paymentDeadline, setPaymentDeadline] = useState<string>('')

  useEffect(() => {
    const m = /^(\d{4})-(\d{2})$/.exec(period)
    if (!m) return
    const year = parseInt(m[1], 10)
    const month = parseInt(m[2], 10)
    const dlMonth = month === 12 ? 1 : month + 1
    const dlYear = month === 12 ? year + 1 : year
    setPaymentDeadline(`${dlYear}-${String(dlMonth).padStart(2, '0')}-12`)
  }, [period])

  // The page passes the AGI declaration's stored totals when the AGI exists
  // (whole kronor for declarations generated since the whole-krona change:
  // exactly what the payment file pays and Skatteverket draws), falling back
  // to run totals. Display what will actually be paid: no reformatting here,
  // so legacy öre declarations still show the öre-exact amount their
  // payment file pays.
  const totalAmount = roundOre(totalTax + totalAvgifter)

  const handleDownload = useCallback(async () => {
    // Both buttons are disabled while either is in flight; this guard closes the
    // double-click race before React has re-rendered them. A second file for the
    // same period is a second payable instruction to Skattekontot.
    if (downloading || marking) return
    setDownloading(true)
    try {
      // Bounded, and no file is written unless the server answered 2xx with a
      // complete body: an error envelope saved as bg_lb_skatt_2026-04.txt is a
      // file the user would upload to the bank before discovering it pays no tax.
      const result = await downloadFile({
        url: `/api/skatteverket/tax-payments/${period}/payment-file`,
        filename: `bg_lb_skatt_${period}.txt`,
        locale,
      })
      // Exactly one toast per outcome: TOAST_LIMIT is 1.
      if (!result.ok) {
        toast({
          title: t('tax_download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('tax_downloaded') })
      onChange?.()
    } finally {
      setDownloading(false)
    }
  }, [period, toast, onChange, t, locale, downloading, marking])

  const handleMarkPaid = useCallback(async () => {
    if (downloading || marking) return
    setMarking(true)
    try {
      const result = await postAction({
        url: `/api/skatteverket/tax-payments/${period}/mark-paid`,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('tax_mark_paid_failed_title'),
          description: failureDescription(result, {
            // A timeout on a write is genuinely ambiguous: the update may have
            // landed. Say that instead of claiming it failed.
            timeout: t('tax_mark_paid_timeout'),
            network: t('tax_mark_paid_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('tax_marked_paid') })
      onChange?.()
    } finally {
      setMarking(false)
    }
  }, [period, toast, onChange, t, locale, downloading, marking])

  if (totalAmount <= 0) return null

  return (
    <DetailSection
      kicker={t('tax_title')}
      help={<HelpPopover>{t('tax_ocr_note')}</HelpPopover>}
      aside={
        !readOnly ? (
          // Quiet action on the kicker line: the skattekonto at Skatteverket
          // is where the payment lands, not something this page does.
          <a
            href="https://www.skatteverket.se/foretag/skatterochavdrag/skattekonto.4.18e1b10334ebe8bc80004481.html"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(QUIET_LINK_CLASS, 'inline-flex items-center gap-1')}
          >
            {t('tax_skattekonto_button')}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : undefined
      }
    >
      <div>
        <DefRow label={t('tax_label_tax')}>
          <span className="tabular-nums">{formatCurrency(totalTax)}</span>
        </DefRow>
        <DefRow label={t('tax_label_avgifter')}>
          <span className="tabular-nums">{formatCurrency(totalAvgifter)}</span>
        </DefRow>
        <DefRow label={t('tax_label_total')}>
          <span className="font-medium tabular-nums">{formatCurrency(totalAmount)}</span>
        </DefRow>
        <DefRow label={t('tax_recipient')}>{t('tax_recipient_value')}</DefRow>
        <DefRow label={t('tax_due_date')}>
          <span className="tabular-nums">{paymentDeadline}</span>
        </DefRow>
        {paymentFileGeneratedAt && (
          <DefRow label={t('tax_file_generated')}>
            <span className="tabular-nums">{formatDateTime(paymentFileGeneratedAt)}</span>
          </DefRow>
        )}
        {taxPaidAt && (
          <DefRow label={t('tax_marked_paid')}>
            <span className="tabular-nums">{formatDateTime(taxPaidAt)}</span>
          </DefRow>
        )}
      </div>

      {!readOnly && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button onClick={handleDownload} disabled={downloading || marking}>
            {downloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {t('tax_download_button')}
          </Button>
          {!taxPaidAt && (
            <Button
              variant="outline"
              onClick={handleMarkPaid}
              disabled={downloading || marking}
            >
              {marking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              {t('tax_mark_paid_button')}
            </Button>
          )}
        </div>
      )}
    </DetailSection>
  )
}
