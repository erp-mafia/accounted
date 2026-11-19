'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  fetchSupplierInvoicePayments,
  orderInvoiceLabel,
  PaymentsClientError,
  resolvePaymentOrder,
  type PaymentOrder,
  type SupplierInvoicePaymentRow,
} from './payments-client'

interface ResolvePaymentOrderDialogProps {
  order: PaymentOrder
  onOpenChange: (open: boolean) => void
  onResolved: () => void
}

type Choice = 'not_at_bank' | 'paid'

/**
 * A person settles a payment the bank cannot settle: the bank's answer was
 * lost when the payment was created (outcome unknown), or the payment is
 * stranded. Two explicit answers, each confirmed: the payment is not at the
 * bank (checked in the online bank), or the bank paid it and the debit is
 * already booked on the invoice (pick that payment row). Session only, never
 * an agent: lib/payments/orders/lifecycle.ts resolvePaymentOrder.
 */
export function ResolvePaymentOrderDialog({ order, onOpenChange, onResolved }: ResolvePaymentOrderDialogProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [choice, setChoice] = useState<Choice | null>(null)
  const [payments, setPayments] = useState<SupplierInvoicePaymentRow[] | null>(null)
  const [paymentId, setPaymentId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const invoiceId = order.supplier_invoice_id
  useEffect(() => {
    if (!invoiceId) {
      setPayments([])
      return
    }
    let cancelled = false
    fetchSupplierInvoicePayments(invoiceId)
      .then((rows) => {
        if (cancelled) return
        setPayments(rows)
        if (rows.length === 1) setPaymentId(rows[0]!.id)
      })
      .catch(() => {
        if (!cancelled) setPayments([])
      })
    return () => {
      cancelled = true
    }
  }, [invoiceId])

  async function resolve() {
    if (!choice) return
    setBusy(true)
    try {
      await resolvePaymentOrder(
        order.id,
        choice === 'paid' ? { resolution: 'paid', supplier_invoice_payment_id: paymentId } : { resolution: 'not_at_bank' },
      )
      toast({ title: t('resolved_toast') })
      onResolved()
      onOpenChange(false)
    } catch (error) {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title: t('resolve_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const canResolve = choice === 'not_at_bank' || (choice === 'paid' && Boolean(paymentId))

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('resolve_title')}</DialogTitle>
          <DialogDescription>
            {t('resolve_description', { label: orderInvoiceLabel(order), amount: formatCurrency(Number(order.amount), order.currency) })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="flex items-start gap-3 rounded-lg p-4 bg-control shadow-raised">
            <input
              type="radio"
              name="resolution"
              className="mt-1"
              checked={choice === 'not_at_bank'}
              onChange={() => setChoice('not_at_bank')}
            />
            <span>
              <span className="block">{t('resolve_not_at_bank')}</span>
              <span className="block text-xs text-muted-foreground">{t('resolve_not_at_bank_hint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg p-4 bg-control shadow-raised">
            <input type="radio" name="resolution" className="mt-1" checked={choice === 'paid'} onChange={() => setChoice('paid')} />
            <span className="min-w-0 flex-1">
              <span className="block">{t('resolve_paid')}</span>
              <span className="block text-xs text-muted-foreground">{t('resolve_paid_hint')}</span>
              {choice === 'paid' &&
                (payments === null ? (
                  <Skeleton className="mt-3 h-9 w-full" />
                ) : payments.length === 0 ? (
                  <span className="mt-3 block text-xs text-attn">{t('resolve_no_payment_rows')}</span>
                ) : (
                  <select
                    className="mt-3 h-9 w-full rounded-lg px-3 text-[13px] bg-control shadow-raised"
                    value={paymentId}
                    onChange={(e) => setPaymentId(e.target.value)}
                  >
                    <option value="">{t('resolve_pick_payment')}</option>
                    {payments.map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${formatDate(p.payment_date)} ${formatCurrency(Number(p.amount), p.currency)}`}
                      </option>
                    ))}
                  </select>
                ))}
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={resolve} loading={busy} disabled={!canResolve}>
            {t('resolve_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
