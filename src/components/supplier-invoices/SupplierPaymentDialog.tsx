'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LinkVoucherPicker from '@/components/invoices/LinkVoucherPicker'
import { RegistrationFirstCard, type RegistrationEntryPreview } from '@/components/supplier-invoices/RegistrationFirstCard'
import { BankHeldPaymentNotes, useBankHeldPaymentWarnings } from '@/components/payments/BankHeldPaymentNotes'
import { SIGNED_BANK_PAYMENT_WARNING } from '@/lib/payments/orders/bank-held-codes'
import { PaymentPreviewLinesCard, usePaymentPreviewEditor } from '@/components/bookkeeping/PaymentPreviewLinesCard'
import type { LineDimensions } from '@/components/bookkeeping/payment-line-dimensions'
import type { PaymentPreviewLine } from '@/components/bookkeeping/payment-preview-lines'
import { useAccounts, usePaymentBankLedger } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import { formatAmountInput, parseAmountInput } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { SupplierInvoice } from '@/types'

interface MarkPaidPreview {
  entry_type: 'clearing' | 'cash'
  /** Always SEK, whatever the invoice's currency. */
  lines: PaymentPreviewLine[]
  invoice_already_booked: boolean
  accounting_method: 'accrual' | 'cash'
  /** SEK credited to the payment account: what an empty "Betalt i SEK" books. */
  paid_sek?: number
  /** The invoice's bag, given to a row the user adds. */
  document_dimensions?: LineDimensions
  /**
   * An unbooked invoice of a company that books in a separate step: the
   * registration verifikat the payment books first, else null.
   */
  registration_entry?: RegistrationEntryPreview | null
}

interface DuplicateCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  /** `already_booked`: the row is already a verifikat; the remedy is a rättelse, not a link. */
  match_reason?: string
  journal_entry_id?: string | null
}

interface SupplierPaymentDialogProps {
  invoice: SupplierInvoice
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The company's last-used supplier payment account; the primary bank account when it has none. */
  defaultPaymentAccount?: string | null
  /** After a payment was booked or an existing voucher linked: refetch the invoice. */
  onPaid: () => void | Promise<void>
}

/**
 * "Registrera betalning" for a supplier invoice: a new payment (date, amount,
 * SEK paid for a foreign invoice, payment account, and the "Bokföring" card
 * with the verifikat mark-paid would post, editable) or an existing voucher
 * (LinkVoucherPicker). A payment the server holds as a likely duplicate of a
 * bank row opens the duplicate warning, from which it can still be booked.
 * The customer side's twin is components/invoices/PaymentBookingDialog.
 */
export function SupplierPaymentDialog({
  invoice,
  open,
  onOpenChange,
  defaultPaymentAccount,
  onPaid,
}: SupplierPaymentDialogProps) {
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_detail')
  const tMatch = useTranslations('tx_invoice_match')
  const [payTab, setPayTab] = useState<'new' | 'existing'>('new')
  const [payAmount, setPayAmount] = useState(() => formatAmountInput(invoice.remaining_amount))
  // Foreign-currency invoice: the SEK that left the account. Empty means the
  // SEK the preview shows (paid_sek), i.e. no kursdifferens.
  const [paySek, setPaySek] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => todayIsoStockholm())
  // The last-used account, then whatever the person picks; else the primary.
  const paymentLedger = usePaymentBankLedger()
  const [pickedAccount, setPaymentAccount] = useState(defaultPaymentAccount || null)
  const paymentAccount = pickedAccount ?? paymentLedger
  const [isProcessing, setIsProcessing] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[] | null>(null)
  // Chart of accounts for the payment account, from the session cache.
  const { accounts, isLoading: areAccountsLoading } = useAccounts()
  const [markPaidPreview, setMarkPaidPreview] = useState<MarkPaidPreview | null>(null)
  const [markPaidPreviewFailed, setMarkPaidPreviewFailed] = useState(false)
  // The refusal the preview returned (its Swedish message and code), shown in
  // place of the rows: e.g. SI_PAID_SEK_UNRESOLVED or an overpaid foreign
  // invoice, which the POST would refuse the same way.
  // registrationFirst: the refusal came from booking the invoice first.
  const [markPaidPreviewError, setMarkPaidPreviewError] = useState<
    { message: string; code: string | null; registrationFirst: boolean } | null
  >(null)
  const editor = usePaymentPreviewEditor(markPaidPreview?.lines, markPaidPreview?.document_dimensions)
  const { stopEditing } = editor
  // A payment the bank holds for the invoice (Betala via banken): a signed
  // one still goes out on its date, so a payment or a verifikat beside it is
  // refused until it is cancelled; an unsigned one is cancelled at the bank
  // once the invoice is paid. Read on every opening.
  const { warnings: bankPaymentWarnings, failed: bankPaymentCheckFailed } = useBankHeldPaymentWarnings(
    open ? [invoice.id] : [],
    'other',
  )

  // Every opening starts from the invoice as it is now: what is still owed,
  // today and the last-used account. Closing drops the edited grid and the
  // SEK figure, so the next opening starts from the server's default booking.
  // (State adjusted during render on the open edge, not in an effect.)
  const [wasOpen, setWasOpen] = useState(false)
  if (open && !wasOpen) {
    setWasOpen(true)
    setPayAmount(formatAmountInput(invoice.remaining_amount))
    setPaySek('')
    setPaymentDate(todayIsoStockholm())
    if (defaultPaymentAccount) setPaymentAccount(defaultPaymentAccount)
  } else if (!open && wasOpen) {
    setWasOpen(false)
    setPayTab('new')
    setPaySek('')
    stopEditing()
  }

  // "174,50" and "174.50" both read 174.5; null when the text is not an amount.
  const payAmountNum = parseAmountInput(payAmount)
  const isForeignInvoice = invoice.currency !== 'SEK'
  const paySekNum = isForeignInvoice ? parseAmountInput(paySek) : null
  const paySekOverride = paySekNum !== null && paySekNum > 0 ? paySekNum : undefined

  // Load a preview of the verifikat mark-paid would post. Refetches when the
  // amount, the payment account or the SEK paid changes, so the rows always
  // reflect the current inputs.
  useEffect(() => {
    if (!open) {
      setMarkPaidPreview(null)
      setMarkPaidPreviewFailed(false)
      setMarkPaidPreviewError(null)
      return
    }
    if (payAmountNum === null || payAmountNum <= 0) {
      setMarkPaidPreview(null)
      return
    }
    let cancelled = false
    const ctrl = new AbortController()
    ;(async () => {
      setMarkPaidPreviewFailed(false)
      setMarkPaidPreviewError(null)
      try {
        const qs = new URLSearchParams({
          amount: String(payAmountNum),
          payment_account: paymentAccount,
          payment_date: paymentDate,
          ...(paySekOverride !== undefined ? { amount_sek: String(paySekOverride) } : {}),
        })
        const res = await fetch(
          `/api/supplier-invoices/${invoice.id}/mark-paid/preview?${qs.toString()}`,
          { signal: ctrl.signal },
        )
        if (!res.ok) {
          const errBody = await res.json().catch(() => null)
          if (!cancelled) {
            const errorField = (errBody as { error?: { code?: string; details?: { registration_first?: unknown } } } | null)?.error
            setMarkPaidPreviewError({
              message: getErrorMessage(errBody, { statusCode: res.status, context: 'supplier_invoice' }),
              code: errorField?.code ?? null,
              registrationFirst: errorField?.details?.registration_first === true,
            })
            setMarkPaidPreviewFailed(true)
          }
          return
        }
        const data = (await res.json()) as MarkPaidPreview
        if (!cancelled) setMarkPaidPreview(data)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        if (!cancelled) setMarkPaidPreviewFailed(true)
      }
    })()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [open, invoice.id, payAmountNum, paymentAccount, paySekOverride, paymentDate])

  async function handleMarkPaid(force: boolean = false) {
    setIsProcessing(true)
    // Edited rows go to the server, which validates the balance and posts
    // them as they are; otherwise it picks the default routing (clearing or
    // cash) from the invoice's booking state.
    const linesPayload = editor.payload

    try {
      const res = await fetch(`/api/supplier-invoices/${invoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: payAmountNum,
          payment_date: paymentDate,
          payment_account: paymentAccount,
          // Edited rows already state every SEK amount.
          ...(paySekOverride !== undefined && !linesPayload ? { amount_sek: paySekOverride } : {}),
          ...(force ? { force: true } : {}),
          ...(linesPayload ? { lines: linesPayload } : {}),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        if (result?.error?.code === 'SI_PAID_LIKELY_DUPLICATE' && Array.isArray(result.error.details?.candidates)) {
          setDuplicateCandidates(result.error.details.candidates)
          onOpenChange(false)
        } else {
          toast({ title: t('payment_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        }
      } else {
        toast({
          title: result.status === 'paid' ? t('paid_title') : t('partial_payment_title'),
          // The paid amount is in the invoice's currency (the dialog's helper
          // text says so): the toast must not relabel it as kr.
          description: t('amount_registered_description', {
            amount: formatCurrency(payAmountNum ?? 0, invoice.currency || 'SEK'),
          }),
        })
        onOpenChange(false)
        setDuplicateCandidates(null)
        await onPaid()
      }
    } catch (err) {
      toast({ title: t('payment_failed_title'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pay_dialog_title')}</DialogTitle>
          </DialogHeader>
          <BankHeldPaymentNotes
            warnings={
              // The new payment's preview refuses a signed one in its own
              // words (SI_BANK_PAYMENT_UNDER_WAY), with the same way out:
              // said once. The existing verifikat's tab has no preview.
              payTab === 'new'
                ? bankPaymentWarnings.filter((warning) => warning.code !== SIGNED_BANK_PAYMENT_WARNING)
                : bankPaymentWarnings
            }
            failed={bankPaymentCheckFailed}
          />
          <Tabs value={payTab} onValueChange={(v) => setPayTab(v as 'new' | 'existing')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="new">{t('tab_new_payment')}</TabsTrigger>
              <TabsTrigger value="existing">{t('tab_existing_voucher')}</TabsTrigger>
            </TabsList>
            <TabsContent value="new" className="mt-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="payment-date">{t('payment_date_label')}</Label>
                  <Input
                    id="payment-date"
                    type="date"
                    value={paymentDate}
                    max={todayIsoStockholm()}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full sm:w-48"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payment-amount">{t('payment_amount_label')}</Label>
                  <Input
                    id="payment-amount"
                    inputMode="decimal"
                    value={payAmount}
                    onChange={(e) => {
                      setPayAmount(e.target.value)
                      // A SEK figure typed for one amount says nothing about another.
                      setPaySek('')
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('remaining_to_pay', { amount: formatAmount(invoice.remaining_amount), currency: invoice.currency })}
                  </p>
                </div>
                {isForeignInvoice && (
                  <div className="space-y-2">
                    <Label htmlFor="payment-amount-sek">{t('paid_sek_label')}</Label>
                    <Input
                      id="payment-amount-sek"
                      inputMode="decimal"
                      value={paySek}
                      onChange={(e) => setPaySek(e.target.value)}
                      placeholder={markPaidPreview?.paid_sek != null ? formatAmount(markPaidPreview.paid_sek) : undefined}
                      disabled={editor.isEdited}
                      className="w-full sm:w-48 text-right tabular-nums"
                    />
                    {markPaidPreview?.paid_sek != null && (
                      <p className="text-xs text-muted-foreground">
                        {t('paid_sek_help', { amount: formatCurrency(markPaidPreview.paid_sek, 'SEK') })}
                        {markPaidPreview.entry_type === 'clearing' && <> {t('paid_sek_difference_note')}</>}
                      </p>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="payment-account">{t('payment_account_label')}</Label>
                  {areAccountsLoading ? (
                    <Skeleton className="h-10 w-full" />
                  ) : (
                    <AccountCombobox
                      value={paymentAccount}
                      accounts={accounts}
                      onChange={setPaymentAccount}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">{t('payment_account_help')}</p>
                </div>

                {/* An unbooked invoice is booked first: its registration
                    verifikat, read-only, above the payment's rows. */}
                {markPaidPreview?.registration_entry && !markPaidPreviewFailed && (
                  <RegistrationFirstCard entry={markPaidPreview.registration_entry} />
                )}

                {/* The verifikat mark-paid will post, editable through Redigera. */}
                {(markPaidPreview || markPaidPreviewFailed) && (
                  <PaymentPreviewLinesCard
                    editor={editor}
                    lines={markPaidPreview && !markPaidPreviewFailed ? markPaidPreview.lines : null}
                    canEdit={!!markPaidPreview && (!markPaidPreviewFailed || editor.isEdited)}
                    disabled={isProcessing}
                  >
                    {/* A failed preview hides rows left over from other inputs
                        and says why; the user's own edited rows stay. */}
                    {markPaidPreviewFailed && !editor.isEdited && (
                      <div className="space-y-2">
                        {markPaidPreviewError?.registrationFirst && (
                          <p className="text-sm text-muted-foreground">{tMatch('registration_first_refused')}</p>
                        )}
                        <p className="text-sm text-muted-foreground">
                          {markPaidPreviewError?.message ?? tMatch('booking_unavailable')}
                        </p>
                        {markPaidPreviewError?.code === 'SI_PAID_SEK_UNRESOLVED' && (
                          <Button variant="outline" onClick={() => setPayTab('existing')}>
                            {t('preview_use_existing_voucher')}
                          </Button>
                        )}
                      </div>
                    )}
                  </PaymentPreviewLinesCard>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    onClick={() => handleMarkPaid(false)}
                    disabled={isProcessing || !editor.validation.isValid}
                  >
                    {isProcessing ? t('processing') : t('register_payment')}
                  </Button>
                </div>
              </div>
            </TabsContent>
            <TabsContent value="existing" className="mt-4">
              <LinkVoucherPicker
                mode="supplier_invoice"
                invoiceId={invoice.id}
                invoiceCurrency={invoice.currency}
                onLinked={() => {
                  onOpenChange(false)
                  setPayTab('new')
                  void onPaid()
                }}
                onCancel={() => setPayTab('new')}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Duplicate-payment warning */}
      <Dialog
        open={duplicateCandidates !== null}
        onOpenChange={(next) => {
          if (!next) setDuplicateCandidates(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('duplicate_payment_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {duplicateCandidates?.every((c) => c.match_reason === 'already_booked')
                ? t('duplicate_payment_already_booked_description')
                : duplicateCandidates?.length === 1
                  ? t('duplicate_payment_description_one')
                  : t('duplicate_payment_description_many')}
            </p>
            <div className="space-y-2 rounded-lg p-3 bg-control shadow-raised">
              {duplicateCandidates?.map((c) => {
                // A row that is already a verifikat: "link it" is the wrong
                // remedy (the money would be booked twice), so point at the
                // existing voucher instead of the transaction list.
                const alreadyBooked = c.match_reason === 'already_booked' && !!c.journal_entry_id
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium tabular-nums">{formatDate(c.date)}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {c.merchant_name || c.description || t('bank_transaction_fallback')}
                      </div>
                      {alreadyBooked && (
                        <div className="text-xs text-muted-foreground">
                          {t('duplicate_payment_already_booked_hint')}
                        </div>
                      )}
                    </div>
                    <div className="tabular-nums font-medium">
                      {formatCurrency(Math.abs(c.amount), invoice.currency)}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() =>
                        router.push(
                          alreadyBooked
                            ? `/bookkeeping/${c.journal_entry_id}`
                            : `/transactions?highlight=${c.id}`,
                        )
                      }
                    >
                      {alreadyBooked ? t('duplicate_payment_show_voucher') : t('go_to')}
                    </Button>
                  </div>
                )
              })}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setDuplicateCandidates(null)}>
                {t('cancel')}
              </Button>
              <Button variant="outline" onClick={() => handleMarkPaid(true)} disabled={isProcessing}>
                {isProcessing ? t('processing') : t('create_voucher_anyway')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
