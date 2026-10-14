'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { approvePaymentOrders, orderInvoiceLabel, payeeLabel, PaymentsClientError, type PaymentOrder } from './payments-client'
import { RequestSigningLinkButton } from './RequestSigningLinkDialog'
import { DocumentCheckLine, InvoiceDocumentButton, InvoiceDocumentSheet, PaymentBesideDocument, paymentFromOrder } from './InvoiceDocumentPreview'

interface ApprovePaymentOrdersDialogProps {
  orders: PaymentOrder[]
  onOpenChange: (open: boolean) => void
  onApproved: () => void
  /** Godkänn och be någon annan signera: called with the approved orders when the person chose that. */
  onRequestSignature?: (orders: PaymentOrder[]) => void
}

/**
 * Godkänn: attest drafts before anyone signs them (convention 10, confirm up
 * front). An order to an account that is new for the supplier or differs from
 * the supplier card is confirmed one by one; the server refuses the approval
 * without those confirmations. Drafts are often prepared by someone else (an
 * agent, the byrå), so the approver sees each invoice's document beside the
 * payment: beside it for one order, behind a document icon per row for several.
 */
export function ApprovePaymentOrdersDialog({ orders, onOpenChange, onApproved, onRequestSignature }: ApprovePaymentOrdersDialogProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [then, setThen] = useState<'close' | 'request'>('close')
  const [documentKey, setDocumentKey] = useState<string | null>(null)
  const payments = useMemo(() => orders.map(paymentFromOrder), [orders])

  const toConfirm = useMemo(() => orders.filter((o) => o.payee_check === 'new' || o.payee_check === 'changed'), [orders])
  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const allConfirmed = toConfirm.every((o) => o.supplier_invoice_id && confirmed.has(o.supplier_invoice_id))

  async function approve(next: 'close' | 'request' = 'close') {
    setThen(next)
    setBusy(true)
    try {
      const { approved } = await approvePaymentOrders({ orderIds: orders.map((o) => o.id), confirmedPayeeInvoiceIds: [...confirmed] })
      onApproved()
      onOpenChange(false)
      if (next === 'request') onRequestSignature?.(orders.filter((o) => approved.includes(o.id)).map((o) => ({ ...o, status: 'approved' as const })))
    } catch (error) {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title: t('approve_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className={payments.length === 1 ? 'max-w-4xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{t('approve_title', { count: orders.length })}</DialogTitle>
          <DialogDescription>{t('approve_description', { total: formatCurrency(total, orders[0]?.currency ?? 'SEK') })}</DialogDescription>
        </DialogHeader>
        {payments.length === 1 ? (
          <PaymentBesideDocument payment={payments[0]} />
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto text-[13px]">
            {orders.map((o, index) => (
              <li key={o.id} className="flex items-center justify-between gap-3 border-b border-border py-2">
                <div className="min-w-0">
                  <span className="block truncate">{orderInvoiceLabel(o)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground tabular-nums">{payeeLabel(o)}</span>
                  <DocumentCheckLine payment={payments[index]} />
                </div>
                <span className="flex shrink-0 items-center gap-1 tabular-nums">
                  <InvoiceDocumentButton payment={payments[index]} onOpen={setDocumentKey} />
                  {formatCurrency(Number(o.amount), o.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <InvoiceDocumentSheet payment={payments.find((p) => p.key === documentKey) ?? null} onClose={() => setDocumentKey(null)} />
        {toConfirm.length > 0 && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-muted-foreground">{t('confirm_payees_intro')}</p>
            {toConfirm.map((order) => {
              const invoiceId = order.supplier_invoice_id as string
              return (
                <label key={order.id} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    className="border-foreground"
                    checked={confirmed.has(invoiceId)}
                    onCheckedChange={(v) =>
                      setConfirmed((prev) => {
                        const next = new Set(prev)
                        if (v === true) next.add(invoiceId)
                        else next.delete(invoiceId)
                        return next
                      })
                    }
                  />
                  <span>{t('confirm_payee_row', { supplier: order.payee_name, payee: payeeLabel(order) })}</span>
                </label>
              )
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          {onRequestSignature && (
            <RequestSigningLinkButton label="approve_and_request" onClick={() => approve('request')} loading={busy && then === 'request'} disabled={busy || !allConfirmed} />
          )}
          <Button onClick={() => approve()} loading={busy && then === 'close'} disabled={busy || !allConfirmed}>
            {t('approve', { count: orders.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
