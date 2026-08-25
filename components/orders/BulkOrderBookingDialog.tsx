'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  resolveBookingWarnings,
  resolvePaymentAccount,
} from '@/lib/webshop-orders/booking-lines'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

interface BulkBookOrderResult {
  order_id: string
  order_number: string | null
  success: boolean
  journal_entry_id?: string
  voucher_series?: string | null
  voucher_number?: number | null
  error?: { code: string; message: string; message_en?: string }
}

interface BulkOrderBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orders: WebshopOrder[]
  settingsFor: (order: WebshopOrder) => WebshopStoreSettings | null
  /** Called after the server processed the batch (also on partial failure). */
  onBooked: () => void
}

/**
 * Book N selected orders with the standard order template in one sweep
 * (confirm up front, convention 10). Each order still becomes its own
 * verifikat server-side via the same flow as the single-order dialog; this
 * dialog only chooses the payment counter-account policy: per-store mapping
 * (default) or one explicit account for the whole selection. Partial failure
 * is surfaced per order in a result list instead of aborting the batch.
 */
export default function BulkOrderBookingDialog({
  open,
  onOpenChange,
  orders,
  settingsFor,
  onBooked,
}: BulkOrderBookingDialogProps) {
  const t = useTranslations('webshop_orders')
  const locale = useLocale()
  const { toast } = useToast()

  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideAccount, setOverrideAccount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<BulkBookOrderResult[] | null>(null)

  // Client-side mirror of the server's review guards, so the confirmation
  // describes exactly what will book (convention 10) instead of promising a
  // sweep the server then partially refuses:
  // - empty vat_breakdown: the prefill would be a ratio-inferred GUESS that
  //   only the single dialog's editable form may show;
  // - invoice-mode mapping: the store routes this method through the invoice
  //   flow, and booking would foreclose Skapa faktura for the order.
  // The server enforces the same rules for non-UI callers.
  const { bookableOrders, skippedMissingBreakdown, skippedInvoiceMode } = useMemo(() => {
    const missing: WebshopOrder[] = []
    const invoiceMode: WebshopOrder[] = []
    const bookable: WebshopOrder[] = []
    for (const order of orders) {
      if (order.vat_breakdown.length === 0) missing.push(order)
      else if (resolvePaymentAccount(order, settingsFor(order)).invoiceMode)
        invoiceMode.push(order)
      else bookable.push(order)
    }
    return {
      bookableOrders: bookable,
      skippedMissingBreakdown: missing,
      skippedInvoiceMode: invoiceMode,
    }
  }, [orders, settingsFor])

  // Signed sum per currency: refunds carry negative totals and reduce the
  // batch total honestly instead of inflating it.
  const currencyTotals = useMemo(() => {
    const byCurrency = new Map<string, number>()
    for (const order of bookableOrders) {
      const code = order.currency.toUpperCase()
      byCurrency.set(code, roundOre((byCurrency.get(code) ?? 0) + order.total))
    }
    return Array.from(byCurrency.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [bookableOrders])

  // Payment-method groups with their resolved counter-account, so the user
  // sees exactly which account each slice of the selection will book against
  // before confirming.
  const accountGroups = useMemo(() => {
    const groups = new Map<string, { label: string; account: string; count: number }>()
    for (const order of bookableOrders) {
      const { account } = resolvePaymentAccount(order, settingsFor(order))
      const label = order.payment_method_title || order.payment_method || ''
      const key = `${label}|${account}`
      const existing = groups.get(key)
      if (existing) existing.count += 1
      else groups.set(key, { label, account, count: 1 })
    }
    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [bookableOrders, settingsFor])

  // Advisory VAT warnings stay per order, not an anonymous count: the user
  // must be able to tell WHICH orders deserve the single-dialog review.
  const warningOrderNumbers = useMemo(
    () =>
      bookableOrders
        .filter((o) => resolveBookingWarnings(o).length > 0)
        .map((o) => o.order_number),
    [bookableOrders],
  )

  const uniformAccount =
    accountGroups.length > 0 &&
    accountGroups.every((g) => g.account === accountGroups[0].account)
      ? accountGroups[0].account
      : null

  // Reset per open so a second sweep starts clean.
  useEffect(() => {
    if (open) {
      setOverrideEnabled(false)
      setOverrideAccount(uniformAccount ?? '')
      setSubmitting(false)
      setResults(null)
    }
    // uniformAccount is derived from the selection the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const overrideValid = ACCOUNT_NUMBER_RE.test(overrideAccount)
  const canConfirm =
    !submitting && bookableOrders.length > 0 && (!overrideEnabled || overrideValid)

  async function handleConfirm() {
    if (!canConfirm) return
    setSubmitting(true)
    try {
      const response = await fetch('/api/webshop-orders/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_ids: bookableOrders.map((o) => o.id),
          ...(overrideEnabled && overrideValid
            ? { payment_account: overrideAccount }
            : {}),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        toast({
          title: t('bulk_error_title'),
          description: getErrorMessage(body, { statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: {
          results: BulkBookOrderResult[]
          booked_count: number
          failed_count: number
        }
      }
      if (body.data.failed_count === 0) {
        toast({
          title: t('bulk_success_title'),
          description: t('bulk_success_description', { count: body.data.booked_count }),
          variant: 'success',
        })
        onBooked()
        onOpenChange(false)
        return
      }
      // Partial failure: keep the dialog open on the per-order report; the
      // list behind refreshes so the booked rows leave "att bokföra".
      setResults(body.data.results)
      onBooked()
    } catch (err) {
      toast({
        title: t('bulk_error_title'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (orders.length === 0) return null

  const failures = (results ?? []).filter((r) => !r.success)
  const bookedCount = (results ?? []).filter((r) => r.success).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-[560px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('bulk_title', { count: bookableOrders.length })}</DialogTitle>
          <DialogDescription>{t('bulk_description')}</DialogDescription>
        </DialogHeader>

        {results ? (
          <div className="space-y-4">
            <p className="text-sm">
              {t('bulk_partial_summary', {
                booked: bookedCount,
                failed: failures.length,
              })}
            </p>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('bulk_failed_heading')}
              </p>
              <ul className="space-y-1">
                {failures.map((r) => (
                  <li key={r.order_id} className="text-xs" data-ph-mask="">
                    <span className="tabular-nums">{r.order_number ?? r.order_id}</span>
                    {': '}
                    <span className="text-muted-foreground">
                      {locale === 'en' && r.error?.message_en
                        ? r.error.message_en
                        : (r.error?.message ?? t('bulk_unknown_error'))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {bookableOrders.length > 0 && (
            <>
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('bulk_totals_label')}
              </p>
              <ul className="mt-2 space-y-1">
                {currencyTotals.map(([code, total]) => (
                  <li
                    key={code}
                    className="flex items-center justify-between text-sm tabular-nums"
                  >
                    <span className="font-mono text-xs text-muted-foreground">{code}</span>
                    <span>{formatCurrency(total, code)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {t('bulk_account_plan_label')}
              </p>
              <ul className="space-y-1">
                {accountGroups.map((g) => (
                  <li
                    key={`${g.label}-${g.account}`}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="truncate">
                      {g.label || t('bulk_no_method')}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {overrideEnabled && overrideValid ? overrideAccount : g.account}
                      {' · '}
                      {t('bulk_group_count', { count: g.count })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Checkbox
                  checked={overrideEnabled}
                  onCheckedChange={(v) => setOverrideEnabled(v === true)}
                />
                {t('bulk_override_label')}
              </label>
              {overrideEnabled && (
                <div className="space-y-1">
                  <Label htmlFor="bulk-order-payment-account" className="text-xs">
                    {t('payment_account_label')}
                  </Label>
                  <Input
                    id="bulk-order-payment-account"
                    value={overrideAccount}
                    onChange={(e) => setOverrideAccount(e.target.value.trim())}
                    inputMode="numeric"
                    maxLength={4}
                    className="w-28 tabular-nums"
                    aria-invalid={!overrideValid}
                    aria-describedby={
                      !overrideValid ? 'bulk-order-payment-account-error' : undefined
                    }
                  />
                  {!overrideValid && (
                    <p
                      id="bulk-order-payment-account-error"
                      className="text-xs text-destructive"
                      role="alert"
                    >
                      {t('invalid_account')}
                    </p>
                  )}
                </div>
              )}
            </div>
            </>
            )}

            {/* Skip notices: these selected orders will NOT be part of the
                sweep (mirrored server-side); the escape hatch is the
                single-order dialog where the lines are reviewable. */}
            {skippedMissingBreakdown.length > 0 && (
              <p className="attn text-[12.5px]" data-ph-mask="">
                {t('bulk_skipped_missing_breakdown', {
                  numbers: skippedMissingBreakdown.map((o) => o.order_number).join(', '),
                })}
              </p>
            )}
            {skippedInvoiceMode.length > 0 && (
              <p className="attn text-[12.5px]" data-ph-mask="">
                {t('bulk_skipped_invoice_mode', {
                  numbers: skippedInvoiceMode.map((o) => o.order_number).join(', '),
                })}
              </p>
            )}
            {/* Advisory only (soft-guard rule): the sweep still books these;
                the named orders are better reviewed one by one. */}
            {warningOrderNumbers.length > 0 && (
              <p className="attn text-[12.5px]" data-ph-mask="">
                {t('bulk_warning_orders', { numbers: warningOrderNumbers.join(', ') })}
              </p>
            )}
            {bookableOrders.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('bulk_none_bookable')}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('bulk_close')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                {t('cancel')}
              </Button>
              <Button onClick={() => void handleConfirm()} disabled={!canConfirm}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('bulk_confirm', { count: bookableOrders.length })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
