'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Download, Loader2, CheckCircle2, ExternalLink } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'

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

  const totalAmount = Math.round((totalTax + totalAvgifter) * 100) / 100

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(`/api/skatteverket/tax-payments/${period}/payment-file`)
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: t('tax_download_failed_fallback') }))
        toast({
          title: t('tax_download_failed_title'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bg_lb_skatt_${period}.txt`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: t('tax_downloaded') })
      onChange?.()
    } finally {
      setDownloading(false)
    }
  }, [period, toast, onChange, t])

  const handleMarkPaid = useCallback(async () => {
    setMarking(true)
    try {
      const res = await fetch(`/api/skatteverket/tax-payments/${period}/mark-paid`, {
        method: 'POST',
      })
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: t('tax_mark_paid_failed_fallback') }))
        toast({
          title: t('tax_mark_paid_failed_title'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('tax_marked_paid') })
      onChange?.()
    } finally {
      setMarking(false)
    }
  }, [period, toast, onChange, t])

  if (totalAmount <= 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('tax_title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('tax_label_tax')}</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalTax)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('tax_label_avgifter')}</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalAvgifter)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('tax_label_total')}</p>
            <p className="font-semibold tabular-nums">{formatCurrency(totalAmount)}</p>
          </div>
        </div>

        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            {t('tax_recipient')} <span className="text-foreground">{t('tax_recipient_value')}</span>
          </p>
          <p>
            {t('tax_due_date')} <span className="text-foreground tabular-nums">{paymentDeadline}</span>
          </p>
          <p className="text-xs">
            {t('tax_ocr_note')}
          </p>
        </div>

        {paymentFileGeneratedAt && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-success" />
            <div>
              {t('tax_file_generated')}{' '}
              <span className="text-foreground">
                {new Date(paymentFileGeneratedAt).toLocaleString('sv-SE')}
              </span>
            </div>
          </div>
        )}

        {taxPaidAt && (
          <div className="flex items-start gap-2 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 mt-0.5" />
            <div>
              {t('tax_marked_paid')}{' '}
              <span className="font-medium">{new Date(taxPaidAt).toLocaleString('sv-SE')}</span>
            </div>
          </div>
        )}

        {!readOnly && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://www.skatteverket.se/foretag/skatterochavdrag/skattekonto.4.18e1b10334ebe8bc80004481.html"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('tax_skattekonto_button')}
              </a>
            </Button>
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
      </CardContent>
    </Card>
  )
}
