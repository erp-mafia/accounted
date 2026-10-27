'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { parseAmountInput } from '@/lib/money'
import { earliestExecutionDateIso } from '@/lib/payments/bank-days'
import { formatCurrency, formatDate } from '@/lib/utils'
import { BankIdSigningFlow, type SigningFlowStage } from './BankIdSigningFlow'
import { BankPaymentsAllowanceLine } from './BankPaymentsAllowance'
import { BankPaymentDialogFrame, useBankPaymentDialog } from './bank-payment-dialog'
import { rememberPaymentAccount } from './PaymentAccountPicker'
import {
  approvePaymentOrders,
  PaymentsClientError,
  prepareSkattekontoPayment,
  previewSkattekontoPayment,
  remainingBankPayments,
  type PaymentOrder,
  type SkattekontoPaymentPreview,
  type SkattekontoPaymentSourceInput,
} from './payments-client'

/** A declaration as the dialog names it: the source kind and its period label. */
type DeclarationRef = { source?: 'vat_declaration' | 'agi'; period?: string }

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
 *
 * Opened from a filed declaration (the momsdeklaration's step 4, the salary
 * run's tax payment), the dialog pays what that declaration asks for by its
 * due date instead of the next charge, and shows the synced saldo beside it
 * without netting it. When another declaration is due the same day (moms and
 * AGI on the 12th), it lists it and offers to pay everything due that day as
 * one payment (source due_date): one skattekonto payment is open at a time,
 * so paying them one by one would replace the first draft.
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

/** Why a declaration asks for nothing (details.reason of SKATTEKONTO_PAYMENT_NOTHING_DUE). */
const NOTHING_DUE_REASONS = [
  'refund',
  'zero',
  'already_paid',
  'period_not_ended',
  // A day (source due_date) with no declaration due, or none that asks for a payment.
  'no_declaration',
  'nothing_payable',
] as const
type NothingDueReason = (typeof NOTHING_DUE_REASONS)[number]

function nothingDueReasonOf(error: unknown): NothingDueReason | null {
  if (!(error instanceof PaymentsClientError)) return null
  const reason = (error.body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason
  return NOTHING_DUE_REASONS.find((r) => r === reason) ?? null
}

interface PaySkattekontoViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the dialog closes after anything changed (a draft made, approved or sent to the bank). */
  onDone?: () => void
  /** The declaration paid; omitted, the next charge on the synced skattekonto. */
  source?: SkattekontoPaymentSourceInput | null
  /** How the page names the declaration's period (e.g. Kvartal 3 2026); the period key otherwise. */
  sourceLabel?: string
}

export default function PaySkattekontoViaBankDialog({ open, onOpenChange, onDone, source = null, sourceLabel }: PaySkattekontoViaBankDialogProps) {
  const t = useTranslations('skattekonto_bank_payment')
  const tb = useTranslations('bank_payments')
  const bank = useBankPaymentDialog(open)
  const { availability, usage, accountId, account, fail } = bank

  const [phase, setPhase] = useState<Phase>('preview')
  /** What the person typed in the amount field; until they type, it shows the preview's amount. */
  const [amountText, setAmountText] = useState('')
  const [amountTouched, setAmountTouched] = useState(false)
  /** The amount the preview is asked for; null leaves it to the server (what the next charge lacks). */
  const [amount, setAmount] = useState<number | null>(null)
  /** '' leaves the day to the server (the banking day before the draw). */
  const [executionDate, setExecutionDate] = useState('')
  const [preview, setPreview] = useState<SkattekontoPaymentPreview | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [nothingDueReason, setNothingDueReason] = useState<NothingDueReason | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [order, setOrder] = useState<PaymentOrder | null>(null)
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  /** Betala allt som förfaller: the day whose declarations are paid instead of the one the dialog opened with. */
  const [payAllDue, setPayAllDue] = useState<string | null>(null)
  const changed = useRef(false)
  const paying: SkattekontoPaymentSourceInput | null = payAllDue ? { source: 'due_date', due_date: payAllDue } : source

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

  // The source as a value the effect below can compare: a page passes a new
  // object on every render.
  const sourceKey = paying ? JSON.stringify(paying) : ''

  /** Pay everything due on `day` (null: back to the declaration the dialog opened with); the amount follows the new preview. */
  function payAllDueOn(day: string | null) {
    setPayAllDue(day)
    setAmountTouched(false)
    setAmountText('')
    setAmount(null)
  }

  // The preview follows the account, the amount and the day: a dry run on the
  // server, every rule, nothing written.
  useEffect(() => {
    if (!open || !accountId || phase !== 'preview') return
    let cancelled = false
    setPreviewing(true)
    const named = sourceKey ? (JSON.parse(sourceKey) as SkattekontoPaymentSourceInput) : null
    previewSkattekontoPayment({ cashAccountId: accountId, amount, executionDate: executionDate || null, source: named })
      .then((data) => {
        if (cancelled) return
        setPreview(data)
        setRefusal(null)
        setNothingDueReason(null)
      })
      .catch((error) => {
        if (cancelled) return
        setPreview(null)
        const code = inlineRefusalOf(error)
        if (code) {
          setRefusal(code)
          setNothingDueReason(nothingDueReasonOf(error))
        } else fail(tb('preview_failed_title'), error)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, amount, executionDate, phase, sourceKey, fail, tb])

  const overCap = usage !== null && remainingBankPayments(usage) < 1
  // Signing pays exactly what the preview showed: never while the field says another amount.
  const inSync = preview !== null && (typedAmount === null || typedAmount === preview.amount)
  const late = preview?.warnings.find((w) => w.code === 'late')
  const notFiled = preview?.warnings.filter((w) => w.code === 'not_filed') ?? []
  const duplicate = preview?.warnings.find((w) => w.code === 'possible_duplicate')
  const sameDay = payAllDue ? undefined : preview?.warnings.find((w) => w.code === 'same_due_date_parts')
  const combined = preview?.combined ?? null
  // With every declaration due on a day, the parts list says what is paid.
  const declared = combined ? null : (preview?.source ?? null)
  const declaredPeriod = sourceLabel ?? declared?.tax_period ?? ''
  const partName = (part: DeclarationRef) =>
    t(part.source === 'agi' ? 'part_agi' : 'part_vat', { period: part.period ?? '' })

  async function signNow() {
    if (!preview) return
    setBusy(true)
    try {
      rememberPaymentAccount(accountId)
      const prepared = await prepareSkattekontoPayment({
        cashAccountId: accountId,
        amount: preview.amount,
        executionDate: preview.requested_execution_date,
        source: paying,
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

  return (
    <BankPaymentDialogFrame
      messages="skattekonto_bank_payment"
      setup={bank}
      phase={phase}
      signingStage={signingStage}
      open={open}
      onOpenChange={onOpenChange}
      onDone={onDone}
      changed={changed}
      action={
        preview && (
          <Button onClick={signNow} loading={busy} disabled={busy || previewing || !accountId || !inSync || amountInvalid || overCap}>
            {tb('sign_now', { count: 1 })}
          </Button>
        )
      }
      signing={(closeButton) =>
        availability &&
        order && (
          <BankIdSigningFlow
            orders={[{ id: order.id, payee_name: order.payee_name, amount: Number(order.amount), currency: order.currency }]}
            signerKnown={availability.signer_known}
            bankName={account?.bank_name ?? null}
            closeButton={closeButton}
            onStageChange={setSigningStage}
            autoStart
          />
        )
      }
    >
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
      {declared && (
        <p className="text-[12.5px] text-muted-foreground">
          {t(declared.kind === 'agi' ? 'source_agi' : 'source_vat', {
            period: declaredPeriod,
            amount: formatCurrency(declared.declared),
          })}
          {declared.due_date && <> {t('source_due', { date: formatDate(declared.due_date) })}</>}
        </p>
      )}
      {sameDay?.due && (
        <div className="space-y-2 text-[12.5px] text-muted-foreground">
          <p>{t('same_due_date_parts', { date: formatDate(sameDay.due) })}</p>
          <ul className="space-y-1">
            {(sameDay.parts ?? []).map((part) => (
              <li key={`${part.source}-${part.period}`} className="flex justify-between gap-4">
                <span>{partName(part)}</span>
                <span className="tabular-nums">{formatCurrency(part.amount)}</span>
              </li>
            ))}
          </ul>
          {sameDay.replaces_draft && <p>{t('same_due_date_replaces_draft')}</p>}
          <Button variant="outline" size="sm" onClick={() => payAllDueOn(sameDay.due ?? null)}>
            {t('pay_all_due', { date: formatDate(sameDay.due), amount: formatCurrency(sameDay.total ?? 0) })}
          </Button>
        </div>
      )}
      {combined && (
        <div className="space-y-2 text-[12.5px] text-muted-foreground">
          <p>{t('combined_title', { date: formatDate(combined.due_date) })}</p>
          {combined.components.length > 0 && (
            <ul className="space-y-1">
              {combined.components.map((part) => (
                <li key={`${part.source}-${part.period}`} className="flex justify-between gap-4">
                  <span>{partName(part)}</span>
                  <span className="tabular-nums">{formatCurrency(part.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          {combined.excluded.map((part) => (
            <p key={`${part.source}-${part.period}`}>
              {t(`excluded_${part.reason}`, { name: partName(part), amount: formatCurrency(part.declared) })}
            </p>
          ))}
          {payAllDue && source && (
            <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => payAllDueOn(null)}>
              {t('pay_only_this')}
            </button>
          )}
        </div>
      )}
      {preview?.balance && (
        <p className="text-[12.5px] text-muted-foreground">{t('balance_info', { saldo: formatCurrency(preview.balance.saldo) })}</p>
      )}
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
      {!late && duplicate && (
        <AttnLine>
          {duplicate.period
            ? t('possible_duplicate_part', {
                name: partName(duplicate),
                date: duplicate.executed_at ? formatDate(duplicate.executed_at) : '',
              })
            : t('possible_duplicate', { date: duplicate.executed_at ? formatDate(duplicate.executed_at) : '' })}
        </AttnLine>
      )}
      {!late &&
        !duplicate &&
        notFiled.map((w) => (
          <p key={`${w.source ?? 'source'}-${w.period ?? ''}`} className="text-[12.5px] text-muted-foreground">
            {w.period ? t('not_filed_part', { name: partName(w) }) : t('not_filed')}
          </p>
        ))}

      {refusal === 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT' && (
        <AttnLine action={{ label: tb('open_payments_page'), href: '/payments' }}>{t('already_in_payment')}</AttnLine>
      )}
      {refusal === 'SKATTEKONTO_PAYMENT_NOTHING_DUE' && (
        <p className="text-[12.5px] text-muted-foreground">
          {nothingDueReason ? t(`nothing_due_${nothingDueReason}`) : t('nothing_due')}
        </p>
      )}
      {refusal === 'SKATTEKONTO_PAYMENT_OCR_MISSING' && <AttnLine>{t('ocr_missing')}</AttnLine>}

      {preview && (
        <>
          {preview.replaces_drafts > 0 && !sameDay?.replaces_draft && (
            <p className="text-[12.5px] text-muted-foreground">{t('replaces_draft')}</p>
          )}
          <p className="text-[12.5px] text-muted-foreground">{t('sign_hint')}</p>
          <BankPaymentsAllowanceLine usage={usage} count={1} canRequest />
        </>
      )}
    </BankPaymentDialogFrame>
  )
}
