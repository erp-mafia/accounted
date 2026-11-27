'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { fetchPaymentsAvailability, listPaymentOrders, type PaymentOrder } from '@/components/payments/payments-client'
import type { PaymentFileAccountView } from '@/lib/salary/payment/payment-account'
import { formatCurrency } from '@/lib/utils'

const PaySalaryViaBankDialog = dynamic(() => import('./PaySalaryViaBankDialog'), { loading: DialogLoadingSkeleton })

/** A payment that still pays or paid the run: anything but rejected, failed or cancelled. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'approved',
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
  'executed',
])

export interface SalaryBankPayments {
  /** Bank payments are switched on for the company (GET /api/payments/availability); null until the first answer. */
  available: boolean | null
  /** The run's bank payments; null until the first answer. */
  orders: PaymentOrder[] | null
  /** The payments that still pay or paid the run. While any is live the payment file is left out: it would pay the month twice. */
  live: PaymentOrder[]
  reload: () => void
}

/**
 * The run's bank payments and whether the company can make them: read once
 * by the run page, which picks the header's button from them (Betala via
 * banken before any payment) and hands them to the section below. Nothing is
 * read until the run can have payments (enabled: approved, paid or booked).
 */
export function useSalaryBankPayments(salaryRunId: string, enabled: boolean): SalaryBankPayments {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [orders, setOrders] = useState<PaymentOrder[] | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (!cancelled) setAvailable(data.available)
      })
      .catch(() => {
        // Without an answer Betala via banken stays away; the payment file still stands.
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    listPaymentOrders({ salaryRunId })
      .then((rows) => {
        if (!cancelled) setOrders(rows)
      })
      .catch(() => {
        // Without an answer the section shows no payments; the file stays the way to pay.
        if (!cancelled) setOrders([])
      })
    return () => {
      cancelled = true
    }
  }, [salaryRunId, enabled, generation])

  const reload = useCallback(() => setGeneration((g) => g + 1), [])
  const live = useMemo(() => (orders ?? []).filter((o) => LIVE_STATUSES.has(o.status)), [orders])
  return { available, orders, live, reload }
}

/** PaySalaryViaBankDialog, loaded when opened: from the header's Betala via banken or the section's Betala igen. */
export function SalaryBankPaymentDialog({
  salaryRunId,
  fileAccount,
  open,
  onClose,
  onDone,
}: {
  salaryRunId: string
  /** The account the run's salary verifikat credits (usePaymentFileAccount); undefined while unknown. */
  fileAccount?: PaymentFileAccountView
  open: boolean
  onClose: () => void
  /** Called when the dialog closes after anything changed: the run may have moved to paid. */
  onDone: () => void
}) {
  if (!open) return null
  return (
    <PaySalaryViaBankDialog
      open
      salaryRunId={salaryRunId}
      bookedAccount={fileAccount?.account}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      onDone={onDone}
    />
  )
}

interface SalaryBankPaymentSectionProps {
  payments: SalaryBankPayments
  /** The run can be paid through the bank now: approved or booked, bank payments on, and the person may write. */
  canPay: boolean
  /** Show Betala via banken in the section before any payment: a booked run, whose header button is the AGI. */
  payButton?: boolean
  /** Opens the dialog for Betala igen. */
  onPay: () => void
  /** The other way to pay, under the prompt before any payment: the payment file, folded. */
  children?: ReactNode
}

/**
 * Betala via banken on the salary run page, where bank payments are switched
 * on for the company or the run already has bank payments. Before any: what
 * the header's Betala via banken does, with the payment file folded under it.
 * After: one line per employee with the payment's status, and Betala igen
 * when the bank refused one.
 */
export function SalaryBankPaymentSection({ payments, canPay, payButton = false, onPay, children }: SalaryBankPaymentSectionProps) {
  const t = useTranslations('salary_bank_payment')
  const tb = useTranslations('bank_payments')
  const { orders, live } = payments

  if (orders === null) return null
  if (live.length === 0 && !canPay) return null

  if (live.length === 0) {
    return (
      <DetailSection kicker={t('section_title')}>
        <p className="text-[13px] leading-6 text-muted-foreground">{t('section_prompt')}</p>
        {payButton && canPay && (
          <Button variant="outline" className="mt-3" onClick={onPay}>
            {t('pay_button')}
          </Button>
        )}
        {children && <div className="mt-3">{children}</div>}
      </DetailSection>
    )
  }

  const executed = live.filter((o) => o.status === 'executed').length
  // An employee still to pay: their payment was rejected, failed or cancelled
  // and no live one replaced it. A new preparation pays only them.
  const paying = new Set(live.map((o) => o.employee_id))
  const payAgain = canPay && orders.some((o) => !LIVE_STATUSES.has(o.status) && !paying.has(o.employee_id))
  return (
    <DetailSection
      kicker={t('section_title')}
      aside={
        <Link href="/payments" className={QUIET_LINK_CLASS}>
          {tb('open_payments_page')}
        </Link>
      }
    >
      <p className="text-[13px] text-muted-foreground">{t('section_progress', { executed, count: live.length })}</p>
      <ul className="mt-2 divide-y divide-border text-[13px]">
        {live.map((order) => (
          <li key={order.id} className="flex items-baseline justify-between gap-4 py-2">
            <span className="min-w-0 truncate">{order.payee_name}</span>
            <span className="flex items-baseline gap-4">
              <span className="text-muted-foreground">{tb(`status_${order.status}`)}</span>
              <span className="tabular-nums">{formatCurrency(Number(order.amount), order.currency)}</span>
            </span>
          </li>
        ))}
      </ul>
      {payAgain && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-6 text-muted-foreground">{t('section_prompt_again')}</p>
          <Button variant="outline" onClick={onPay}>
            {t('pay_again_button')}
          </Button>
        </div>
      )}
    </DetailSection>
  )
}
