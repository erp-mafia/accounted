'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency } from '@/lib/utils'
import type { WebshopOrder } from '@/types'

interface CreateInvoiceFromOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  order: WebshopOrder
  onCreated: () => void
}

/**
 * Order -> DRAFT kundfaktura (confirm up front, convention 10): the dialog
 * states exactly what will happen, the user confirms, and lands in the draft
 * to review before sending. The customer is matched by e-mail or created from
 * the order's billing snapshot server-side; the scraped orgnr is shown here
 * for the user to eyeball since it never auto-lands on legal invoice fields.
 */
export default function CreateInvoiceFromOrderDialog({
  open,
  onOpenChange,
  order,
  onCreated,
}: CreateInvoiceFromOrderDialogProps) {
  const t = useTranslations('webshop_orders')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)

  const customerLabel =
    order.customer_company || order.customer_name || t('invoice_no_customer')

  async function handleCreate() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/webshop-orders/${order.id}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = (await res.json()) as { invoice_id?: string }
      if (!res.ok || !json.invoice_id) {
        toast({
          title: t('invoice_create_failed'),
          description: getErrorMessage(json, { statusCode: res.status, locale }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('invoice_created') })
      onCreated()
      router.push(`/invoices/${json.invoice_id}`)
    } catch {
      toast({ title: t('invoice_create_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          {/* data-ph-mask: order number and customer name are user data */}
          <DialogTitle data-ph-mask="">{t('invoice_title', { number: order.order_number })}</DialogTitle>
          <DialogDescription data-ph-mask="">
            {t('invoice_description', { customer: customerLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <div>{customerLabel}</div>
            {order.customer_email && (
              <div className="text-muted-foreground">{order.customer_email}</div>
            )}
            {order.customer_orgnr && (
              <div className="text-muted-foreground">
                {t('invoice_orgnr_hint', { orgnr: order.customer_orgnr })}
              </div>
            )}
          </div>

          {order.line_items.length > 0 && (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={VTH_CLASS}>{t('invoice_col_item')}</th>
                  <th className={cn(VTH_CLASS, 'text-right')}>{t('invoice_col_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {order.line_items.map((item, index) => (
                  <tr key={index}>
                    <td className={VTD_CLASS}>
                      {item.quantity} × {item.name}
                    </td>
                    <td className={cn(VTD_CLASS, 'text-right tabular-nums')}>
                      {formatCurrency(item.total + item.total_tax, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">{t('invoice_total')}</span>
            <span className="tabular-nums">{formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={submitting}>
            {submitting ? t('invoice_creating') : t('invoice_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
