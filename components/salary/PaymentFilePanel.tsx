'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { Download, Loader2, ChevronDown } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { cn, formatDateTime } from '@/lib/utils'
import type { ErrorLocale } from '@/lib/errors/get-error-message'

type PaymentFormat = 'bg_lb' | 'pain001'

interface PaymentFilePanelProps {
  salaryRunId: string
  periodLabel: string
  paymentFileFormat: string | null
  paymentFileGeneratedAt: string | null
  defaultFormat: PaymentFormat
  /** company_settings.salary_default_bank: sorts and auto-expands the matching bank's instructions. */
  defaultBank?: string | null
  /**
   * company_settings.bankgiro / iban: the sender account each format requires.
   * null means missing as of the latest settings fetch (warn up front, the
   * download would 400); undefined means unknown (settings not loaded), so no
   * warning is shown. The caller must refetch after detours that can fix the
   * setting (the warning links into the settings modal over this page).
   */
  senderBankgiro?: string | null
  senderIban?: string | null
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
  senderBankgiro,
  senderIban,
  readOnly,
  onDownloaded,
}: PaymentFilePanelProps) {
  const t = useTranslations('salary_payments')
  const locale = useLocale() as ErrorLocale
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

  // The sender account lives in company_settings, not in the Bolagsverket
  // snapshot shown on the settings overview: users see a bankgiro there and
  // reasonably believe it is configured. Say the precondition here, before
  // the download 400s on it.
  const senderMissing =
    (format === 'bg_lb' && senderBankgiro === null) ||
    (format === 'pain001' && senderIban === null)

  async function handleDownload() {
    // The button is disabled while a file is in flight; this guard closes the
    // double-click / Enter-repeat race before React has re-rendered it. Two
    // payment files for one salary run is not a cosmetic problem: each one is
    // payable on its own, so a user who uploads both to the bank pays the
    // month's wages twice.
    if (downloading) return
    setDownloading(true)
    try {
      const ext = format === 'bg_lb' ? 'txt' : 'xml'
      // Bounded, and no file is written unless the server answered 2xx with a
      // complete body: an error envelope saved as lon_2026-04.xml is a file the
      // user would carry to the bank before discovering it pays nobody.
      const result = await downloadFile({
        url: endpoint,
        filename: `lon_${periodLabel}.${ext}`,
        locale,
      })
      // Exactly one toast per outcome. TOAST_LIMIT is 1, so a failure toast
      // followed by a success toast in the same tick would render only the last.
      if (!result.ok) {
        toast({
          title: t('download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('downloaded') })
      onDownloaded?.()
    } finally {
      setDownloading(false)
    }
  }

  // The flow looked clean all the way until the bank said no: the file
  // downloads fine and only fails at upload, on the pay date. Say the delivery
  // precondition of the chosen format up front. It is one sentence per
  // format: the pain.001 agreement caveat, or the LB sunset with its link.
  const formatCaveat =
    format === 'pain001' ? (
      t('pain001_agreement_warning')
    ) : (
      <>
        {t('sunset_warning')}{' '}
        <Link href="/settings/salary" className="underline underline-offset-2 hover:text-foreground">
          {t('sunset_link')}
        </Link>
      </>
    )

  return (
    <DetailSection
      kicker={t('title')}
      help={
        <HelpPopover>
          <p>
            <span className="font-medium">{FORMAT_LABEL.pain001}</span>: {t('format_description_pain001')}
          </p>
          <p className="mt-2">
            <span className="font-medium">{FORMAT_LABEL.bg_lb}</span>: {t('format_description_bg_lb')}
          </p>
          <p className="mt-2 text-muted-foreground">{t('open_payments_note')}</p>
        </HelpPopover>
      }
    >
      <div>
        {paymentFileFormat && paymentFileGeneratedAt && (
          <DefRow label={t('last_generated')}>
            {FORMAT_LABEL[paymentFileFormat as PaymentFormat] ?? paymentFileFormat}{' '}
            <span className="text-muted-foreground tabular-nums">
              ({formatDateTime(paymentFileGeneratedAt)})
            </span>
          </DefRow>
        )}

        {!readOnly && (
          <DefRow label={t('format_label')}>
            <SettingsSelect
              aria-label={t('format_label')}
              value={format}
              onChange={(e) => setFormat(e.target.value as PaymentFormat)}
              wrapperClassName="-my-1"
            >
              <option value="pain001">{FORMAT_LABEL.pain001}</option>
              <option value="bg_lb">{FORMAT_LABEL.bg_lb}</option>
            </SettingsSelect>
          </DefRow>
        )}
      </div>

      {!readOnly && (
        <div className="mt-3 space-y-3">
          {/* One attention sentence per section (convention 6). A missing
              sender account outranks the format caveat: without it the
              download fails outright. The caveat then drops to a muted line
              so the delivery precondition is still said. */}
          {senderMissing ? (
            <>
              <AttnLine action={{ label: t('missing_sender_link'), href: '/settings/invoicing' }}>
                {format === 'bg_lb' ? t('missing_bankgiro_warning') : t('missing_iban_warning')}
              </AttnLine>
              <p className="text-xs text-muted-foreground">{formatCaveat}</p>
            </>
          ) : format === 'pain001' ? (
            <AttnLine>{t('pain001_agreement_warning')}</AttnLine>
          ) : (
            <AttnLine action={{ label: t('sunset_link'), href: '/settings/salary' }}>
              {t('sunset_warning')}
            </AttnLine>
          )}

          {/* The one action row: the bank instructions are an appendix that
              folds out under it, so the button stays where the section ends. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setShowInstructions((s) => !s)}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
              aria-expanded={showInstructions}
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform duration-150', showInstructions && 'rotate-180')}
              />
              {t('instructions_toggle')}
            </button>
            <Button onClick={handleDownload} disabled={downloading}>
              {downloading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t('download')}
            </Button>
          </div>

          {showInstructions && (
            <div className="text-xs">
              <div className="divide-y divide-border">
                {sortedBanks.map((bank) => (
                  <p key={bank} className="py-2">
                    <span className="text-foreground">
                      {BANK_NAME[bank]}
                      {bank === matchedBank ? ` (${t('your_bank')})` : ''}.
                    </span>{' '}
                    <span className="text-muted-foreground">{t(`steps_${format}_${bank}`)}</span>
                  </p>
                ))}
              </div>
              <p className="pt-2 text-muted-foreground">{t('instructions_footer')}</p>
            </div>
          )}
        </div>
      )}
    </DetailSection>
  )
}
