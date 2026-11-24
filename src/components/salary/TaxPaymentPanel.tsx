'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AttnLine } from '@/components/ui/attn-line'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon, CheckCircleIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { postAction } from '@/lib/browser/post-action'
import { failureDescription } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { PayDeclarationViaBankButton } from '@/components/payments/PayDeclarationViaBankButton'
import type { PaymentFileAccountView } from '@/lib/salary/payment/payment-account'
import { payingAccountName } from '@/lib/payments/paying-account-label'

type PaymentFormat = 'bg_lb' | 'pain001'

interface TaxPaymentPanelProps {
  /**
   * The AGI redovisningsperiod, YYYY-MM: the payout month (agiReportingPeriod),
   * which the declaration, the payment file and mark-paid are keyed on. Not
   * the earned month: for lön i efterskott that is the previous month's AGI.
   */
  period: string
  /**
   * The day the period's tax and contributions must be on the skattekonto
   * (YYYY-MM-DD, from GET /api/skatteverket/tax-payments/{period}); null or
   * absent when unknown, and the row is then left out.
   */
  paymentDueDate?: string | null
  totalTax: number
  totalAvgifter: number
  paymentFileFormat: string | null
  paymentFileGeneratedAt: string | null
  taxPaidAt: string | null
  /** company_settings.preferred_payment_format: seeds the format selector. */
  defaultFormat: PaymentFormat
  /**
   * company_settings.bankgiro: the sender of an LB file. null means missing
   * as of the latest settings fetch (warn up front, the download would 400);
   * undefined means unknown (settings not loaded).
   */
  senderBankgiro?: string | null
  /**
   * The account a pain.001 pays from: the primary bank account
   * (GET /api/salary/payment-account without a run). undefined while
   * unknown: no warning.
   */
  fileAccount?: PaymentFileAccountView
  readOnly?: boolean
  /**
   * The AGI's redovisningsperiod (YYYY-MM) when the AGI declaration exists:
   * offers Betala via banken for it where bank payments are switched on.
   */
  agiPeriod?: string | null
  /**
   * The refusal the payment file and the bank payment give the declaration
   * (GET /api/skatteverket/tax-payments/{period}: period_conflict): it holds
   * one run's totals while another live run is paid out in the month
   * (crm#1768). Set, the panel says so instead of showing an amount to pay
   * or offering to pay it; marking the month paid stays.
   */
  periodConflict?: { code: string; message: string; message_en?: string } | null
  /**
   * The payment to the skattekonto through the bank made towards this
   * period's due date: signed, at the bank or executed (GET
   * /api/skatteverket/tax-payments/{period}: bank_payment). Set, the panel
   * shows it, and leaves Betala via banken out when it covers the amount.
   */
  bankPayment?: { status: string; amount: number; requested_execution_date: string } | null
  onChange?: () => void
}

/**
 * Generates the payment file (Bankgirot LB or ISO 20022 pain.001) for paying
 * skatt + arbetsgivaravgifter for an AGI period to Skatteverket Bankgiro
 * 5050-1055 with the company's Skattekontot OCR.
 */
export function TaxPaymentPanel({
  period,
  totalTax,
  totalAvgifter,
  paymentFileFormat,
  paymentFileGeneratedAt,
  taxPaidAt,
  paymentDueDate,
  defaultFormat,
  senderBankgiro,
  fileAccount,
  readOnly,
  agiPeriod,
  periodConflict,
  bankPayment,
  onChange,
}: TaxPaymentPanelProps) {
  const t = useTranslations('salary_payments')
  const tb = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [format, setFormat] = useState<PaymentFormat>(defaultFormat)
  const [downloading, setDownloading] = useState(false)
  const [marking, setMarking] = useState(false)

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
      const filename =
        format === 'pain001' ? `pain001_skatt_${period}.xml` : `bg_lb_skatt_${period}.txt`
      // Bounded, and no file is written unless the server answered 2xx with a
      // complete body: an error envelope saved as bg_lb_skatt_2026-04.txt is a
      // file the user would upload to the bank before discovering it pays no tax.
      const result = await downloadFile({
        url: `/api/skatteverket/tax-payments/${period}/payment-file?format=${format}`,
        filename,
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
  }, [period, format, toast, onChange, t, locale, downloading, marking])

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

  const FORMAT_LABEL: Record<PaymentFormat, string> = {
    bg_lb: t('format_bg_lb'),
    pain001: t('format_pain001'),
  }

  // The LB sender lives in company_settings, not in the Bolagsverket
  // snapshot shown on the settings overview; the pain.001 pays from the
  // primary bank account, which needs an IBAN and a BIC of its own. Say the
  // precondition here, before the download 400s on it (same logic as
  // PaymentFilePanel).
  const accountMissing = format === 'pain001' ? (fileAccount?.missing ?? null) : null
  const senderMissing = (format === 'bg_lb' && senderBankgiro === null) || accountMissing !== null
  // A declaration that may not be paid shows no amount to pay and no way to pay it.
  const payable = !periodConflict
  // A bank payment towards the due date that covers the amount pays it: no
  // second one is offered. A smaller one may be another declaration's.
  const paidByBank = !!bankPayment && bankPayment.amount >= totalAmount

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
            <ArrowTopRightOnSquareIcon className="h-3 w-3" />
          </a>
        ) : undefined
      }
    >
      {periodConflict && (
        <div className="mb-3">
          <AttnLine>{getErrorMessage(periodConflict, { locale })}</AttnLine>
        </div>
      )}
      <div>
        {payable && (
          <>
            <DefRow label={t('tax_label_tax')}>
              <span className="tabular-nums">{formatCurrency(totalTax)}</span>
            </DefRow>
            <DefRow label={t('tax_label_avgifter')}>
              <span className="tabular-nums">{formatCurrency(totalAvgifter)}</span>
            </DefRow>
            <DefRow label={t('tax_label_total')}>
              <span className="font-medium tabular-nums">{formatCurrency(totalAmount)}</span>
            </DefRow>
          </>
        )}
        <DefRow label={t('tax_recipient')}>{t('tax_recipient_value')}</DefRow>
        {paymentDueDate && (
          <DefRow label={t('tax_due_date')}>
            <span className="tabular-nums">{paymentDueDate}</span>
          </DefRow>
        )}
        {paymentFileGeneratedAt && (
          <DefRow label={t('tax_file_generated')}>
            {paymentFileFormat && (
              <>{FORMAT_LABEL[paymentFileFormat as PaymentFormat] ?? paymentFileFormat} </>
            )}
            <span className="tabular-nums">{formatDateTime(paymentFileGeneratedAt)}</span>
          </DefRow>
        )}
        {!taxPaidAt && bankPayment && (
          <DefRow label={t('tax_bank_payment')}>
            {t('tax_bank_payment_value', {
              status: tb(`status_${bankPayment.status}`),
              amount: formatCurrency(bankPayment.amount),
              date: formatDate(bankPayment.requested_execution_date),
            })}{' '}
            <Link href="/payments" className={QUIET_LINK_CLASS}>
              {tb('open_payments_page')}
            </Link>
          </DefRow>
        )}
        {taxPaidAt && (
          <DefRow label={t('tax_marked_paid')}>
            <span className="tabular-nums">{formatDateTime(taxPaidAt)}</span>
          </DefRow>
        )}
        {!readOnly && payable && (
          <DefRow label={t('format_label')}>
            <SettingsSelect
              aria-label={t('format_label')}
              value={format}
              onChange={(e) => setFormat(e.target.value as PaymentFormat)}
              wrapperClassName="-my-1 max-w-xs"
            >
              <option value="pain001">{FORMAT_LABEL.pain001}</option>
              <option value="bg_lb">{FORMAT_LABEL.bg_lb}</option>
            </SettingsSelect>
          </DefRow>
        )}
      </div>

      {!readOnly && payable && senderMissing && (
        <div className="mt-3">
          <AttnLine
            action={{
              label: accountMissing ? t('missing_account_link') : t('missing_sender_link'),
              href: '/settings/invoicing',
            }}
          >
            {accountMissing && fileAccount
              ? t(accountMissing === 'iban' ? 'missing_account_iban_warning' : 'missing_account_bic_warning', {
                  account: payingAccountName(fileAccount.account),
                })
              : t('missing_bankgiro_warning')}
          </AttnLine>
        </div>
      )}

      {!readOnly && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {!taxPaidAt && agiPeriod && payable && !paidByBank && (
            <PayDeclarationViaBankButton
              source={{ source: 'agi', year: Number(agiPeriod.slice(0, 4)), month: Number(agiPeriod.slice(5, 7)) }}
              sourceLabel={agiPeriod}
              variant="outline"
              onDone={onChange}
            />
          )}
          {payable && (
            <Button variant="outline" onClick={handleDownload} disabled={marking} loading={downloading}>
              {!downloading && <ArrowDownTrayIcon className="h-4 w-4" />}
              {t('tax_download_button')}
            </Button>
          )}
          {!taxPaidAt && (
            <Button
              variant="outline"
              onClick={handleMarkPaid}
              disabled={downloading}
              loading={marking}
            >
              {!marking && <CheckCircleIcon className="h-4 w-4" />}
              {t('tax_mark_paid_button')}
            </Button>
          )}
        </div>
      )}
    </DetailSection>
  )
}
