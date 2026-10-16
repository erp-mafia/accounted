'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { parseAmountInput } from '@/lib/money'
import { earliestExecutionDateIso } from '@/lib/payments/bank-days'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import { BankPaymentsAllowanceLine } from './BankPaymentsAllowance'
import { PaymentsVerificationLine } from './PaymentsVerificationLine'
import { defaultPaymentAccount, PaymentAccountPicker, rememberPaymentAccount } from './PaymentAccountPicker'
import {
  approvePaymentOrders,
  fetchBankPaymentsUsage,
  fetchPaymentsAvailability,
  paymentReadinessFor,
  PaymentsClientError,
  prepareSkattekontoPayment,
  previewSkattekontoPayment,
  remainingBankPayments,
  type BankPaymentsUsage,
  type PaymentOrder,
  type PaymentsAvailability,
  type SkattekontoPaymentPreview,
} from './payments-client'

/**
 * Betala via banken for the skattekonto, from Skattekonto (Betalningsuppgifter)
 * or the Hem row Betala in till Skatteverket:
 *   preview: one screen. The account to pay from (the choice
 *            PayViaBankDialog offers), the amount (what the next charge lacks,
 *            changeable), the payment day (the banking day before Skatteverket
 *            draws, changeable) and the OCR number the money carries to
 *            bankgiro 5050-1055. Nothing is written: it is the server's dry
 *            run, and a day on or after the draw says Skatteverket charges
 *            interest.
 *   sign:    one button creates the draft, approves it and starts the BankID
 *            signing at once, like a supplier payment. Unsigned, the payment
 *            stays under Betalningar for another signer.
 * A skattekonto draft nobody approved is replaced by the server, so a second
 * attempt never fails on the first one's leftovers. Nothing books the debit
 * when it arrives: the bank row is booked the normal way.
 */

type Phase = 'preview' | 'sign'

/** Refusals the dialog shows as a line where the person can act, not as a toast. */
const INLINE_REFUSALS: ReadonlySet<string> = new Set([
  'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
  'SKATTEKONTO_PAYMENT_NOTHING_DUE',
  'SKATTEKONTO_PAYMENT_OCR_MISSING',
])

/** How long typing in the amount waits before the preview is asked again. */
const AMOUNT_DEBOUNCE_MS = 400

const AMOUNT_INPUT_FORMAT = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function inlineRefusalOf(error: unknown): string | null {
  return error instanceof PaymentsClientError && error.code && INLINE_REFUSALS.has(error.code) ? error.code : null
}

interface PaySkattekontoViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the dialog closes after anything changed (a draft made, approved or sent to the bank). */
  onDone?: () => void
}

export default function PaySkattekontoViaBankDialog({ open, onOpenChange, onDone }: PaySkattekontoViaBankDialogProps) {
  const t = useTranslations('skattekonto_bank_payment')
  const tb = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [phase, setPhase] = useState<Phase>('preview')
  const [availability, setAvailability] = useState<PaymentsAvailability | null>(null)
  /** This month's bank payments against the cap; null until read (informational, the server decides). */
  const [usage, setUsage] = useState<BankPaymentsUsage | null>(null)
  const [accountId, setAccountId] = useState('')
  /** What the person typed in the amount field; until they type, it shows the preview's amount. */
  const [amountText, setAmountText] = useState('')
  const [amountTouched, setAmountTouched] = useState(false)
  /** The amount the preview is asked for; null leaves it to the server (what the next charge lacks). */
  const [amount, setAmount] = useState<number | null>(null)
  /** '' leaves the day to the server (the banking day before the draw). */
  const [executionDate, setExecutionDate] = useState('')
  const [preview, setPreview] = useState<SkattekontoPaymentPreview | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<PaymentOrder | null>(null)
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  const changed = useRef(false)

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setAvailability(data)
        const pick = defaultPaymentAccount(data.accounts.filter((a) => a.payable))
        if (pick) setAccountId(pick.id)
        if (data.available) {
          fetchBankPaymentsUsage().then(
            (u) => {
              if (!cancelled) setUsage(u)
            },
            () => {
              // Without the counter the dialog stands; a signing past the cap is refused with the numbers.
            },
          )
        }
      })
      .catch(() => {
        if (!cancelled) setAvailability({ available: false, reason: null, provider: null, accounts: [], signer_known: false })
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // What the person types becomes the amount asked for after a pause. An
  // untouched (or emptied) field leaves the amount to the server and shows it.
  const typedAmount = amountTouched ? parseAmountInput(amountText) : null
  const amountInvalid = amountTouched && !(typedAmount !== null && typedAmount > 0)
  useEffect(() => {
    if (amountInvalid) return
    const handle = setTimeout(() => setAmount(typedAmount), AMOUNT_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [typedAmount, amountInvalid])
  const amountShown = amountTouched ? amountText : preview ? AMOUNT_INPUT_FORMAT.format(preview.amount) : ''

  // The preview follows the account, the amount and the day: a dry run on the
  // server, every rule, nothing written.
  useEffect(() => {
    if (!open || !accountId || phase !== 'preview') return
    let cancelled = false
    setPreviewing(true)
    previewSkattekontoPayment({ cashAccountId: accountId, amount, executionDate: executionDate || null })
      .then((data) => {
        if (cancelled) return
        setPreview(data)
        setRefusal(null)
      })
      .catch((error) => {
        if (cancelled) return
        setPreview(null)
        const code = inlineRefusalOf(error)
        if (code) setRefusal(code)
        else fail(tb('preview_failed_title'), error)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, amount, executionDate, phase, fail, tb])

  const payableAccounts = availability?.accounts.filter((a) => a.payable) ?? []
  const account = payableAccounts.find((a) => a.id === accountId) ?? null
  // The company's verification, where a payment from this account needs it.
  const readiness = availability && account ? paymentReadinessFor(availability, account) : null
  const verificationLine =
    availability?.verification && (readiness === 'verification_needed' || readiness === 'verification_pending') ? (
      <PaymentsVerificationLine verification={availability.verification} />
    ) : null
  const overCap = usage !== null && remainingBankPayments(usage) < 1
  // Signing pays exactly what the preview showed: never while the field says another amount.
  const inSync = preview !== null && (typedAmount === null || typedAmount === preview.amount)
  const late = preview?.warnings.find((w) => w.code === 'late')

  async function signNow() {
    if (!preview) return
    setBusy(true)
    try {
      rememberPaymentAccount(accountId)
      const prepared = await prepareSkattekontoPayment({
        cashAccountId: accountId,
        amount: preview.amount,
        executionDate: preview.requested_execution_date,
      })
      changed.current = true
      setOrder(prepared.order)
      // Skatteverket's bankgiro needs no confirmation of the payee: the signature is the approval.
      await approvePaymentOrders({ orderIds: [prepared.order.id], confirmedPayeeInvoiceIds: [] })
      setPhase('sign')
    } catch (error) {
      const code = inlineRefusalOf(error)
      if (code) {
        setPreview(null)
        setRefusal(code)
      } else {
        fail(t('prepare_failed_title'), error)
      }
    } finally {
      setBusy(false)
    }
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && changed.current) onDone?.()
    onOpenChange(nextOpen)
  }

  const closeButton = (
    <Button variant="secondary" onClick={() => close(false)}>
      {phase === 'sign' && signingStage === 'done' ? tb('close') : tb('cancel')}
    </Button>
  )

  const title = phase === 'sign' ? (signingStage === 'done' ? t('title_done') : t('title_sign')) : t('title')

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('title')}</DialogDescription>
        </DialogHeader>

        {phase === 'preview' && (
          <div className="space-y-4">
            {!availability ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : !availability.available ? (
              <AttnLine>{tb('unavailable')}</AttnLine>
            ) : payableAccounts.length === 0 ? (
              <AttnLine>{tb('account_none')}</AttnLine>
            ) : (
              <>
                {verificationLine}
                <div className="text-[13px]">
                  <PaymentAccountPicker accounts={payableAccounts} accountId={accountId} onChange={setAccountId} />
                </div>
                <p className="text-[13px]">{t('destination')}</p>

                <dl className="space-y-3 text-[13px]">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">{t('ocr_label')}</dt>
                    <dd className="font-medium tabular-nums">
                      {preview ? preview.reference.value : previewing ? <Skeleton className="h-4 w-32" /> : null}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt>
                      <label htmlFor="skattekonto-payment-amount" className="text-muted-foreground">
                        {t('amount_label')}
                      </label>
                    </dt>
                    <dd>
                      <Input
                        id="skattekonto-payment-amount"
                        inputMode="decimal"
                        value={amountShown}
                        onChange={(e) => {
                          setAmountText(e.target.value)
                          setAmountTouched(e.target.value.trim() !== '')
                        }}
                        aria-invalid={amountInvalid || undefined}
                        className="h-8 w-[160px] text-right tabular-nums"
                      />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt>
                      <label htmlFor="skattekonto-payment-date" className="text-muted-foreground">
                        {t('date_label')}
                      </label>
                    </dt>
                    <dd>
                      <Input
                        id="skattekonto-payment-date"
                        type="date"
                        min={earliestExecutionDateIso(todayIsoStockholm())}
                        value={executionDate || preview?.requested_execution_date || ''}
                        onChange={(e) => setExecutionDate(e.target.value)}
                        className="h-8 w-[160px] tabular-nums"
                      />
                    </dd>
                  </div>
                </dl>

                {amountInvalid && <p className="text-[12.5px] text-destructive">{t('amount_invalid')}</p>}
                {preview?.due && (
                  <p className="text-[12.5px] text-muted-foreground">
                    {t('due_hint', {
                      date: formatDate(preview.due.date),
                      charge: formatCurrency(preview.due.charge),
                      missing: formatCurrency(preview.due.amount),
                    })}
                  </p>
                )}
                {preview?.date_moved_from && (
                  <p className="text-[12.5px] text-muted-foreground">{t('date_moved', { from: formatDate(preview.date_moved_from) })}</p>
                )}
                {late && <AttnLine>{t('late', { date: formatDate(late.due ?? preview?.due?.date ?? '') })}</AttnLine>}

                {refusal === 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT' && (
                  <AttnLine action={{ label: tb('open_payments_page'), href: '/payments' }}>{t('already_in_payment')}</AttnLine>
                )}
                {refusal === 'SKATTEKONTO_PAYMENT_NOTHING_DUE' && <p className="text-[12.5px] text-muted-foreground">{t('nothing_due')}</p>}
                {refusal === 'SKATTEKONTO_PAYMENT_OCR_MISSING' && <AttnLine>{t('ocr_missing')}</AttnLine>}

                {preview && (
                  <>
                    {preview.replaces_drafts > 0 && <p className="text-[12.5px] text-muted-foreground">{t('replaces_draft')}</p>}
                    <p className="text-[12.5px] text-muted-foreground">{t('sign_hint')}</p>
                    <BankPaymentsAllowanceLine usage={usage} count={1} canRequest />
                  </>
                )}
              </>
            )}
            <DialogFooter>
              {closeButton}
              {preview && (
                <Button onClick={signNow} loading={busy} disabled={busy || previewing || !accountId || !inSync || amountInvalid || overCap}>
                  {tb('sign_now', { count: 1 })}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {phase === 'sign' && availability && order && (
          <BankIdSigningFlow
            orders={[{ id: order.id, payee_name: order.payee_name, amount: Number(order.amount), currency: order.currency }]}
            signerKnown={availability.signer_known}
            bankName={account?.bank_name ?? null}
            closeButton={closeButton}
            onStageChange={setSigningStage}
            autoStart
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
