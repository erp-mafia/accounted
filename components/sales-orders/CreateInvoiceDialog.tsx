'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import { formatQty } from '@/components/sales-orders/labels'
import type { SalesOrder, SalesOrderItem } from '@/types'

interface CreateInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: SalesOrder
  onCreated: (order: SalesOrder, invoiceId: string) => void
}

function productLines(order: SalesOrder): SalesOrderItem[] {
  return [...(order.items ?? [])]
    .filter((i) => (i.line_type ?? 'product') === 'product')
    .sort((a, b) => a.sort_order - b.sort_order)
}

function remainingOf(item: SalesOrderItem): number {
  return Math.max(0, item.remaining_qty ?? item.quantity - (item.invoiced_qty ?? 0))
}

function deliveredNotInvoicedOf(item: SalesOrderItem): number {
  return Math.max(0, Math.min(remainingOf(item), (item.delivered_qty ?? 0) - (item.invoiced_qty ?? 0)))
}

function parseQty(value: string | undefined): number {
  const n = parseFloat((value ?? '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Creates a DRAFT kundfaktura from the order for the picked quantities.
 * Prefilled with what remains; the two shortcuts reseed the picks (all
 * remaining / delivered but not yet invoiced). The explicit line picks are
 * what is sent, so what the user sees is exactly what gets invoiced.
 */
export default function CreateInvoiceDialog({
  open,
  onOpenChange,
  order,
  onCreated,
}: CreateInvoiceDialogProps) {
  const t = useTranslations('sales_order_detail')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [invoiceDate, setInvoiceDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const lines = productLines(order)

  function seed(mode: 'remaining' | 'delivered') {
    const next: Record<string, string> = {}
    for (const item of productLines(order)) {
      const qty = mode === 'remaining' ? remainingOf(item) : deliveredNotInvoicedOf(item)
      next[item.id] = qty > 0 ? String(qty) : ''
    }
    setQuantities(next)
  }

  useEffect(() => {
    if (!open) return
    setInvoiceDate('')
    setDueDate('')
    const next: Record<string, string> = {}
    for (const item of productLines(order)) {
      const qty = remainingOf(item)
      next[item.id] = qty > 0 ? String(qty) : ''
    }
    setQuantities(next)
  }, [open, order])

  const picked = lines
    .map((item) => ({ sales_order_item_id: item.id, quantity: parseQty(quantities[item.id]) }))
    .filter((l) => l.quantity > 0)

  async function handleSubmit() {
    if (picked.length === 0) {
      toast({ title: t('invoice_nothing_selected'), variant: 'destructive' })
      return
    }
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/sales-orders/${order.id}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: picked,
          ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
          ...(dueDate ? { due_date: dueDate } : {}),
        }),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok) {
        toast({
          title: t('invoice_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale, statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const invoiceId: string = json.invoice_id
      toast({
        title: t('invoice_created_title'),
        description: t('invoice_created_description'),
        action: (
          <ToastAction altText={t('open_invoice')} onClick={() => router.push(`/invoices/${invoiceId}`)}>
            {t('open_invoice')}
          </ToastAction>
        ),
      })
      onCreated(json.data.order as SalesOrder, invoiceId)
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('invoice_failed_title'),
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
          <DialogTitle>{t('invoice_dialog_title')}</DialogTitle>
          <DialogDescription>{t('invoice_dialog_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => seed('remaining')}>
              {t('mode_remaining')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => seed('delivered')}>
              {t('mode_delivered')}
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('th_remaining_qty')}</th>
                  <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_invoice_qty')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((item) => (
                  <tr key={item.id}>
                    <td className={cn(TD_CLASS, 'pl-0')}>
                      <span className="block truncate">{item.description}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums text-muted-foreground')}>
                      {formatQty(remainingOf(item))} {item.unit}
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
                        aria-label={`${t('th_invoice_qty')}: ${item.description}`}
                        className="ml-auto h-8 w-24 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="so-invoice-date">{t('invoice_date_label')}</Label>
              <Input
                id="so-invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="so-due-date">{t('due_date_label')}</Label>
              <Input
                id="so-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="tabular-nums"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isSubmitting || picked.length === 0}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('invoice_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
