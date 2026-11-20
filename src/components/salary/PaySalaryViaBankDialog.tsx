'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { BankIdSigningFlow, type SigningFlowStage } from '@/components/payments/BankIdSigningFlow'
import { BankPaymentsAllowanceLine } from '@/components/payments/BankPaymentsAllowance'
import { BankPaymentDialogFrame, useBankPaymentDialog } from '@/components/payments/bank-payment-dialog'
import { rememberPaymentAccount } from '@/components/payments/PaymentAccountPicker'
import {
  approvePaymentOrders,
  PaymentsClientError,
  prepareSalaryBankPayment,
  previewSalaryBankPayment,
  remainingBankPayments,
  type PaymentOrder,
  type SalaryBankPaymentPreview,
} from '@/components/payments/payments-client'
import type { OverpaidEmployee } from '@/lib/salary/payment/payable'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { type ErrorLocale } from '@/lib/errors/get-error-message'
import { earliestExecutionDateIso } from '@/lib/payments/bank-days'
import type { PayingAccountSummary } from '@/lib/payments/paying-account'
import { payingAccountName } from '@/lib/payments/paying-account-label'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * Betala via banken for a salary run, from the run page:
 *   preview: one screen. The account to pay from (the one the run's
 *            salary verifikat credits, as the payment file, unless the
 *            person picks another; then one muted line says the books
 *            credit the other account, PH 220), the payment day (the
 *            banking day before payday, changeable) and every employee's net
 *            pay to the account on the employee card, by name with the
 *            account masked. Nothing is written: it is the server's dry run
 *            (lib/salary/payment/pay-via-bank.ts). A run with a payment file,
 *            or one already marked paid, asks the person to confirm the
 *            salaries have not left another way. A correction run
 *            (rättelsekörning) pays only the difference against the run it
 *            corrects: one muted line says so, and an employee it overpaid
 *            is left out and named in one attention sentence.
 *   sign:    one button creates the drafts, approves them and starts one
 *            BankID signing for them all (a basket where the bank takes
 *            one). Unsigned, the payments stay under Betalningar for another
 *            signer.
 * The run moves to paid when the bank has executed every payment.
 */

type Phase = 'preview' | 'sign'

/** Refusals the dialog shows as a line where the person can act, not as a toast. */
const INLINE_REFUSALS: ReadonlySet<string> = new Set([
  'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
  'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
  'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID',
  'SALARY_RUN_BANK_PAYMENT_NOT_READY',
])

interface Refusal {
  code: string
  /** The employees a bank-details refusal names. */
  names: string[]
  /** The server's own Swedish sentence, when it composed one. */
  message: string | null
  /** Nothing to pay on a correction run: whom it overpaid, and how many are already in payment. */
  correction: { overpaid: OverpaidEmployee[]; inPayment: number } | null
}

function inlineRefusalOf(error: unknown): Refusal | null {
  if (!(error instanceof PaymentsClientError) || !error.code || !INLINE_REFUSALS.has(error.code)) return null
  const body = error.body as {
    error?: {
      message?: unknown
      details?: {
        employees?: Array<{ name?: unknown }>
        in_payment?: unknown
        correction?: { overpaid?: OverpaidEmployee[] }
      }
    }
  } | null
  const details = body?.error?.details
  const names = (details?.employees ?? [])
    .map((e) => (typeof e.name === 'string' ? e.name : ''))
    .filter(Boolean)
  const message = typeof body?.error?.message === 'string' ? body.error.message : null
  const correction = details?.correction
    ? {
        overpaid: Array.isArray(details.correction.overpaid) ? details.correction.overpaid : [],
        inPayment: typeof details.in_payment === 'number' ? details.in_payment : 0,
      }
    : null
  return { code: error.code, names, message, correction }
}

/** "Anna Andersson (1 290,75 kr), Bertil Berg (300,00 kr)": who a correction overpaid, and by how much. */
function overpaidList(overpaid: OverpaidEmployee[]): string {
  return overpaid.map((employee) => `${employee.name} (${formatCurrency(employee.amount)})`).join(', ')
}

interface PaySalaryViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  salaryRunId: string
  /**
   * The account the run's salary verifikat credits the net pay on (a booked
   * run's verifikat, else the primary the booking will credit): the account
   * the dialog opens on. undefined while unknown.
   */
  bookedAccount?: PayingAccountSummary
  /** Called when the dialog closes after anything changed (drafts made, approved or sent to the bank). */
  onDone?: () => void
}

export default function PaySalaryViaBankDialog({ open, onOpenChange, salaryRunId, bookedAccount, onDone }: PaySalaryViaBankDialogProps) {
  const t = useTranslations('salary_bank_payment')
  const tb = useTranslations('bank_payments')
  const tc = useTranslations('salary_correction_payment')
  const locale = useLocale() as ErrorLocale
  const bank = useBankPaymentDialog(open, { preferredAccountId: bookedAccount?.cash_account_id ?? null })
  const { availability, usage, accountId, account, fail } = bank

  const [phase, setPhase] = useState<Phase>('preview')
  /** '' leaves the day to the server (the banking day before payday). */
  const [executionDate, setExecutionDate] = useState('')
  const [confirmedUnpaid, setConfirmedUnpaid] = useState(false)
  const [preview, setPreview] = useState<SalaryBankPaymentPreview | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [orders, setOrders] = useState<PaymentOrder[]>([])
  const [signingStage, setSigningStage] = useState<SigningFlowStage>('method')
  const changed = useRef(false)

  // The preview follows the account and the day: a dry run on the server,
  // every rule, nothing written.
  useEffect(() => {
    if (!open || !accountId || phase !== 'preview') return
    let cancelled = false
    setPreviewing(true)
    previewSalaryBankPayment({ salaryRunId, cashAccountId: accountId, executionDate: executionDate || null, confirmedUnpaid: false })
      .then((data) => {
        if (cancelled) return
        setPreview(data)
        setRefusal(null)
      })
      .catch((error) => {
        if (cancelled) return
        setPreview(null)
        const inline = inlineRefusalOf(error)
        if (inline) setRefusal(inline)
        else fail(tb('preview_failed_title'), error)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, accountId, executionDate, phase, salaryRunId, fail, tb])

  const count = preview?.payees.length ?? 0
  const overCap = usage !== null && remainingBankPayments(usage) < count
  const afterPayday = preview?.warnings.find((w) => w.code === 'after_payday')
  const confirmation = preview?.confirmation_required ?? null
  const unconfirmed = confirmation !== null && !confirmedUnpaid
  const names = refusal?.names.join(', ') ?? ''
  // Whom a correction overpaid: from the preview, or from its refusal when nothing is left to pay.
  const overpaid = preview?.correction?.overpaid ?? refusal?.correction?.overpaid ?? []

  async function signNow() {
    if (!preview) return
    setBusy(true)
    try {
      rememberPaymentAccount(accountId)
      const prepared = await prepareSalaryBankPayment({
        salaryRunId,
        cashAccountId: accountId,
        executionDate: preview.requested_execution_date,
        confirmedUnpaid,
      })
      changed.current = true
      setOrders(prepared.orders)
      // The employee cards are the employer's own record: the signature is the approval.
      await approvePaymentOrders({ orderIds: prepared.orders.map((o) => o.id), confirmedPayeeInvoiceIds: [] })
      setPhase('sign')
    } catch (error) {
      // A refusal the person can act on replaces the preview; anything else is a toast.
      const inline = inlineRefusalOf(error)
      if (!inline) {
        fail(t('prepare_failed_title'), error)
        return
      }
      setPreview(null)
      setRefusal(inline)
    } finally {
      setBusy(false)
    }
  }

  return (
    <BankPaymentDialogFrame
      messages="salary_bank_payment"
      setup={bank}
      phase={phase}
      signingStage={signingStage}
      open={open}
      onOpenChange={onOpenChange}
      onDone={onDone}
      changed={changed}
      action={
        preview && (
          <Button onClick={signNow} loading={busy} disabled={busy || previewing || !accountId || unconfirmed || overCap}>
            {tb('sign_now', { count })}
          </Button>
        )
      }
      signing={(closeButton) =>
        availability &&
        orders.length > 0 && (
          <BankIdSigningFlow
            orders={orders.map((o) => ({ id: o.id, payee_name: o.payee_name, amount: Number(o.amount), currency: o.currency }))}
            signerKnown={availability.signer_known}
            bankName={account?.bank_name ?? null}
            closeButton={closeButton}
            onStageChange={setSigningStage}
            autoStart
          />
        )
      }
    >
      {/* Paid from another account than the verifikat credits, the bank and the books part ways: said, not refused. */}
      {bookedAccount?.cash_account_id && accountId && accountId !== bookedAccount.cash_account_id && (
        <p data-ph-mask="" className="text-xs text-muted-foreground">
          {t('account_not_booked', { account: payingAccountName(bookedAccount) })}
        </p>
      )}
      <dl className="space-y-3 text-[13px]">
        <div className="flex items-center justify-between gap-4">
          <dt>
            <label htmlFor="salary-payment-date" className="text-muted-foreground">
              {tb('date_label')}
            </label>
          </dt>
          <dd>
            <Input
              id="salary-payment-date"
              type="date"
              min={earliestExecutionDateIso(todayIsoStockholm())}
              value={executionDate || preview?.requested_execution_date || ''}
              onChange={(e) => setExecutionDate(e.target.value)}
              className="h-8 w-[160px] tabular-nums"
            />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{t('message_label')}</dt>
          <dd>{preview ? preview.reference : previewing ? <Skeleton className="h-4 w-24" /> : null}</dd>
        </div>
      </dl>

      {preview ? (
        <div className="text-[13px]">
          <ul className="divide-y divide-border">
            {preview.payees.map((payee) => (
              <li key={payee.employee_id} className="flex items-baseline justify-between gap-4 py-2">
                <span className="min-w-0 truncate">
                  {payee.name}
                  <span className="ml-2 tabular-nums text-muted-foreground">{payee.masked_account}</span>
                  {!payee.known_account && (
                    <span className="ml-2 text-xs text-muted-foreground" title={t('new_account_help')}>
                      {t('new_account')}
                    </span>
                  )}
                </span>
                <span className="tabular-nums">{formatCurrency(payee.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-4 border-t-hairline pt-2 font-medium">
            <span>{t('total')}</span>
            <span className="tabular-nums">{formatCurrency(preview.total)}</span>
          </div>
        </div>
      ) : previewing ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </LateReveal>
      ) : null}

      {preview?.date_moved_from && (
        <p className="text-xs text-muted-foreground">{t('date_moved', { from: formatDate(preview.date_moved_from) })}</p>
      )}
      {afterPayday?.payday && <AttnLine>{t('after_payday', { date: formatDate(afterPayday.payday) })}</AttnLine>}
      {preview?.correction && <p className="text-xs text-muted-foreground">{tc('difference_only')}</p>}
      {preview && preview.zero_payouts > 0 && (
        <p className="text-xs text-muted-foreground">
          {preview.correction
            ? tc('zero_payouts', { count: preview.zero_payouts })
            : t('zero_payouts', { count: preview.zero_payouts })}
        </p>
      )}
      {preview && preview.in_payment > 0 && (
        <p className="text-xs text-muted-foreground">{t('in_payment', { count: preview.in_payment })}</p>
      )}
      {preview && preview.replaces_drafts > 0 && <p className="text-xs text-muted-foreground">{t('replaces_draft')}</p>}

      {refusal?.code === 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY' &&
        (refusal.correction && refusal.correction.inPayment === 0 ? (
          <p className="text-xs text-muted-foreground">{tc('nothing_to_pay')}</p>
        ) : (
          <AttnLine action={{ label: tb('open_payments_page'), href: '/payments' }}>{t('nothing_to_pay')}</AttnLine>
        ))}
      {/* Never paid, never deducted: the person handles it (one sentence, every name and amount). */}
      {overpaid.length > 0 && <AttnLine>{tc('overpaid', { list: overpaidList(overpaid), count: overpaid.length })}</AttnLine>}
      {refusal?.code === 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING' && (
        <AttnLine action={{ label: t('open_employees'), href: '/salary/employees' }}>{t('bank_missing', { names })}</AttnLine>
      )}
      {refusal?.code === 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID' && (
        <AttnLine action={{ label: t('open_employees'), href: '/salary/employees' }}>
          {/* The server names each problem, in Swedish. */}
          {locale === 'sv' && refusal.message ? refusal.message : t('bank_invalid', { names })}
        </AttnLine>
      )}
      {refusal?.code === 'SALARY_RUN_BANK_PAYMENT_NOT_READY' && <AttnLine>{t('not_ready')}</AttnLine>}

      {confirmation && (
        <div className="space-y-2 text-[13px]">
          <p className="text-muted-foreground">
            {confirmation.payment_file_generated_at
              ? t('confirm_file', { date: formatDate(confirmation.payment_file_generated_at) })
              : t('confirm_status')}
          </p>
          <label className="flex items-start gap-2">
            <Checkbox className="mt-0.5" checked={confirmedUnpaid} onCheckedChange={(v) => setConfirmedUnpaid(v === true)} />
            {t('confirm_label')}
          </label>
        </div>
      )}

      {preview && (
        <>
          <p className="text-xs text-muted-foreground">{t('sign_hint')}</p>
          <BankPaymentsAllowanceLine usage={usage} count={count} canRequest onIncluded={bank.raiseIncluded} />
        </>
      )}
    </BankPaymentDialogFrame>
  )
}
