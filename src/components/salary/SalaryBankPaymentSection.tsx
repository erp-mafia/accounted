'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { fetchPaymentsAvailability, listPaymentOrders, type PaymentOrder } from '@/components/payments/payments-client'
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

interface SalaryBankPaymentSectionProps {
  salaryRunId: string
  runStatus: string
  readOnly?: boolean
  /** Called after the dialog changed something, so the page reloads the run (it may have moved to paid). */
  onChange?: () => void
  /** Whether a bank payment of the run is live: the page then leaves the payment file out (the file would pay the month twice). */
  onInBankPayment?: (live: boolean) => void
}

/**
 * Betala via banken on the salary run page. Rendered only where bank payments
 * are switched on for the company (GET /api/payments/availability), or where
 * the run already has bank payments. Before any: the button that opens
 * PaySalaryViaBankDialog, for an approved run. After: one line per employee
 * with the payment's status, and Betala igen when the bank refused one.
 */
export function SalaryBankPaymentSection({ salaryRunId, runStatus, readOnly, onChange, onInBankPayment }: SalaryBankPaymentSectionProps) {
  const t = useTranslations('salary_bank_payment')
  const tb = useTranslations('bank_payments')
  const [available, setAvailable] = useState(false)
  const [orders, setOrders] = useState<PaymentOrder[] | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
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
  }, [salaryRunId])

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (!cancelled) setAvailable(data.available)
      })
      .catch(() => {
        // Without an answer the button stays away; the payment file still stands.
      })
    const stopLoad = load()
    return () => {
      cancelled = true
      stopLoad()
    }
  }, [load])

  const live = (orders ?? []).filter((o) => LIVE_STATUSES.has(o.status))
  useEffect(() => {
    onInBankPayment?.(live.length > 0)
  }, [live.length, onInBankPayment])

  if (orders === null) return null
  const canPay = !readOnly && available && runStatus === 'approved'
  if (live.length === 0 && !canPay) return null

  const dialog = open && (
    <PaySalaryViaBankDialog
      open
      salaryRunId={salaryRunId}
      onOpenChange={(next) => {
        if (!next) setOpen(false)
      }}
      onDone={() => {
        load()
        onChange?.()
      }}
    />
  )

  if (live.length === 0) {
    return (
      <DetailSection kicker={t('section_title')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-6 text-muted-foreground">{t('section_prompt')}</p>
          <Button onClick={() => setOpen(true)}>{t('pay_button')}</Button>
        </div>
        {dialog}
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
          <Button variant="outline" onClick={() => setOpen(true)}>
            {t('pay_again_button')}
          </Button>
        </div>
      )}
      {dialog}
    </DetailSection>
  )
}
