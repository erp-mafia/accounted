'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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
import { todayIsoStockholm } from '@/lib/dates/iso'
import { type ErrorLocale } from '@/lib/errors/get-error-message'
import { earliestExecutionDateIso } from '@/lib/payments/bank-days'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * Betala via banken for a salary run, from the run page:
 *   preview: one screen. The account to pay from, the payment day (the
 *            banking day before payday, changeable) and every employee's net
 *            pay to the account on the employee card, by name with the
 *            account masked. Nothing is written: it is the server's dry run
 *            (lib/salary/payment/pay-via-bank.ts). A run with a payment file,
 *            or one already marked paid, asks the person to confirm the
 *            salaries have not left another way.
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
}

function inlineRefusalOf(error: unknown): Refusal | null {
  if (!(error instanceof PaymentsClientError) || !error.code || !INLINE_REFUSALS.has(error.code)) return null
  const body = error.body as { error?: { message?: unknown; details?: { employees?: Array<{ name?: unknown }> } } } | null
  const names = (body?.error?.details?.employees ?? [])
    .map((e) => (typeof e.name === 'string' ? e.name : ''))
    .filter(Boolean)
  const message = typeof body?.error?.message === 'string' ? body.error.message : null
  return { code: error.code, names, message }
}

interface PaySalaryViaBankDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  salaryRunId: string
  /** Called when the dialog closes after anything changed (drafts made, approved or sent to the bank). */
  onDone?: () => void
}

export default function PaySalaryViaBankDialog({ open, onOpenChange, salaryRunId, onDone }: PaySalaryViaBankDialogProps) {
  const t = useTranslations('salary_bank_payment')
  const tb = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const bank = useBankPaymentDialog(open)
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
                    <span className="ml-2 text-[12.5px] text-muted-foreground" title={t('new_account_help')}>
                      {t('new_account')}
                    </span>
                  )}
                </span>
                <span className="tabular-nums">{formatCurrency(payee.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2 font-medium">
            <span>{t('total')}</span>
            <span className="tabular-nums">{formatCurrency(preview.total)}</span>
          </div>
        </div>
      ) : previewing ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : null}

      {preview?.date_moved_from && (
        <p className="text-[12.5px] text-muted-foreground">{t('date_moved', { from: formatDate(preview.date_moved_from) })}</p>
      )}
      {afterPayday?.payday && <AttnLine>{t('after_payday', { date: formatDate(afterPayday.payday) })}</AttnLine>}
      {preview && preview.zero_payouts > 0 && (
        <p className="text-[12.5px] text-muted-foreground">{t('zero_payouts', { count: preview.zero_payouts })}</p>
      )}
      {preview && preview.in_payment > 0 && (
        <p className="text-[12.5px] text-muted-foreground">{t('in_payment', { count: preview.in_payment })}</p>
      )}
      {preview && preview.replaces_drafts > 0 && <p className="text-[12.5px] text-muted-foreground">{t('replaces_draft')}</p>}

      {refusal?.code === 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY' && (
        <AttnLine action={{ label: tb('open_payments_page'), href: '/payments' }}>{t('nothing_to_pay')}</AttnLine>
      )}
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
          <p className="text-[12.5px] text-muted-foreground">{t('sign_hint')}</p>
          <BankPaymentsAllowanceLine usage={usage} count={count} canRequest />
        </>
      )}
    </BankPaymentDialogFrame>
  )
}
