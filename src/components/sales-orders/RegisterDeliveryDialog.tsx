'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import { formatQty, todayIso } from '@/components/sales-orders/labels'
import type { SalesOrder, SalesOrderItem } from '@/types'

interface RegisterDeliveryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: SalesOrder
  onRegistered: (order: SalesOrder) => void
}

function productLines(order: SalesOrder): SalesOrderItem[] {
  return [...(order.items ?? [])]
    .filter((i) => (i.line_type ?? 'product') === 'product')
    .sort((a, b) => a.sort_order - b.sort_order)
}

/**
 * Registers CUMULATIVE delivered quantities per line (what the user sees is
 * what is stored; a retry is idempotent). Prefilled with the current
 * delivered_qty so the dialog doubles as the correction surface.
 */
export default function RegisterDeliveryDialog({
  open,
  onOpenChange,
  order,
  onRegistered,
}: RegisterDeliveryDialogProps) {
  const t = useTranslations('sales_order_detail')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [deliveryDate, setDeliveryDate] = useState<string>(todayIso())
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Re-seed from the order every time the dialog opens: the order may have
  // changed since the last registration.
  useEffect(() => {
    if (!open) return
    setDeliveryDate(todayIso())
    const seed: Record<string, string> = {}
    for (const item of productLines(order)) seed[item.id] = String(item.delivered_qty ?? 0)
    setQuantities(seed)
  }, [open, order])

  const lines = productLines(order)

  function deliverAll() {
    const next: Record<string, string> = {}
    for (const item of lines) next[item.id] = String(item.quantity)
    setQuantities(next)
  }

  async function handleSubmit() {
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/sales-orders/${order.id}/deliver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delivery_date: deliveryDate || undefined,
          lines: lines.map((item) => ({
            sales_order_item_id: item.id,
            delivered_qty: Math.max(0, parseFloat((quantities[item.id] ?? '0').replace(',', '.')) || 0),
          })),
        }),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok) {
        toast({
          title: t('delivery_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale, statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('delivery_success') })
      onRegistered(json.data as SalesOrder)
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('delivery_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !isSubmitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('delivery_dialog_title')}</DialogTitle>
          <DialogDescription>{t('delivery_dialog_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="max-w-xs space-y-2">
            <Label htmlFor="so-delivery-date">{t('delivery_date_label')}</Label>
            <Input
              id="so-delivery-date"
              type="date"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              className="tabular-nums"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_ordered')}</th>
                  <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_delivered_qty')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((item) => (
                  <tr key={item.id}>
                    <td className={cn(TD_CLASS, 'pl-0')}>
                      <span className="block truncate">{item.description}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums text-muted-foreground')}>
                      {formatQty(item.quantity)} {item.unit}
                    </td>
                    <td className={cn(TD_CLASS, 'pr-0 text-right')}>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={0}
                        value={quantities[item.id] ?? ''}
                        onChange={(e) =>
                          setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        aria-label={`${t('th_delivered_qty')}: ${item.description}`}
                        className="ml-auto h-8 w-24 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Button type="button" variant="ghost" size="sm" onClick={deliverAll} className="text-muted-foreground">
            {t('deliver_all')}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isSubmitting || lines.length === 0}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('delivery_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
