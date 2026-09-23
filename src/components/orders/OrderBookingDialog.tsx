'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import {
  buildOrderBookingLines,
  resolveBookingWarnings,
  resolvePaymentAccount,
} from '@/lib/webshop-orders/booking-lines'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

interface OrderBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: WebshopOrder
  storeSettings: WebshopStoreSettings | null
  onBooked: () => void
  onSettingsSaved: (settings: WebshopStoreSettings) => void
}

/**
 * Books one order/refund row: prefilled lines from the per-store payment-
 * method mapping, fully editable in the shared JournalEntryForm (manual-base
 * doctrine: prefill never auto-books). The "remember" opt-in writes the
 * chosen counter-account back to the store mapping AFTER a successful
 * booking, mirroring the prefill-plus-explicit-override editor pattern.
 */
export default function OrderBookingDialog({
  open,
  onOpenChange,
  order,
  storeSettings,
  onBooked,
  onSettingsSaved,
}: OrderBookingDialogProps) {
  const t = useTranslations('webshop_orders')
  const resolved = useMemo(
    () => resolvePaymentAccount(order, storeSettings),
    [order, storeSettings],
  )
  const [paymentAccount, setPaymentAccount] = useState(resolved.account)
  const [remember, setRemember] = useState(false)

  const isRefund = order.row_type === 'refund'
  const fxUnresolved = order.currency.toUpperCase() !== 'SEK' && order.total_sek === null
  const accountValid = ACCOUNT_NUMBER_RE.test(paymentAccount)

  const initialLines = useMemo<FormLine[] | null>(() => {
    if (fxUnresolved || !accountValid) return null
    try {
      return buildOrderBookingLines({
        order,
        settings: storeSettings,
        paymentAccount,
      }).map((line) => ({
        account_number: line.account_number,
        debit_amount: line.debit_amount ? line.debit_amount.toFixed(2) : '',
        credit_amount: line.credit_amount ? line.credit_amount.toFixed(2) : '',
        line_description: line.line_description ?? '',
        ...(line.currency
          ? {
              currency: line.currency,
              amount_in_currency: line.amount_in_currency,
              exchange_rate: line.exchange_rate,
            }
          : {}),
      }))
    } catch {
      return null
    }
  }, [order, storeSettings, paymentAccount, fxUnresolved, accountValid])

  const methodLabel = order.payment_method_title || order.payment_method || ''

  async function persistMapping() {
    if (!order.payment_method) return
    const map = {
      ...(storeSettings?.payment_method_account_map ?? {}),
      [order.payment_method]: { mode: 'book' as const, account: paymentAccount },
    }
    try {
      const res = await fetch('/api/webshop-orders/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: order.platform,
          store_scope: order.store_scope,
          payment_method_account_map: map,
        }),
      })
      if (res.ok) {
        const json = (await res.json()) as { data: WebshopStoreSettings }
        onSettingsSaved(json.data)
      }
    } catch {
      // Remember is best-effort; the booking itself already succeeded.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          {/* data-ph-mask: the order number is user data */}
          <DialogTitle data-ph-mask="">
            {isRefund
              ? t('book_refund_title', { number: order.order_number })
              : t('book_title', { number: order.order_number })}
          </DialogTitle>
          <DialogDescription>
            {formatDate(order.paid_date ?? order.order_date)}
            {' · '}
            {formatCurrency(order.total, order.currency)}
            {methodLabel ? ` · ${methodLabel}` : ''}
          </DialogDescription>
        </DialogHeader>

        {fxUnresolved ? (
          <p className="text-sm text-muted-foreground">{t('fx_unresolved')}</p>
        ) : (
          <div className="space-y-4">
            {/* One attn line (convention 6), priority order: a VAT compliance
                warning always outranks the invoice-mode convenience hint
                (Swedish review: the hint must never suppress a real
                cross-border VAT advisory). */}
            {(() => {
              const warnings = resolveBookingWarnings(order)
              if (warnings.length > 0) {
                return (
                  <p className="attn text-[12.5px]">{t(`warning_${warnings[0]}`)}</p>
                )
              }
              if (resolved.invoiceMode && !isRefund) {
                return <p className="attn text-[12.5px]">{t('invoice_mode_hint')}</p>
              }
              return null
            })()}
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="order-payment-account" className="text-xs">
                  {t('payment_account_label')}
                </Label>
                <Input
                  id="order-payment-account"
                  value={paymentAccount}
                  onChange={(e) => setPaymentAccount(e.target.value.trim())}
                  inputMode="numeric"
                  maxLength={4}
                  className="w-28 tabular-nums"
                  aria-invalid={!accountValid}
                  aria-describedby={!accountValid ? 'order-payment-account-error' : undefined}
                />
                {!accountValid && (
                  <p
                    id="order-payment-account-error"
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    {t('invalid_account')}
                  </p>
                )}
              </div>
              {order.payment_method && (
                <label className="flex items-center gap-2 pb-2 text-[12.5px] text-muted-foreground">
                  <Checkbox
                    checked={remember}
                    onCheckedChange={(v) => setRemember(v === true)}
                  />
                  {t('remember_account', { method: methodLabel })}
                </label>
              )}
            </div>

            {initialLines && (
              <JournalEntryForm
                key={`${order.id}-${paymentAccount}`}
                bare
                initialLines={initialLines}
                initialDate={order.paid_date ?? order.order_date}
                initialDescription={
                  isRefund
                    ? `Återbetalning order ${order.order_number}`
                    : methodLabel
                      ? `Order ${order.order_number} (${methodLabel})`
                      : `Order ${order.order_number}`
                }
                sourceType="webshop_order"
                sourceId={order.id}
                submitUrl={`/api/webshop-orders/${order.id}/book`}
                onEntryCreated={() => {
                  if (remember) void persistMapping()
                  onBooked()
                }}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
