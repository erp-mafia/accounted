'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import { formatCurrency } from '@/lib/utils'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import type { VatDeclarationRutor } from '@/types'

type PaymentFormat = 'bg_lb' | 'pain001'

interface TaxPaymentPreview {
  paymentDate: string
  agi: { amount: number } | null
  vat: { amount: number } | null
  totalAmount: number
}

export function VatTaxPaymentCard({
  queryString,
  rutor,
  defaultFormat = 'pain001',
}: {
  queryString: string
  rutor: VatDeclarationRutor
  defaultFormat?: PaymentFormat
}) {
  const t = useTranslations('salary_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [format, setFormat] = useState<PaymentFormat>(defaultFormat)
  const [downloading, setDownloading] = useState(false)
  const [preview, setPreview] = useState<TaxPaymentPreview | null>(null)
  const vatAmount = preview?.vat?.amount ?? buildFiledAmounts(rutor).net
  const agiAmount = preview?.agi?.amount ?? 0
  const amount = preview?.totalAmount ?? vatAmount

  useEffect(() => {
    let active = true
    fetch(`/api/skatteverket/vat-payments/payment-file?${queryString}&preview=true`)
      .then(async (response) => response.ok ? response.json() as Promise<{ data: TaxPaymentPreview }> : null)
      .then((body) => {
        if (active && body) setPreview(body.data)
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [queryString])

  const handleDownload = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const filename = format === 'pain001' ? 'pain001_moms.xml' : 'bg_lb_moms.txt'
      const result = await downloadFile({
        url: `/api/skatteverket/vat-payments/payment-file?${queryString}&format=${format}`,
        filename,
        locale,
      })
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
      toast({ title: t('vat_tax_downloaded') })
    } finally {
      setDownloading(false)
    }
  }, [downloading, format, locale, queryString, t, toast])

  if (amount <= 0) return null

  return (
    <DetailSection
      kicker={t('tax_title')}
      help={<HelpPopover>{t('vat_tax_ocr_note')}</HelpPopover>}
    >
      <div>
        <DefRow label={t('tax_label_vat')}>
          <span className="tabular-nums">{formatCurrency(vatAmount)}</span>
        </DefRow>
        {agiAmount > 0 && (
          <DefRow label={t('tax_label_agi')}>
            <span className="tabular-nums">{formatCurrency(agiAmount)}</span>
          </DefRow>
        )}
        <DefRow label={t('tax_label_total')}>
          <span className="font-medium tabular-nums">{formatCurrency(amount)}</span>
        </DefRow>
        <DefRow label={t('tax_recipient')}>{t('tax_recipient_value')}</DefRow>
        {preview?.paymentDate && (
          <DefRow label={t('tax_due_date')}>
            <span className="tabular-nums">{preview.paymentDate}</span>
          </DefRow>
        )}
        <DefRow label={t('format_label')}>
          <SettingsSelect
            aria-label={t('format_label')}
            value={format}
            onChange={(event) => setFormat(event.target.value as PaymentFormat)}
            wrapperClassName="-my-1"
          >
            <option value="pain001">{t('format_pain001')}</option>
            <option value="bg_lb">{t('format_bg_lb')}</option>
          </SettingsSelect>
        </DefRow>
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={handleDownload} disabled={downloading}>
          {downloading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          {t('tax_download_button')}
        </Button>
      </div>
    </DetailSection>
  )
}
