'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { PaymentBankList } from '@/components/salary/PaymentBankList'
import { ArrowDownTrayIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { parseSalaryPaymentFormat, type SalaryPaymentFileFormat } from '@/lib/salary/payment/payment-format'
import type { PaymentFileAccountView } from '@/lib/salary/payment/payment-account'
import { payingAccountDisplay, payingAccountName } from '@/lib/payments/paying-account-label'

type PaymentFormat = SalaryPaymentFileFormat

interface PaymentFilePanelProps {
  salaryRunId: string
  periodLabel: string
  paymentFileFormat: string | null
  paymentFileGeneratedAt: string | null
  /** salary_runs.payment_file_version: the version every pain.001 download carries. */
  paymentFileVersion?: number
  defaultFormat: PaymentFormat
  /**
   * company_settings.bankgiro: the sender of an LB file. null means missing
   * as of the latest settings fetch (warn up front, the download would 400);
   * undefined means unknown (settings not loaded), so no warning is shown.
   */
  senderBankgiro?: string | null
  /**
   * The account the pain.001 pays from (GET /api/salary/payment-account for
   * this run, usePaymentFileAccount): named on its own row, warned about when
   * it lacks an IBAN or BIC, and its bank's upload instructions open first.
   * undefined while unknown: no warning. The caller refetches after detours
   * that can fix it (the links lead into settings).
   */
  fileAccount?: PaymentFileAccountView
  readOnly?: boolean
  /**
   * The run is paid or booked: the file has done its job, so a run that has
   * one shows a single line (date, download again) with the rest folded
   * behind it.
   */
  settled?: boolean
  /**
   * Betala via banken is the run's way to pay (the header's action): the
   * file is the other way, one line that folds the panel out.
   */
  folded?: boolean
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
  paymentFileVersion = 1,
  defaultFormat,
  senderBankgiro,
  fileAccount,
  readOnly,
  settled,
  folded,
  onDownloaded,
}: PaymentFilePanelProps) {
  const t = useTranslations('salary_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [format, setFormat] = useState<PaymentFormat>(defaultFormat)
  const [downloading, setDownloading] = useState(false)
  // A new version (crm#1219): the dialog and the person's confirmation that
  // the earlier file was not approved at the bank. No confirmation, no file.
  const [newVersionOpen, setNewVersionOpen] = useState(false)
  const [newVersionConfirmed, setNewVersionConfirmed] = useState(false)
  const nextVersion = paymentFileVersion + 1

  const banks = BANKS_BY_FORMAT[format]
  // The bank of the account the file pays from, the one it is uploaded to
  // (crm#1391, crm#1483); the company's stored pick only when that bank has
  // no instructions here. Resolved on the server with the account.
  const ownBank = fileAccount?.instruction_bank ?? null
  const matchedBank = banks.find((b) => b === ownBank) ?? null
  const sortedBanks = matchedBank
    ? [matchedBank, ...banks.filter((b) => b !== matchedBank)]
    : banks
  // Open on the account's own bank until the person toggles it: the account
  // arrives after the first render, so a useState seed would miss it.
  const [instructionsChoice, setInstructionsChoice] = useState<boolean | null>(null)
  const showInstructions = instructionsChoice ?? Boolean(matchedBank)
  // The company's own bank alone, until the person asks for the others.
  const [otherBanks, setOtherBanks] = useState(false)
  const shownBanks = matchedBank && !otherBanks ? [matchedBank] : sortedBanks
  // The one-liner's fold (settled, or folded under Betala via banken): closed until asked for.
  const [foldOpen, setFoldOpen] = useState(false)
  const generatedFormat = paymentFileFormat ? parseSalaryPaymentFormat(paymentFileFormat) : null

  const FORMAT_LABEL: Record<PaymentFormat, string> = {
    bg_lb: t('format_bg_lb'),
    pain001: t('format_pain001'),
  }

  const endpointFor = (fileFormat: PaymentFormat) =>
    fileFormat === 'bg_lb'
      ? `/api/salary/runs/${salaryRunId}/payment/bg-lb`
      : `/api/salary/runs/${salaryRunId}/payment/pain001`

  // The LB sender lives in company_settings, not in the Bolagsverket snapshot
  // shown on the settings overview: users see a bankgiro there and
  // reasonably believe it is configured. The pain.001 pays from the account
  // the salary is booked on, which needs an IBAN and a BIC of its own. Say
  // the precondition here, before the download 400s on it.
  const accountMissing = format === 'pain001' ? (fileAccount?.missing ?? null) : null
  const senderMissing = (format === 'bg_lb' && senderBankgiro === null) || accountMissing !== null

  // fileFormat: the format to download; the settled line's "download again"
  // passes the one the run's file was made in, not the select's.
  async function handleDownload(fileFormat: PaymentFormat = format) {
    // The button is disabled while a file is in flight; this guard closes the
    // double-click / Enter-repeat race before React has re-rendered it. Two
    // payment files for one salary run is not a cosmetic problem: each one is
    // payable on its own, so a user who uploads both to the bank pays the
    // month's wages twice.
    if (downloading) return
    setDownloading(true)
    try {
      const ext = fileFormat === 'bg_lb' ? 'txt' : 'xml'
      // Bounded, and no file is written unless the server answered 2xx with a
      // complete body: an error envelope saved as lon_2026-04.xml is a file the
      // user would carry to the bank before discovering it pays nobody.
      const result = await downloadFile({
        url: endpointFor(fileFormat),
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

  async function handleNewVersion() {
    if (downloading || !newVersionConfirmed) return
    setDownloading(true)
    try {
      const result = await downloadFile({
        url: `/api/salary/runs/${salaryRunId}/payment/pain001`,
        filename: `lon_${periodLabel}_v${nextVersion}.xml`,
        locale,
        postJson: { confirm_previous_not_approved: true },
      })
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
      setNewVersionOpen(false)
      setNewVersionConfirmed(false)
      toast({ title: t('new_version_done', { version: nextVersion }) })
      onDownloaded?.()
    } finally {
      setDownloading(false)
    }
  }

  const sectionHelp = (
    <HelpPopover>
      <p>
        <span className="font-medium">{FORMAT_LABEL.pain001}</span>: {t('format_description_pain001')}
      </p>
      <p className="mt-2">
        <span className="font-medium">{FORMAT_LABEL.bg_lb}</span>: {t('format_description_bg_lb')}
      </p>
      <p className="mt-2">{t('pays_from_help')}</p>
      <p className="mt-2">{t('bank_list_help')}</p>
      <p className="mt-2 text-muted-foreground">{t('open_payments_note')}</p>
    </HelpPopover>
  )

  const body = (
    <>
      <div>
        {paymentFileFormat && paymentFileGeneratedAt && (
          <DefRow label={t('last_generated')}>
            {FORMAT_LABEL[paymentFileFormat as PaymentFormat] ?? paymentFileFormat}
            {paymentFileFormat === 'pain001' && paymentFileVersion > 1
              ? `, ${t('last_generated_version', { version: paymentFileVersion })}`
              : ''}{' '}
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
              onChange={(e) => {
                // The select value is DOM text: narrow it to a known format
                // before it drives any URL, and ignore anything else.
                const next = parseSalaryPaymentFormat(e.target.value)
                if (next) setFormat(next)
              }}
              wrapperClassName="-my-1 max-w-xs"
            >
              <option value="pain001">{FORMAT_LABEL.pain001}</option>
              <option value="bg_lb">{FORMAT_LABEL.bg_lb}</option>
            </SettingsSelect>
          </DefRow>
        )}

        {/* The account the pain.001 pays from, by the rule the file runs:
            the one the salary verifikat credits (crm#1483). The primary is
            changed under Bokföring; a booked run's account is the
            verifikat's, so it offers no change. */}
        {format === 'pain001' && fileAccount && (
          <DefRow label={t('pays_from_label')}>
            <span className="tabular-nums" data-ph-mask="">
              {payingAccountDisplay(fileAccount.account)}
            </span>
            {fileAccount.basis === 'primary' && !readOnly && (
              <>
                {' '}
                <Link href="/settings/bookkeeping" className={QUIET_LINK_CLASS}>
                  {t('pays_from_change')}
                </Link>
              </>
            )}
          </DefRow>
        )}

        {/* The banklista of the chosen format: the payment file builder's
            own payee lines, so the list and the file cannot disagree. */}
        <PaymentBankList salaryRunId={salaryRunId} format={format} />
      </div>

      {!readOnly && (
        <div className="mt-3 space-y-3">
          {/* One attention sentence per section (convention 6). A missing
              sender account outranks the LB sunset: without it the download
              fails outright. The sunset then drops to a muted line so it is
              still said. The pain.001 delivery caveat is the same on every
              file, so it sits behind the "?" beside the download instead. */}
          {senderMissing ? (
            <>
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
              {format === 'bg_lb' && (
                <p className="text-xs text-muted-foreground">
                  {t('sunset_warning')}{' '}
                  <Link href="/settings/salary" className="underline underline-offset-2 hover:text-foreground">
                    {t('sunset_link')}
                  </Link>
                </p>
              )}
            </>
          ) : format === 'bg_lb' ? (
            <AttnLine action={{ label: t('sunset_link'), href: '/settings/salary' }}>
              {t('sunset_warning')}
            </AttnLine>
          ) : null}

          {/* The one action row: the bank instructions are an appendix that
              folds out under it, so the button stays where the section ends. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setInstructionsChoice(!showInstructions)}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
              aria-expanded={showInstructions}
            >
              <ChevronDownIcon
                className={cn('h-3 w-3 transition-transform duration-150', showInstructions && 'rotate-180')}
              />
              {t('instructions_toggle')}
            </button>
            <span className="inline-flex items-center gap-3">
              <Button onClick={() => void handleDownload()} loading={downloading}>
                {!downloading && <ArrowDownTrayIcon className="h-4 w-4" />}
                {t('download')}
              </Button>
              {/* The file downloads fine and only fails at the bank if the
                  delivery route is missing: the precondition, one click away. */}
              {format === 'pain001' && <HelpPopover>{t('pain001_agreement_warning')}</HelpPopover>}
            </span>
          </div>

          {/* A new version only once a pain.001 has been made: it exists for a
              file the bank refused or that named the wrong account. */}
          {format === 'pain001' && paymentFileFormat === 'pain001' && paymentFileGeneratedAt && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setNewVersionOpen(true)}
                className="text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
              >
                {t('new_version_action')}
              </button>
            </div>
          )}

          {showInstructions && (
            <div className="text-xs">
              <div className="divide-y divide-border">
                {shownBanks.map((bank) => (
                  <p key={bank} className="py-2">
                    <span className="text-foreground">
                      {BANK_NAME[bank]}
                      {bank === matchedBank ? ` (${t('your_bank')})` : ''}.
                    </span>{' '}
                    <span className="text-muted-foreground">{t(`steps_${format}_${bank}`)}</span>
                  </p>
                ))}
              </div>
              {shownBanks.length < sortedBanks.length && (
                <button
                  type="button"
                  onClick={() => setOtherBanks(true)}
                  className="pt-2 text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                >
                  {t('instructions_other_banks')}
                </button>
              )}
              <p className="pt-2 text-muted-foreground">{t('instructions_footer')}</p>
            </div>
          )}
        </div>
      )}
    </>
  )

  const newVersionDialog = (
    <Dialog
      open={newVersionOpen}
      onOpenChange={(open) => {
        setNewVersionOpen(open)
        if (!open) setNewVersionConfirmed(false)
      }}
    >
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('new_version_title')}</DialogTitle>
          <DialogDescription>{t('new_version_body')}</DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-2 text-[13px]">
          <Checkbox
            className="mt-0.5"
            checked={newVersionConfirmed}
            onCheckedChange={(v) => setNewVersionConfirmed(v === true)}
          />
          {t('new_version_confirm')}
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewVersionOpen(false)} disabled={downloading}>
            {t('new_version_cancel')}
          </Button>
          <Button onClick={() => void handleNewVersion()} disabled={!newVersionConfirmed} loading={downloading}>
            {t('new_version_submit', { version: nextVersion })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  // One line that folds the panel out: the label, anything after it on the
  // line, and the section help once open.
  const foldLine = (label: string, after?: ReactNode) => (
    <section>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <button
          type="button"
          onClick={() => setFoldOpen((open) => !open)}
          aria-expanded={foldOpen}
          className="inline-flex items-center gap-2 transition-colors duration-150 hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
              foldOpen && 'rotate-90',
            )}
          />
          {label}
        </button>
        {after}
        {foldOpen && sectionHelp}
      </div>
      {foldOpen && <div className="mt-3">{body}</div>}
      {newVersionDialog}
    </section>
  )

  // Paid or booked with a file made: one line, the date and a download of the
  // same file again (the same version, so the bank's duplicate check holds).
  // The format, banklista, instructions and new-version action fold out
  // behind it.
  if (settled && generatedFormat && paymentFileGeneratedAt) {
    return foldLine(
      t('settled_label'),
      <>
        <span className="text-muted-foreground" aria-hidden>·</span>
        <span className="tabular-nums text-muted-foreground">{formatDate(paymentFileGeneratedAt)}</span>
        {!readOnly && (
          <>
            <span className="text-muted-foreground" aria-hidden>·</span>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-sm"
              onClick={() => void handleDownload(generatedFormat)}
              loading={downloading}
            >
              {t('download_again')}
            </Button>
          </>
        )}
      </>,
    )
  }

  // Paid or booked without a file: paid some other way, so the panel folds
  // away behind its name.
  if (settled) return foldLine(t('settled_label'))

  // Betala via banken is the way to pay: the file is the alternative, folded.
  if (folded) return foldLine(t('folded_label'))

  return (
    <DetailSection kicker={t('title')} help={sectionHelp}>
      {body}
      {newVersionDialog}
    </DetailSection>
  )
}
