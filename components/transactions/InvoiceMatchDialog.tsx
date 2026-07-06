'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { CheckCircle2, AlertTriangle, Trash2, Plus, Pencil } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'
import type { BASAccount } from '@/types'

interface DuplicateCandidate {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  amount: number
  bank_account_number: string
  reason: 'exact_amount_same_date' | 'exact_amount_within_window'
}

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
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
  lines: PreviewLine[]
  invoice_already_booked: boolean
  accounting_method: 'accrual' | 'cash'
  is_fully_paid: boolean
  fx_conversion?: FxConversion
}

// String-typed working copy of a line. The amount is a single value plus a
// side (debit / credit): modeling a verifikationsrad as one positive number
// with a direction matches how Swedish accountants think and tightens the
// failure modes (you can't accidentally fill both sides). Conversion back
// to the server's { debit_amount, credit_amount } shape happens at submit.
interface EditableLine {
  account_number: string
  side: 'debit' | 'credit'
  amount: string
  description: string
}

export interface ConfirmOpts {
  force?: boolean
  expected_journal_entry_id?: string
  lines?: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description?: string
  }>
  // Manual SEK-per-invoice-currency override used when Riksbanken's rate
  // for the payment date isn't available; the dialog asks the user to type
  // the rate from their bank statement. Same field flows to the route.
  manual_exchange_rate?: number
}

interface InvoiceMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: (opts?: ConfirmOpts) => void
  onLinkToExisting?: (journalEntryId: string) => void
}

function previewToEditable(line: PreviewLine): EditableLine {
  const isDebit = line.debit_amount > 0
  return {
    account_number: line.account_number,
    side: isDebit ? 'debit' : 'credit',
    amount: String(isDebit ? line.debit_amount : line.credit_amount),
    description: line.description,
  }
}

function parseAmount(s: string): number {
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default function InvoiceMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
  onLinkToExisting,
}: InvoiceMatchDialogProps) {
  const t = useTranslations('tx_invoice_match')
  const isSupplierInvoice = !!transaction?.potential_supplier_invoice
  const isCustomerInvoice = !!transaction?.potential_invoice
  const transactionId = transaction?.id ?? null

  const [candidate, setCandidate] = useState<DuplicateCandidate | null>(null)
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false)

  const invoiceId = transaction?.potential_invoice?.id ?? null
  const supplierInvoiceId = transaction?.potential_supplier_invoice?.id ?? null
  const [preview, setPreview] = useState<MatchPreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editLines, setEditLines] = useState<EditableLine[]>([])
  // Manual SEK-per-invoice-currency rate the user types when Riksbanken has
  // no rate for the payment date. Empty string = no override; on submit it
  // flows through ConfirmOpts.manual_exchange_rate to the route, which
  // re-runs the preview math with the supplied rate.
  const [manualRate, setManualRate] = useState<string>('')
  // BAS accounts power the AccountCombobox suggestions in edit mode. Loaded
  // once on dialog open; same endpoint that PaymentBookingDialog uses.
  const [accounts, setAccounts] = useState<BASAccount[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/bookkeeping/accounts')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setAccounts((data?.data as BASAccount[]) ?? [])
      } catch {
        // Non-fatal: combobox just shows no suggestions, user can still
        // type the number manually.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !transactionId) {
      setPreview(null)
      setPreviewFailed(false)
      setIsEditing(false)
      setEditLines([])
      setManualRate('')
      return
    }
    let cancelled = false
    const previewUrl = isCustomerInvoice && invoiceId
      ? `/api/transactions/${transactionId}/match-invoice/preview?invoice_id=${invoiceId}`
      : isSupplierInvoice && supplierInvoiceId
        ? `/api/transactions/${transactionId}/match-supplier-invoice/preview?supplier_invoice_id=${supplierInvoiceId}`
        : null
    if (!previewUrl) {
      setPreview(null)
      setPreviewFailed(false)
      return
    }
    async function loadPreview() {
      setPreviewFailed(false)
      try {
        const res = await fetch(previewUrl!)
        if (!res.ok) {
          if (!cancelled) setPreviewFailed(true)
          return
        }
        const data = (await res.json()) as MatchPreview
        if (!cancelled) {
          setPreview(data)
          setEditLines(data.lines.map(previewToEditable))
        }
      } catch {
        if (!cancelled) setPreviewFailed(true)
      }
    }
    loadPreview()
    return () => {
      cancelled = true
    }
  }, [open, transactionId, isCustomerInvoice, isSupplierInvoice, invoiceId, supplierInvoiceId])

  useEffect(() => {
    if (!open || !transactionId || !isCustomerInvoice || !onLinkToExisting) {
      setCandidate(null)
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
  }, [open, transactionId, isCustomerInvoice, onLinkToExisting])

  // Live balance + validity. The dialog disables Confirm while edit mode is
  // active and the entry is invalid; an out-of-balance entry can't be sent.
  const editValidation = useMemo(() => {
    if (!isEditing) return { isBalanced: true, isValid: true, diff: 0, totalDebit: 0, totalCredit: 0, accountInvalid: false }
    const totalDebit = round2(
      editLines.filter((l) => l.side === 'debit').reduce((s, l) => s + parseAmount(l.amount), 0),
    )
    const totalCredit = round2(
      editLines.filter((l) => l.side === 'credit').reduce((s, l) => s + parseAmount(l.amount), 0),
    )
    const isBalanced = totalDebit === totalCredit && totalDebit > 0
    const accountInvalid = editLines.some((l) => !/^\d{4}$/.test(l.account_number.trim()))
    return {
      isBalanced,
      accountInvalid,
      isValid: isBalanced && !accountInvalid,
      diff: round2(totalDebit - totalCredit),
      totalDebit,
      totalCredit,
    }
  }, [isEditing, editLines])

  const handleConfirm = (opts?: { force?: boolean; expected_journal_entry_id?: string }) => {
    const linesPayload = isEditing && preview && editValidation.isValid
      ? editLines.map((l) => {
          const amount = round2(parseAmount(l.amount))
          return {
            account_number: l.account_number.trim(),
            debit_amount: l.side === 'debit' ? amount : 0,
            credit_amount: l.side === 'credit' ? amount : 0,
            line_description: l.description?.trim() || undefined,
          }
        })
      : undefined
    // Forward manual rate only when the preview indicated Riksbanken
    // failed AND the user typed a value. Same-currency settlements and
    // the auto-fetched cross-currency case both skip this field.
    const fx = preview?.fx_conversion
    const fxNeedsManualRate = fx?.required === true && 'error' in fx
    const manualRateNum = fxNeedsManualRate ? parseAmount(manualRate) : 0
    const manualRatePayload =
      fxNeedsManualRate && manualRateNum > 0 ? { manual_exchange_rate: manualRateNum } : {}
    onConfirm({
      ...(opts ?? {}),
      ...(linesPayload ? { lines: linesPayload } : {}),
      ...manualRatePayload,
    })
  }

  const resetEdits = () => {
    if (preview) setEditLines(preview.lines.map(previewToEditable))
  }

  const addEditLine = () => {
    setEditLines((prev) => [...prev, { account_number: '', side: 'debit', amount: '', description: '' }])
  }

  const removeEditLine = (i: number) => {
    setEditLines((prev) => prev.filter((_, idx) => idx !== i))
  }

  const updateEditLine = (i: number, patch: Partial<EditableLine>) => {
    setEditLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const matchTitle = isSupplierInvoice ? t('title_supplier') : t('title_customer')
  const matchDescription = isSupplierInvoice
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
            {/* Duplicate-payment warning: customer-side only, only when a candidate exists */}
            {candidate && isCustomerInvoice && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-warning-foreground" />
                  <div className="text-sm space-y-1">
                    <p className="font-medium text-warning-foreground">{t('duplicate_title')}</p>
                    <p className="text-muted-foreground">
                      {candidate.reason === 'exact_amount_same_date'
                        ? t('duplicate_body_same_date', {
                            label: candidate.voucher_label,
                            amount: formatCurrency(candidate.amount, transaction.currency),
                          })
                        : t('duplicate_body_window', {
                            label: candidate.voucher_label,
                            amount: formatCurrency(candidate.amount, transaction.currency),
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

            {/* Invoice details. Shows remaining_amount (what the customer
                still owes) rather than the original total, so a partially-
                paid invoice displays the actual figure the user is matching
                against. Mirrors the supplier-invoice block below. */}
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

              if (amountsMatch) {
                return (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                    <p className="text-sm font-medium">{t('amounts_match')}</p>
                  </div>
                )
              }

              if (isOreRounding) {
                return (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <p className="text-sm font-medium">
                      {t('ore_rounding_note', {
                        amount: formatCurrency(diff, transaction.currency),
                      })}
                    </p>
                  </div>
                )
              }

              return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 text-warning-foreground">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
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
                          {isSupplierInvoice && t('partial_payment_note')}
                        </>
                      ) : (
                        t('different_currencies')
                      )}
                    </p>
                  </div>
                </div>
              )
            })()}

            {/* Valutaomräkning section: only renders when the preview
                route flagged a cross-currency settlement. Shows the
                Riksbanken rate + invoice-currency-equivalent of the bank
                payment + the projected post-payment invoice state. When
                the rate lookup failed, swaps in a manual-rate input so
                the user can type the rate from their bank statement and
                retry. */}
            {preview?.fx_conversion?.required && (() => {
              const fx = preview.fx_conversion
              if (!fx?.required) return null
              const txAbs = transaction ? Math.abs(transaction.amount) : 0
              const invRemaining = transaction?.potential_invoice?.remaining_amount
                ?? transaction?.potential_invoice?.total
                ?? 0

              if ('error' in fx) {
                // Riksbanken unavailable: show manual rate input.
                return (
                  <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 text-warning-foreground flex-shrink-0" />
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
              // FX gain/loss for the kursvinst/kursförlust note: bankSek -
              // arSek, where arSek = paidInInvoice × invoice.exchange_rate.
              // Positive number = the SEK we received exceeded the SEK
              // value of the debt reduction (kursvinst).
              const invoiceRate = transaction?.potential_invoice?.exchange_rate ?? 0
              const arSek = invoiceRate > 0 ? Math.round(paidInInvoice * invoiceRate * 100) / 100 : 0
              const fxGain = invoiceRate > 0 ? Math.round((txAbs - arSek) * 100) / 100 : 0

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
                    {Math.abs(fxGain) > 0.005 && (
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
                clicks "Redigera" to switch the rows to inputs. */}
            {(preview || previewFailed) && (
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{t('booking_title')}</p>
                  {preview && (
                    <div className="flex gap-2">
                      {isEditing && (
                        <Button variant="ghost" size="sm" onClick={resetEdits} disabled={isConfirming}>
                          {t('booking_reset')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsEditing((v) => !v)}
                        disabled={isConfirming}
                      >
                        {isEditing ? t('booking_done_editing') : (
                          <>
                            <Pencil className="h-3 w-3 mr-1" />
                            {t('booking_edit')}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>

                {previewFailed && !preview && (
                  <p className="text-sm text-muted-foreground">{t('booking_unavailable')}</p>
                )}

                {preview && !isEditing && (
                  <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t('booking_account')}
                    </div>
                    <div />
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">
                      {t('booking_debit')}
                    </div>
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">
                      {t('booking_credit')}
                    </div>
                    {/* Verifikat amounts are always denominated in SEK (the
                        bookkeeping home currency): the preview route builds
                        every line via resolveSekAmount. Format them as SEK,
                        NOT transaction.currency, otherwise a foreign-currency
                        payment (e.g. 19 USD) shows the converted SEK figure
                        with the wrong symbol ("175,28 US$" instead of
                        "175,28 kr"). */}
                    {preview.lines.map((line, i) => (
                      <div key={i} className="contents">
                        <div className="font-medium">{line.account_number}</div>
                        <div className="text-muted-foreground truncate">{line.description}</div>
                        <div className="text-right">
                          {line.debit_amount > 0
                            ? formatCurrency(line.debit_amount, 'SEK')
                            : ''}
                        </div>
                        <div className="text-right">
                          {line.credit_amount > 0
                            ? formatCurrency(line.credit_amount, 'SEK')
                            : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {preview && isEditing && (
                  <div className="space-y-2">
                    {editLines.map((line, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[minmax(180px,1.6fr)_minmax(0,1fr)_140px_110px_28px] gap-2 items-center"
                      >
                        <AccountCombobox
                          value={line.account_number}
                          accounts={accounts}
                          onChange={(acc) => updateEditLine(i, { account_number: acc })}
                        />
                        <Input
                          value={line.description}
                          onChange={(e) => updateEditLine(i, { description: e.target.value })}
                          placeholder={t('booking_description_placeholder')}
                        />
                        {/* Side toggle: segmented control. Clicking either
                            button picks that side; the amount stays the
                            same. */}
                        <div className="inline-flex rounded-md border bg-background overflow-hidden h-9">
                          <button
                            type="button"
                            onClick={() => updateEditLine(i, { side: 'debit' })}
                            className={cn(
                              'flex-1 px-2 text-xs font-medium transition-colors',
                              line.side === 'debit'
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:bg-secondary/60',
                            )}
                            aria-pressed={line.side === 'debit'}
                          >
                            {t('booking_debit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateEditLine(i, { side: 'credit' })}
                            className={cn(
                              'flex-1 px-2 text-xs font-medium border-l transition-colors',
                              line.side === 'credit'
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:bg-secondary/60',
                            )}
                            aria-pressed={line.side === 'credit'}
                          >
                            {t('booking_credit')}
                          </button>
                        </div>
                        <Input
                          inputMode="decimal"
                          value={line.amount}
                          onChange={(e) => updateEditLine(i, { amount: e.target.value })}
                          className="text-right tabular-nums"
                          placeholder="0"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeEditLine(i)}
                          disabled={editLines.length <= 2}
                          aria-label={t('booking_remove_line')}
                          className="h-8 w-8"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}

                    <div className="flex items-center justify-between pt-1">
                      <Button variant="ghost" size="sm" onClick={addEditLine}>
                        <Plus className="h-3 w-3 mr-1" />
                        {t('booking_add_line')}
                      </Button>
                      <div className="text-xs tabular-nums text-muted-foreground">
                        {/* SEK: edited verifikat rows are home-currency, like the read-only preview above. */}
                        {t('booking_debit')} {formatCurrency(editValidation.totalDebit, 'SEK')}
                        {' / '}
                        {t('booking_credit')} {formatCurrency(editValidation.totalCredit, 'SEK')}
                      </div>
                    </div>

                    {!editValidation.isBalanced && (
                      <p className="text-xs text-destructive">
                        {t('booking_unbalanced', {
                          diff: formatCurrency(Math.abs(editValidation.diff), 'SEK'),
                        })}
                      </p>
                    )}
                    {editValidation.accountInvalid && (
                      <p className="text-xs text-destructive">{t('booking_account_invalid')}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* What will happen */}
            <div className="rounded-lg bg-muted/50 p-4 space-y-2">
              <p className="text-sm font-medium">{t('on_confirm_title')}</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• {isSupplierInvoice ? t('on_confirm_link_supplier') : t('on_confirm_link_customer')}</li>
                <li>• {isSupplierInvoice ? t('on_confirm_mark_paid_supplier') : t('on_confirm_mark_paid_customer')}</li>
                <li>• {t('on_confirm_voucher')}</li>
              </ul>
            </div>
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
              (isEditing && !editValidation.isValid) ||
              // Block confirm when cross-currency lookup failed and the user
              // hasn't typed a manual rate yet. Same-currency and auto-rate
              // paths pass through unaffected.
              (preview?.fx_conversion?.required === true &&
                'error' in preview.fx_conversion &&
                parseAmount(manualRate) <= 0)
            }
          >
            {isConfirming ? t('confirming') : t('confirm_match')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
