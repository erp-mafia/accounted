'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { PaymentPreviewLinesCard, usePaymentPreviewEditor } from '@/components/bookkeeping/PaymentPreviewLinesCard'
import { RegistrationFirstCard, type RegistrationEntryPreview } from '@/components/supplier-invoices/RegistrationFirstCard'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { isInvoiceBookingRateMissing, previewedFxGainSek } from './invoice-match-fx'
import {
  getInvoiceMatchTargetState,
  getSupplierInvoiceMatchTargetState,
} from '@/lib/bookkeeping/matchable-statuses'
import { CheckCircleIcon, ExclamationTriangleIcon } from '@/components/icons'
import type { LineDimensions } from '@/components/bookkeeping/payment-line-dimensions'
import type { PaymentLinePayload, PaymentPreviewLine } from '@/components/bookkeeping/payment-preview-lines'
import { ORE_ROUNDING_ACCOUNT, parseDecimalInput } from '@/lib/money'
import { PAYMENT_FEE_ACCOUNT } from '@/lib/bookkeeping/payment-fee'
import type { TransactionWithInvoice } from './transaction-types'

interface DuplicateCandidate {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  /** The voucher leg's SEK debit: always kronor, never the bank line's own
   *  (possibly foreign) amount. Render with an explicit 'SEK'. */
  amount: number
  bank_account_number: string
  /** 'date_window_only' = the amount test never ran (no SEK value on the bank
   *  line); the copy must not claim an amount match for that shape. */
  reason: 'exact_amount_same_date' | 'exact_amount_within_window' | 'date_window_only'
  /** False when the amounts were never compared (mirrors
   *  lib/transactions/booking-duplicate-detection.ts). */
  amount_verified: boolean
}

// Cross-currency conversion info returned by the preview route. When
// `required` is true the dialog surfaces a Valutaomräkning section so the
// user sees the rate + invoice-currency-equivalent before approving. When
// the Riksbanken lookup fails the dialog swaps in a manual-rate input.
type FxConversion =
  | { required: false }
  | {
      required: true
      tx_currency: string
      invoice_currency: string
      rate: number
      rate_date: string
      paid_in_invoice_currency: number
    }
  | { required: true; error: 'rate_unavailable'; tx_currency: string; invoice_currency: string }

interface MatchPreview {
  entry_type: 'clearing' | 'cash'
  lines: PaymentPreviewLine[]
  invoice_already_booked: boolean
  accounting_method: 'accrual' | 'cash'
  is_fully_paid: boolean
  fx_conversion?: FxConversion
  /** Supplier match only: SEK of a bank fee drawn on top of the invoice, booked on 6570. */
  bank_fee_sek?: number
  /** Supplier match only: the settled invoice's bag, given to a row the user adds. */
  document_dimensions?: LineDimensions
  /**
   * Supplier match only: an unbooked invoice of a company that books in a
   * separate step, the registration verifikat the match books first.
   */
  registration_entry?: RegistrationEntryPreview | null
  /**
   * Customer match only: a SEK payment a krona or more above what the invoice
   * still owes. `accounts` may take the excess; `account` is the one the
   * preview was asked for, null until the user picks one (then `lines` is
   * empty, since the route books the match only with an account named).
   */
  overpayment?: { excess: number; accounts: string[]; account: string | null } | null
  /**
   * Customer match only: a SEK payment a krona or more short of what the
   * invoice still owes, by less than a tenth: possibly a payment provider's
   * fee taken from its payout (crm#1364). `account` is the fee account the
   * preview was asked for, null until the user names it. `required`: the
   * payment cannot be booked as a partial instead (kontantmetoden, never
   * booked), so without the fee there are no rows.
   */
  payment_fee?: { fee: number; account: string | null; required: boolean } | null
}

export interface ConfirmOpts {
  force?: boolean
  expected_journal_entry_id?: string
  lines?: PaymentLinePayload[]
  // Manual SEK-per-invoice-currency override used when Riksbanken's rate
  // for the payment date isn't available; the dialog asks the user to type
  // the rate from their bank statement. Same field flows to the route.
  manual_exchange_rate?: number
  // Where a customer's excess goes and the excess the preview showed: the
  // route books exactly that or refuses (MATCH_OVERPAYMENT_CHANGED).
  overpayment_account?: string
  overpayment_amount?: number
  // The payment provider's fee the preview booked on 6570: the route books
  // exactly that or refuses (MATCH_PAYMENT_FEE_CHANGED).
  fee_account?: string
  fee_amount?: number
  // Supplier match only: reverse the row's own categorization (storno) and
  // book the payment instead. Sent only from the already-booked soft block.
  storno_existing?: boolean
}

/**
 * The supplier match was refused because the bank row is already booked
 * (MATCH_SI_TX_ALREADY_BOOKED): the verifikat that books it, whether it is
 * the row's own categorization, which the match may reverse, and the
 * refusal's own sentence in the UI's language.
 */
export interface MatchAlreadyBooked {
  voucher: string | null
  stornoAllowed: boolean
  message: string
}

interface InvoiceMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: (opts?: ConfirmOpts) => void
  onLinkToExisting?: (journalEntryId: string) => void
  /**
   * The row pays a krona or more above what the invoice owes: offer to carry
   * the invoice into the batch allocation, for a payment of several invoices
   * (PH 192), instead of only the fee or overpayment this match books.
   */
  onSplitAcrossInvoices?: () => void
  /** Set after the match was refused for a booked row: a soft block in place of the confirm. */
  alreadyBooked?: MatchAlreadyBooked | null
}

/** An exchange rate keeps its decimals: it must not be rounded to the öre. */
function parseRate(s: string): number {
  return parseDecimalInput(s) ?? 0
}

/**
 * A preview request that came back non-2xx. `code` is the structured error
 * code from the canonical envelope when the body carried one, `message` the
 * locale-resolved sentence. Both null for a transport failure (offline,
 * proxy error page), where the generic fallback copy is all we can honestly
 * say.
 */
interface PreviewFailure {
  code: string | null
  message: string | null
  /** The refusal came from booking the supplier invoice first. */
  registrationFirst?: boolean
}

export default function InvoiceMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
  onLinkToExisting,
  onSplitAcrossInvoices,
  alreadyBooked = null,
}: InvoiceMatchDialogProps) {
  const t = useTranslations('tx_invoice_match')
  const uiLocale = useLocale() === 'en' ? ('en' as const) : ('sv' as const)
  const isSupplierInvoice = !!transaction?.potential_supplier_invoice
  const isCustomerInvoice = !!transaction?.potential_invoice
  const transactionId = transaction?.id ?? null

  // The suggestion pointer is written once at import time and never revisited,
  // so the invoice it names may since have been settled by a DIFFERENT
  // transaction. The read paths filter those out, but the row in hand can
  // still be stale (fetched before the other match, or settled in another
  // tab), so re-check here rather than trust the pointer.
  //
  // This is not an advisory guard: the match routes reject any target outside
  // their open-status CAS lists, so there is no "match anyway" that could
  // succeed. Distinguish a paid or zero-balance target from a different
  // non-open status so the blocking copy explains the actual problem.
  const targetMatchState = isSupplierInvoice
    ? getSupplierInvoiceMatchTargetState(transaction!.potential_supplier_invoice)
    : isCustomerInvoice
      ? getInvoiceMatchTargetState(transaction!.potential_invoice)
      : null
  const targetBlocked = targetMatchState !== null && targetMatchState !== 'matchable'

  const [candidate, setCandidate] = useState<DuplicateCandidate | null>(null)
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false)

  const invoiceId = transaction?.potential_invoice?.id ?? null
  const supplierInvoiceId = transaction?.potential_supplier_invoice?.id ?? null
  const [preview, setPreview] = useState<MatchPreview | null>(null)
  const [previewFailure, setPreviewFailure] = useState<PreviewFailure | null>(null)
  // The "Bokföring" rows: read-only, or the user's edited grid (which then books).
  const editor = usePaymentPreviewEditor(preview?.lines, preview?.document_dimensions)
  const { stopEditing } = editor
  // Manual SEK-per-invoice-currency rate the user types when Riksbanken has
  // no rate for the payment date. Empty string = no override; on submit it
  // flows through ConfirmOpts.manual_exchange_rate to the route, which
  // re-runs the preview math with the supplied rate.
  const [manualRate, setManualRate] = useState<string>('')
  // The account the user picked for a customer's excess of a krona or more.
  // Never preselected: nothing over the öre band is booked without the user
  // naming the account (DECISIONS 2026-10-03).
  const [overpaymentAccount, setOverpaymentAccount] = useState<string | null>(null)
  // A pick belongs to one transaction and invoice: never carry it to another,
  // where it would book that match's excess without the user choosing.
  // The fee account the user named for a payout short of the invoice: never
  // preselected either, since it settles the invoice in full.
  const [feeAccount, setFeeAccount] = useState<string | null>(null)
  // The user's edited rows belong to one match as well.
  useEffect(() => {
    setOverpaymentAccount(null)
    setFeeAccount(null)
    stopEditing()
  }, [transactionId, invoiceId, stopEditing])

  useEffect(() => {
    if (!open || !transactionId || targetBlocked) {
      setPreview(null)
      setPreviewFailure(null)
      stopEditing()
      setManualRate('')
      setOverpaymentAccount(null)
      setFeeAccount(null)
      return
    }
    let cancelled = false
    const previewUrl = isCustomerInvoice && invoiceId
      ? `/api/transactions/${transactionId}/match-invoice/preview?invoice_id=${invoiceId}` +
        (overpaymentAccount ? `&overpayment_account=${overpaymentAccount}` : '') +
        (feeAccount ? `&fee_account=${feeAccount}` : '')
      : isSupplierInvoice && supplierInvoiceId
        ? `/api/transactions/${transactionId}/match-supplier-invoice/preview?supplier_invoice_id=${supplierInvoiceId}`
        : null
    if (!previewUrl) {
      setPreview(null)
      setPreviewFailure(null)
      return
    }
    async function loadPreview() {
      setPreviewFailure(null)
      try {
        const res = await fetch(previewUrl!)
        if (!res.ok) {
          // The preview route builds its clearing lines with the same helper
          // the POST commits with, so it refuses in exactly the places the
          // commit would: a foreign invoice with no booking rate makes
          // buildInvoicePaymentClearingLines throw
          // MATCH_INVOICE_BOOKING_RATE_MISSING and this GET returns 400. Keep
          // the code and the Swedish sentence rather than collapsing every
          // failure into "could not preview, continue or cancel": that copy
          // invites an action the server has already decided to reject.
          let failure: PreviewFailure = { code: null, message: null }
          try {
            const body = (await res.json()) as {
              error?: { code?: unknown; details?: { registration_first?: unknown } }
            }
            if (body?.error && typeof body.error === 'object') {
              failure = {
                code: typeof body.error.code === 'string' ? body.error.code : null,
                message: getErrorMessage(body, { locale: uiLocale }),
                registrationFirst: body.error.details?.registration_first === true,
              }
            }
          } catch {
            // Non-JSON body (proxy/edge error page): generic copy is all we have.
          }
          if (!cancelled) setPreviewFailure(failure)
          return
        }
        const data = (await res.json()) as MatchPreview
        if (!cancelled) setPreview(data)
      } catch {
        if (!cancelled) setPreviewFailure({ code: null, message: null })
      }
    }
    loadPreview()
    return () => {
      cancelled = true
    }
  }, [
    open,
    transactionId,
    isCustomerInvoice,
    isSupplierInvoice,
    invoiceId,
    supplierInvoiceId,
    targetBlocked,
    uiLocale,
    overpaymentAccount,
    feeAccount,
    stopEditing,
  ])

  useEffect(() => {
    if (
      !open ||
      !transactionId ||
      !isCustomerInvoice ||
      !onLinkToExisting ||
      targetBlocked
    ) {
      setCandidate(null)
      setIsCheckingDuplicate(false)
      return
    }
    let cancelled = false
    async function check() {
      setIsCheckingDuplicate(true)
      try {
        const res = await fetch(`/api/transactions/${transactionId}/duplicate-payment-check`)
        if (!res.ok) return
        const data = (await res.json()) as { candidate: DuplicateCandidate | null }
        if (!cancelled) setCandidate(data.candidate ?? null)
      } catch {
        // Fail-open: hide the warning panel; the server still enforces the guard.
      } finally {
        if (!cancelled) setIsCheckingDuplicate(false)
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [open, transactionId, isCustomerInvoice, onLinkToExisting, targetBlocked])

  // Cross-currency settlement whose invoice carries no booked exchange rate.
  // The kursvinst/kursförlust is then UNDEFINED, not zero: the SEK value the
  // receivable was posted at is unknown, so nothing on this screen can honestly
  // state what the FX result of the settlement is, and the booking path refuses
  // to invent one. Third state, distinct from "no FX at all" (a SEK invoice)
  // and from "FX with a real computed result". See ./invoice-match-fx.ts.
  const invoiceCurrency = transaction?.potential_invoice?.currency ?? null
  const invoiceRateMissing = isInvoiceBookingRateMissing({
    transactionCurrency: transaction?.currency,
    invoiceCurrency,
    invoiceExchangeRate: transaction?.potential_invoice?.exchange_rate,
    previewEntryType: preview?.entry_type ?? null,
    previewErrorCode: previewFailure?.code ?? null,
  })

  const handleConfirm = (opts?: Pick<ConfirmOpts, 'force' | 'expected_journal_entry_id' | 'storno_existing'>) => {
    // What the grid holds is what gets booked, each row's bag included.
    const linesPayload = preview ? editor.payload : undefined
    // Forward manual rate only when the preview indicated Riksbanken
    // failed AND the user typed a value. Same-currency settlements and
    // the auto-fetched cross-currency case both skip this field.
    const fx = preview?.fx_conversion
    const fxNeedsManualRate = fx?.required === true && 'error' in fx
    const manualRateNum = fxNeedsManualRate ? parseRate(manualRate) : 0
    const manualRatePayload =
      fxNeedsManualRate && manualRateNum > 0 ? { manual_exchange_rate: manualRateNum } : {}
    // The account and the excess the preview booked them with.
    const placed = isCustomerInvoice ? preview?.overpayment : null
    const overpaymentPayload = placed?.account
      ? { overpayment_account: placed.account, overpayment_amount: placed.excess }
      : {}
    // The fee account and the fee the preview booked them with.
    const fee = isCustomerInvoice ? preview?.payment_fee : null
    const feePayload = fee?.account ? { fee_account: fee.account, fee_amount: fee.fee } : {}
    onConfirm({
      ...(opts ?? {}),
      ...(linesPayload ? { lines: linesPayload } : {}),
      ...manualRatePayload,
      ...overpaymentPayload,
      ...feePayload,
    })
  }

  // A customer overpayment whose account the user has not picked yet: the
  // preview has no rows and the route would refuse the match.
  const customerOverpayment = isCustomerInvoice ? (preview?.overpayment ?? null) : null
  const overpaymentUnplaced = !!customerOverpayment && !customerOverpayment.account
  // A payout short of the invoice by what could be the payment provider's
  // fee; unplaced while the match books nothing without it.
  const customerFee = isCustomerInvoice ? (preview?.payment_fee ?? null) : null
  const feeUnplaced = !!customerFee && customerFee.required && !customerFee.account

  const matchTitle = isSupplierInvoice ? t('title_supplier') : t('title_customer')
  const matchDescription = targetBlocked
    ? t('description_blocked')
    : isSupplierInvoice
      ? t('description_supplier')
      : t('description_customer')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{matchTitle}</DialogTitle>
          <DialogDescription>{matchDescription}</DialogDescription>
        </DialogHeader>

        {transaction && (isCustomerInvoice || isSupplierInvoice) && (
          <div className="space-y-4">
            {/* The row is already booked (accounted#58): matching it too would
                book the payment twice. Only the row's own categorization can
                be reversed here, and only by this explicit click. */}
            {!targetBlocked && alreadyBooked && isSupplierInvoice && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-attn" />
                  <div className="text-sm space-y-1">
                    <p className="font-medium text-attn">{t('already_booked_title')}</p>
                    <p className="text-muted-foreground">{alreadyBooked.message}</p>
                  </div>
                </div>
                {alreadyBooked.voucher && alreadyBooked.stornoAllowed && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => handleConfirm({ storno_existing: true })}
                    disabled={isConfirming || !editor.validation.isValid}
                  >
                    {t('already_booked_storno_and_match', { label: alreadyBooked.voucher })}
                  </Button>
                )}
              </div>
            )}

            {/* Duplicate-payment warning: customer-side only, only when a candidate exists */}
            {!targetBlocked && candidate && isCustomerInvoice && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-attn" />
                  <div className="text-sm space-y-1">
                    <p className="font-medium text-attn">{t('duplicate_title')}</p>
                    {/* candidate.amount is the voucher leg's SEK debit
                        (duplicate-payment-detection.ts), so it is formatted as
                        SEK regardless of the transaction's currency: an
                        11 500 kr leg must never print as "11 500,00 EUR".
                        The unverified shape (date_window_only) uses copy that
                        does NOT claim an amount match: the amounts were never
                        compared (the bank line has no stored SEK value). */}
                    <p className="text-muted-foreground">
                      {candidate.reason === 'date_window_only' || candidate.amount_verified === false
                        ? t('duplicate_body_unverified', {
                            label: candidate.voucher_label,
                            amount: formatCurrency(candidate.amount, 'SEK'),
                            date: formatDate(candidate.entry_date),
                          })
                        : candidate.reason === 'exact_amount_same_date'
                          ? t('duplicate_body_same_date', {
                              label: candidate.voucher_label,
                              amount: formatCurrency(candidate.amount, 'SEK'),
                            })
                          : t('duplicate_body_window', {
                              label: candidate.voucher_label,
                              amount: formatCurrency(candidate.amount, 'SEK'),
                              date: formatDate(candidate.entry_date),
                            })}
                    </p>
                    {candidate.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {candidate.description.length > 80
                          ? `${candidate.description.slice(0, 80).trimEnd()}…`
                          : candidate.description}
                      </p>
                    )}
                  </div>
                </div>
                {onLinkToExisting && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onLinkToExisting(candidate.journal_entry_id)}
                      disabled={isConfirming}
                      className="sm:flex-1"
                    >
                      {t('link_to_existing', { label: candidate.voucher_label })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        handleConfirm({
                          force: true,
                          expected_journal_entry_id: candidate.journal_entry_id,
                        })
                      }
                      disabled={isConfirming}
                      className="text-muted-foreground"
                    >
                      {t('create_new_anyway')}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Transaction details */}
            <div className="rounded-lg border p-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('transaction_label')}</p>
              <p className="font-medium">{transaction.description}</p>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{formatDate(transaction.date)}</span>
                <span className={`font-medium ${transaction.amount > 0 ? 'text-success' : ''}`}>
                  {transaction.amount > 0 ? '+' : ''}
                  {formatCurrency(transaction.amount, transaction.currency)}
                </span>
              </div>
            </div>

            {/* Invoice details. Both branches show remaining_amount (what is
                still owed) rather than the original total, so a partially-paid
                invoice displays the actual figure the user is matching against
                and the card can never contradict the amount comparison below.
                The supplier branch used to render .total while the comparison
                measured against remaining_amount: on a partially-paid invoice
                that put "1 250 kr" on screen next to "Differens: 1 250 kr". */}
            {isCustomerInvoice && (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">{t('invoice_label')}</p>
                <p className="font-medium">
                  {t('invoice_number', { number: transaction.potential_invoice!.invoice_number ?? '' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {transaction.potential_invoice!.customer?.name || t('unknown_customer')}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('due_date', { date: formatDate(transaction.potential_invoice!.due_date) })}
                  </span>
                  <span className="font-medium">
                    {formatCurrency(
                      transaction.potential_invoice!.remaining_amount ?? transaction.potential_invoice!.total,
                      transaction.potential_invoice!.currency,
                    )}
                  </span>
                </div>
              </div>
            )}

            {isSupplierInvoice && (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">{t('supplier_invoice_label')}</p>
                <p className="font-medium">
                  {t('invoice_number', { number: transaction.potential_supplier_invoice!.supplier_invoice_number ?? '' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('arrival_number', { number: transaction.potential_supplier_invoice!.arrival_number ?? '' })}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('due_date', { date: formatDate(transaction.potential_supplier_invoice!.due_date) })}
                  </span>
                  <span className="font-medium">
                    {formatCurrency(
                      transaction.potential_supplier_invoice!.remaining_amount ??
                        transaction.potential_supplier_invoice!.total,
                      transaction.potential_supplier_invoice!.currency,
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Amount comparison. Compares the bank tx against what the
                customer STILL OWES (remaining_amount), not the original
                invoice.total: otherwise a 1 250 SEK invoice with a prior
                230 SEK partial would show "Differens: 250 kr" when a 1 000
                SEK top-up arrives, instead of the actual 20 kr shortfall.
                The customer branch previously fell back to .total; both
                branches now mirror the supplier branch's correct logic. */}
            {(() => {
              // A blocked target makes the amount comparison below
              // meaningless, and no outcome it describes is reachable.
              if (targetBlocked) {
                const isSettled = targetMatchState === 'settled'
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 text-attn">
                    <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-medium">
                        {t(isSettled ? 'target_settled_title' : 'target_not_open_title')}
                      </p>
                      <p>
                        {t(
                          isSettled
                            ? 'target_settled_description'
                            : 'target_not_open_description',
                        )}
                      </p>
                    </div>
                  </div>
                )
              }

              // Customer paid a krona or more too much (SEK), as the preview
              // reports it: the match books once the user picks where the
              // excess goes, so ask here instead of warning about a difference
              // the route would then refuse.
              if (customerOverpayment) {
                return (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-attn" />
                      <div className="text-sm space-y-1">
                        <p className="font-medium">
                          {t('customer_overpayment_title', {
                            amount: formatCurrency(customerOverpayment.excess, 'SEK'),
                          })}
                        </p>
                        <p className="text-muted-foreground">{t('customer_overpayment_description')}</p>
                        {onSplitAcrossInvoices && (
                          <button
                            type="button"
                            className={cn(QUIET_LINK_CLASS, 'block text-left')}
                            onClick={onSplitAcrossInvoices}
                            disabled={isConfirming}
                          >
                            {t('split_across_invoices')}
                          </button>
                        )}
                      </div>
                    </div>
                    <div
                      role="radiogroup"
                      aria-label={t('customer_overpayment_choose')}
                      className="grid gap-2 sm:grid-cols-2"
                    >
                      {customerOverpayment.accounts.map((account) => {
                        const isRounding = account === ORE_ROUNDING_ACCOUNT
                        const selected = overpaymentAccount === account
                        return (
                          <button
                            key={account}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setOverpaymentAccount(account)}
                            disabled={isConfirming}
                            className={cn(
                              'rounded-lg border p-3 text-left text-sm transition-colors',
                              selected ? 'border-foreground bg-secondary' : 'border-border hover:bg-secondary/60',
                            )}
                          >
                            <span className="block font-medium">
                              {isRounding
                                ? t('customer_overpayment_account_3740')
                                : t('customer_overpayment_account_2420')}
                            </span>
                            <span className="block text-muted-foreground">
                              {isRounding
                                ? t('customer_overpayment_hint_3740')
                                : t('customer_overpayment_hint_2420')}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              }

              // The payout is short of the invoice by what could be the
              // payment provider's fee (crm#1364): ask whether it is, instead
              // of warning about a partial the user may not mean.
              if (customerFee) {
                const options = customerFee.required ? [PAYMENT_FEE_ACCOUNT] : [null, PAYMENT_FEE_ACCOUNT]
                return (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-attn" />
                      <div className="text-sm space-y-1">
                        <p className="font-medium">
                          {t('payment_fee_title', { amount: formatCurrency(customerFee.fee, 'SEK') })}
                        </p>
                        <p className="text-muted-foreground">{t('payment_fee_description')}</p>
                        {customerFee.required && (
                          <p className="text-muted-foreground">{t('payment_fee_required_note')}</p>
                        )}
                      </div>
                    </div>
                    <div
                      role="radiogroup"
                      aria-label={t('payment_fee_choose')}
                      className="grid gap-2 sm:grid-cols-2"
                    >
                      {options.map((account) => {
                        const selected = feeAccount === account
                        return (
                          <button
                            key={account ?? 'partial'}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setFeeAccount(account)}
                            disabled={isConfirming}
                            className={cn(
                              'rounded-lg border p-3 text-left text-sm transition-colors',
                              selected ? 'border-foreground bg-secondary' : 'border-border hover:bg-secondary/60',
                            )}
                          >
                            <span className="block font-medium">
                              {account ? t('payment_fee_option_fee') : t('payment_fee_option_partial')}
                            </span>
                            <span className="block text-muted-foreground">
                              {account ? t('payment_fee_hint_fee') : t('payment_fee_hint_partial')}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              }

              const txAbs = Math.abs(transaction.amount)
              const invRemaining = isSupplierInvoice
                ? transaction.potential_supplier_invoice!.remaining_amount ?? transaction.potential_supplier_invoice!.total
                : transaction.potential_invoice!.remaining_amount ?? transaction.potential_invoice!.total
              const invCurrency = isSupplierInvoice
                ? transaction.potential_supplier_invoice!.currency
                : transaction.potential_invoice!.currency
              const sameCurrency = transaction.currency === invCurrency
              // Cross-currency "match" comparison is meaningless without an FX
              // conversion: show the explicit different-currencies warning
              // and skip the numeric match check. The committed verifikat is
              // built by buildInvoicePaymentClearingLines, which posts the
              // FX diff to 3960/7960 so the books balance correctly even
              // when the on-screen numbers can't be naively compared.
              const diff = Math.abs(txAbs - invRemaining)
              const amountsMatch = sameCurrency && diff < 0.01
              // A sub-krona SEK difference is öresavrundning: the backend books
              // it to 3740 and settles the invoice in full instead of leaving it
              // delbetald (see ORE_ROUNDING_SETTLEMENT_MAX). SEK only: keep the
              // 1 kr band in sync with the server constant.
              const isOreRounding =
                sameCurrency && transaction.currency === 'SEK' && diff >= 0.01 && diff < 1.0

              // Supplier row that paid more than the invoice (card or transfer
              // fee on top): the preview books the excess on 6570 and settles
              // the invoice in full, so this is not a difference to resolve.
              const bankFeeSek = isSupplierInvoice ? (preview?.bank_fee_sek ?? 0) : 0

              // The same excess is just as often a second invoice paid in the
              // same transfer: offer the batch beside the fee or overpayment.
              const splitLink =
                onSplitAcrossInvoices && sameCurrency && txAbs - invRemaining >= 1 ? (
                  <button
                    type="button"
                    className={cn(QUIET_LINK_CLASS, 'mt-1 block text-left')}
                    onClick={onSplitAcrossInvoices}
                    disabled={isConfirming}
                  >
                    {t('split_across_invoices')}
                  </button>
                ) : null

              if (amountsMatch) {
                return (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                    <p className="text-sm font-medium">{t('amounts_match')}</p>
                  </div>
                )
              }

              if (isOreRounding) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <p className="text-sm font-medium">
                      {t('ore_rounding_note', {
                        amount: formatCurrency(diff, transaction.currency),
                      })}
                    </p>
                  </div>
                )
              }

              if (bankFeeSek > 0) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">
                        {t('bank_fee_note', {
                          amount: formatCurrency(diff, transaction.currency),
                        })}
                      </p>
                      {splitLink}
                    </div>
                  </div>
                )
              }

              return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 text-attn">
                  <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium">{t('amounts_differ')}</p>
                    <p>
                      {sameCurrency ? (
                        <>
                          {t('amount_diff', {
                            amount: formatCurrency(
                              Math.abs(txAbs - invRemaining),
                              transaction.currency,
                            ),
                          })}
                          {isSupplierInvoice &&
                            t(txAbs > invRemaining ? 'overpayment_note' : 'partial_payment_note')}
                        </>
                      ) : (
                        t('different_currencies')
                      )}
                    </p>
                    {splitLink}
                  </div>
                </div>
              )
            })()}

            {/* Third FX state: the invoice is in a foreign currency and no
                booking rate was ever stored, so the SEK value of the 1510
                receivable is unknown and the kursvinst/kursförlust on
                settlement is not a computable number.
                buildInvoicePaymentClearingLines refuses to build the verifikat
                (MATCH_INVOICE_BOOKING_RATE_MISSING) on both the preview GET and
                the commit POST, so there is nothing to approve: say that up
                front instead of showing a confident zero. Rendered on its own
                rather than inside the Valutaomräkning card below, because in
                this state the preview 400s and that card never renders. */}
            {!targetBlocked && invoiceRateMissing && (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex items-start gap-2">
                  <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 text-attn flex-shrink-0" />
                  <div className="flex-1 text-sm">
                    {/* Untinted title, matching the sibling
                        fx_rate_unavailable panel below: the ochre lives in the
                        icon and the surface, not in the heading. */}
                    <p className="font-medium">{t('fx_invoice_rate_missing_title')}</p>
                    <p className="text-muted-foreground mt-1">
                      {t('fx_invoice_rate_missing_description', {
                        invoiceCurrency: invoiceCurrency ?? '',
                      })}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Valutaomräkning section: only renders when the preview
                route flagged a cross-currency settlement (a SEK invoice
                paid in SEK has no FX effect and renders nothing here).
                Shows the Riksbanken rate + invoice-currency-equivalent of
                the bank payment + the projected post-payment invoice state.
                When the payment-date rate lookup failed, swaps in a
                manual-rate input so the user can type the rate from their
                bank statement and retry. */}
            {!targetBlocked && preview?.fx_conversion?.required && (() => {
              const fx = preview.fx_conversion
              if (!fx?.required) return null
              // fx_conversion is only produced by the customer-invoice preview
              // route. No invoice row means there is nothing honest to show:
              // render nothing rather than fall back to zeroed money.
              const inv = transaction.potential_invoice
              if (!inv) return null
              const invRemaining = inv.remaining_amount ?? inv.total

              if ('error' in fx) {
                // Riksbanken unavailable: show manual rate input.
                return (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 text-attn flex-shrink-0" />
                      <div className="flex-1 text-sm">
                        <p className="font-medium">{t('fx_rate_unavailable_title')}</p>
                        <p className="text-muted-foreground mt-1">
                          {t('fx_rate_unavailable_description', {
                            date: transaction ? formatDate(transaction.date) : '',
                            invoiceCurrency: fx.invoice_currency,
                          })}
                        </p>
                      </div>
                    </div>
                    {/* The typed rate flows through onConfirm.manual_exchange_rate
                        and the route recomputes server-side, so the footer
                        Confirm button is the trigger: no separate apply button.
                        Confirm stays disabled until a positive rate is entered
                        (see DialogFooter guard below). */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('fx_manual_rate_label')}
                      </label>
                      <Input
                        inputMode="decimal"
                        value={manualRate}
                        onChange={(e) => setManualRate(e.target.value)}
                        placeholder={t('fx_manual_rate_placeholder')}
                        className="tabular-nums"
                      />
                    </div>
                  </div>
                )
              }

              const paidInInvoice = fx.paid_in_invoice_currency
              const remainingAfter = Math.max(0, Math.round((invRemaining - paidInInvoice) * 100) / 100)
              const willBeFullyPaid = remainingAfter <= 0
              // The kursvinst/kursförlust note is READ OFF the previewed
              // verifikat (3960 credit = vinst, 7960 debit = förlust) instead
              // of recomputed from the invoice here: see previewedFxGainSek.
              const fxGain = previewedFxGainSek(preview.lines)

              return (
                <div className="rounded-lg border bg-card p-4 space-y-3">
                  <p className="text-sm font-medium">{t('fx_title')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('fx_rate_description', {
                      date: fx.rate_date,
                      invoiceCurrency: fx.invoice_currency,
                      rate: fx.rate.toFixed(4).replace('.', ','),
                    })}
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-sm pt-1">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('fx_paid_in_invoice_currency', { amount: '' }).replace(': ', '')}
                      </p>
                      <p className="font-medium tabular-nums mt-0.5">
                        {formatCurrency(paidInInvoice, fx.invoice_currency)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('fx_remaining_after', { amount: '' }).replace(': ', '')}
                      </p>
                      <p className="font-medium tabular-nums mt-0.5">
                        {formatCurrency(remainingAfter, fx.invoice_currency)}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {willBeFullyPaid ? t('fx_status_paid') : t('fx_status_partially_paid')}
                    {!invoiceRateMissing && Math.abs(fxGain) > 0.005 && (
                      <>
                        {' · '}
                        {fxGain > 0
                          ? t('fx_gain_note', { amount: formatCurrency(fxGain, 'SEK') })
                          : t('fx_loss_note', { amount: formatCurrency(Math.abs(fxGain), 'SEK') })}
                      </>
                    )}
                  </p>
                </div>
              )
            })()}

            {/* Bookkeeping preview: editable. Read-only by default; user
                clicks "Redigera" to switch the rows to inputs. Suppressed
                entirely when the invoice's missing booking rate is what
                blocked the preview: the ochre panel above already owns that
                story, and an empty "Bokföring" card with a second phrasing of
                the same refusal reads as two separate problems. */}
            {/* An unbooked supplier invoice is booked first: its
                registration verifikat, read-only, above the payment's rows. */}
            {!targetBlocked && isSupplierInvoice && preview?.registration_entry && (
              <RegistrationFirstCard entry={preview.registration_entry} />
            )}

            {!targetBlocked && (preview || (previewFailure && !invoiceRateMissing)) && (
              <PaymentPreviewLinesCard
                editor={editor}
                lines={preview && !overpaymentUnplaced && !feeUnplaced ? preview.lines : null}
                canEdit={!!preview && !overpaymentUnplaced && !feeUnplaced}
                disabled={isConfirming}
              >
                {/* Prefer the route's own structured message (resolved through
                    getErrorMessage, so it follows the UI locale) over the
                    generic "continue or cancel" copy: when the server named a
                    reason the user can act on it, and "continue" is often not
                    actually available. */}
                {previewFailure && !preview && previewFailure.registrationFirst && (
                  <p className="text-sm text-muted-foreground">{t('registration_first_refused')}</p>
                )}
                {previewFailure && !preview && (
                  <p className="text-sm text-muted-foreground">
                    {previewFailure.message ?? t('booking_unavailable')}
                  </p>
                )}
                {overpaymentUnplaced && (
                  <p className="text-sm text-muted-foreground">{t('customer_overpayment_choose_first')}</p>
                )}
                {feeUnplaced && (
                  <p className="text-sm text-muted-foreground">{t('payment_fee_choose_first')}</p>
                )}
              </PaymentPreviewLinesCard>
            )}

            {!targetBlocked && (
              <div className="rounded-lg bg-muted/50 p-4 space-y-2">
                <p className="text-sm font-medium">{t('on_confirm_title')}</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• {isSupplierInvoice ? t('on_confirm_link_supplier') : t('on_confirm_link_customer')}</li>
                  <li>• {isSupplierInvoice ? t('on_confirm_mark_paid_supplier') : t('on_confirm_mark_paid_customer')}</li>
                  <li>• {t('on_confirm_voucher')}</li>
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConfirming}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => handleConfirm()}
            disabled={
              isConfirming ||
              isCheckingDuplicate ||
              // A booked row: the plain match is refused again; the soft
              // block's own button is the only way on.
              (isSupplierInvoice && !!alreadyBooked) ||
              // Blocked target: the route rejects this unconditionally, so the
              // button has no reachable success path.
              targetBlocked ||
              // The user's rows, in the grid or kept after Klart, book only once valid.
              !editor.validation.isValid ||
              // Block confirm when cross-currency lookup failed and the user
              // hasn't typed a manual rate yet. Same-currency and auto-rate
              // paths pass through unaffected.
              (preview?.fx_conversion?.required === true &&
                'error' in preview.fx_conversion &&
                parseRate(manualRate) <= 0) ||
              // Cross-currency invoice with no booked exchange rate: the FX
              // result of the settlement is uncomputable, so there is no
              // honest entry to approve and the POST would reject it with the
              // same MATCH_INVOICE_BOOKING_RATE_MISSING the preview already
              // returned. A hand-written entry is still allowed through: the
              // user has then supplied the numbers themselves rather than
              // approving a fabricated preview. (Edit mode requires a
              // successful preview to enter, so today this only relaxes the
              // guard in the defense-in-depth branch of
              // isInvoiceBookingRateMissing.)
              (invoiceRateMissing && !(editor.isEdited && editor.validation.isValid)) ||
              // A customer overpayment books only on the account the user
              // picked, and only once the preview shows that account's rows.
              (!!customerOverpayment &&
                (!customerOverpayment.account || customerOverpayment.account !== overpaymentAccount)) ||
              // The fee books only once the preview shows the user's choice,
              // and a required one only once it is named.
              (!!customerFee && (feeUnplaced || (customerFee.account ?? null) !== feeAccount))
            }
          >
            {isConfirming ? t('confirming') : t('confirm_match')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
