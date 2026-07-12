'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertTriangle, Download, Loader2, CheckCircle2, ChevronDown, Info } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

type PaymentFormat = 'bg_lb' | 'pain001'

interface PaymentFilePanelProps {
  salaryRunId: string
  periodLabel: string
  paymentFileFormat: string | null
  paymentFileGeneratedAt: string | null
  defaultFormat: PaymentFormat
  /** company_settings.salary_default_bank: sorts and auto-expands the matching bank's instructions. */
  defaultBank?: string | null
  readOnly?: boolean
  onDownloaded?: () => void
}

type BankKey = 'swedbank' | 'seb' | 'handelsbanken' | 'nordea'

const BANK_NAME: Record<BankKey, string> = {
  swedbank: 'Swedbank',
  seb: 'SEB',
  handelsbanken: 'Handelsbanken',
  nordea: 'Nordea',
}

// Instruction copy lives in messages/{sv,en}.json under
// salary_payments.steps_<format>_<bank>; this is the ordered key list.
const BANKS_BY_FORMAT: Record<PaymentFormat, BankKey[]> = {
  bg_lb: ['swedbank', 'seb', 'handelsbanken', 'nordea'],
  pain001: ['swedbank', 'seb', 'handelsbanken', 'nordea'],
}

export function PaymentFilePanel({
  salaryRunId,
  periodLabel,
  paymentFileFormat,
  paymentFileGeneratedAt,
  defaultFormat,
  defaultBank,
  readOnly,
  onDownloaded,
}: PaymentFilePanelProps) {
  const t = useTranslations('salary_payments')
  const { toast } = useToast()
  const [format, setFormat] = useState<PaymentFormat>(defaultFormat)
  const [downloading, setDownloading] = useState(false)

  const banks = BANKS_BY_FORMAT[format]
  const matchedBank = banks.find((b) => b === defaultBank) ?? null
  const sortedBanks = matchedBank
    ? [matchedBank, ...banks.filter((b) => b !== matchedBank)]
    : banks
  const [showInstructions, setShowInstructions] = useState(Boolean(matchedBank))

  const FORMAT_LABEL: Record<PaymentFormat, string> = {
    bg_lb: t('format_bg_lb'),
    pain001: t('format_pain001'),
  }

  const endpoint =
    format === 'bg_lb'
      ? `/api/salary/runs/${salaryRunId}/payment/bg-lb`
      : `/api/salary/runs/${salaryRunId}/payment/pain001`

  async function handleDownload() {
    setDownloading(true)
    try {
      const res = await fetch(endpoint)
      if (!res.ok) {
        const result = await res.json().catch(() => ({ error: t('download_failed_fallback') }))
        toast({
          title: t('download_failed_title'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = format === 'bg_lb' ? 'txt' : 'xml'
      a.download = `lon_${periodLabel}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: t('downloaded') })
      onDownloaded?.()
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {paymentFileFormat && paymentFileGeneratedAt && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-success" />
            <div>
              {t('last_generated')}{' '}
              <span className="text-foreground">
                {FORMAT_LABEL[paymentFileFormat as PaymentFormat] ?? paymentFileFormat}
              </span>{' '}
              ({new Date(paymentFileGeneratedAt).toLocaleString('sv-SE')})
            </div>
          </div>
        )}

        {!readOnly && (
          <>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t('format_label')}</label>
              <Select value={format} onValueChange={(v) => setFormat(v as PaymentFormat)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pain001">{FORMAT_LABEL.pain001}</SelectItem>
                  <SelectItem value="bg_lb">{FORMAT_LABEL.bg_lb}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {format === 'bg_lb' ? t('format_description_bg_lb') : t('format_description_pain001')}
              </p>
            </div>

            {format === 'bg_lb' && (
              <div className="flex items-start gap-2 rounded-md border border-border p-3 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="text-muted-foreground">
                  {t('sunset_warning')}{' '}
                  <Link
                    href="/settings/salary"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {t('sunset_link')}
                  </Link>
                </span>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleDownload} disabled={downloading}>
                {downloading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {t('download')}
              </Button>
            </div>

            <button
              type="button"
              onClick={() => setShowInstructions(s => !s)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showInstructions}
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-180' : ''}`} />
              {t('instructions_toggle')}
            </button>

            {showInstructions && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
                {sortedBanks.map((bank) => (
                  <div key={bank}>
                    <strong className="text-foreground">
                      {BANK_NAME[bank]}
                      {bank === matchedBank ? ` (${t('your_bank')})` : ''}.
                    </strong>{' '}
                    <span className="text-muted-foreground">
                      {t(`steps_${format}_${bank}`)}
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-muted-foreground border-t mt-2">
                  {t('instructions_footer')}
                </p>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{t('open_payments_note')}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
