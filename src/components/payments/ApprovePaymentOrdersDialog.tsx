'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency } from '@/lib/utils'
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

  /** A new or changed account, confirmed where it is shown: the account appears once. */
  function confirmPayee(order: PaymentOrder) {
    const invoiceId = order.supplier_invoice_id as string
    return (
      <label className="flex items-start gap-2 text-[13px]">
        <Checkbox
          className="mt-0.5 border-foreground"
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
        <span>{t(order.payee_check === 'changed' ? 'confirm_changed_payee' : 'confirm_new_payee', { payee: payeeLabel(order) })}</span>
      </label>
    )
  }

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
      <DialogContent
        // max-w-xl keeps the three footer buttons on one line for the usual case.
        className={cn('outline-none', payments.length === 1 ? 'max-w-4xl' : 'max-w-xl')}
        // Focus starts on the dialog itself, not on the first document icon:
        // Tab reaches the rows from the top.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          content.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('approve_title', { count: orders.length })}</DialogTitle>
          <DialogDescription>{t('approve_description', { total: formatCurrency(total, orders[0]?.currency ?? 'SEK') })}</DialogDescription>
        </DialogHeader>
        {payments.length === 1 ? (
          <>
            <PaymentBesideDocument payment={payments[0]} />
            {toConfirm.length > 0 && confirmPayee(toConfirm[0])}
          </>
        ) : (
          <ul className="max-h-80 overflow-y-auto text-[13px]">
            {orders.map((o, index) => {
              const needsConfirmation = toConfirm.includes(o)
              return (
                <li key={o.id} className="space-y-1 border-b-hairline py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{orderInvoiceLabel(o)}</span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <InvoiceDocumentButton payment={payments[index]} onOpen={setDocumentKey} />
                      {formatCurrency(Number(o.amount), o.currency)}
                    </span>
                  </div>
                  {needsConfirmation ? (
                    <>
                      {confirmPayee(o)}
                      <DocumentCheckLine payment={payments[index]} skipMissing className="pl-6" />
                    </>
                  ) : (
                    <DocumentCheckLine payment={payments[index]} lead={payeeLabel(o)} skipMissing />
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <InvoiceDocumentSheet payment={payments.find((p) => p.key === documentKey) ?? null} onClose={() => setDocumentKey(null)} />
        {/* Three buttons can outgrow one line (a longer count, English): let the footer wrap instead of clipping the first button. */}
        <DialogFooter className="sm:flex-wrap sm:gap-y-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
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
