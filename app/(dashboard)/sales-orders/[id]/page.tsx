'use client'

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowLeft, Check, ClipboardList, Lock, Pencil, ReceiptText, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import RegisterDeliveryDialog from '@/components/sales-orders/RegisterDeliveryDialog'
import CreateInvoiceDialog from '@/components/sales-orders/CreateInvoiceDialog'
import {
  DELIVERY_LABEL_KEY,
  INVOICING_LABEL_KEY,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL_KEY,
  formatQty,
} from '@/components/sales-orders/labels'
import type { Invoice, InvoiceStatus, SalesOrder, SalesOrderItem } from '@/types'

type Transition = 'confirm' | 'cancel' | 'reopen'

const TRANSITION_COPY: Record<
  Transition,
  { title: string; description: string; label: string; toast: string; destructive: boolean }
> = {
  confirm: {
    title: 'confirm_dialog_title',
    description: 'confirm_dialog_description',
    label: 'confirm_dialog_label',
    toast: 'confirmed_toast',
    destructive: false,
  },
  cancel: {
    title: 'cancel_dialog_title',
    description: 'cancel_dialog_description',
    label: 'cancel_dialog_label',
    toast: 'cancelled_toast',
    destructive: true,
  },
  reopen: {
    title: 'reopen_dialog_title',
    description: 'reopen_dialog_description',
    label: 'reopen_dialog_label',
    toast: 'reopened_toast',
    destructive: false,
  },
}

function isTextLine(item: SalesOrderItem): boolean {
  return item.line_type === 'text'
}

const INVOICE_STATUS_LABEL_KEY: Record<InvoiceStatus, string> = {
  draft: 'invoice_status_draft',
  sent: 'invoice_status_sent',
  paid: 'invoice_status_paid',
  partially_paid: 'invoice_status_partially_paid',
  overdue: 'invoice_status_overdue',
  cancelled: 'invoice_status_cancelled',
  credited: 'invoice_status_credited',
}

// Chips mark exceptions: a draft, an overdue or a cancelled invoice deviates
// from the paid-in-time path; the rest render as muted text.
const INVOICE_STATUS_BADGE: Partial<Record<InvoiceStatus, 'outline' | 'warning' | 'destructive'>> = {
  draft: 'outline',
  overdue: 'warning',
  cancelled: 'destructive',
}

export default function SalesOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('sales_order_detail')
  const tList = useTranslations('sales_orders')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps: deleteDialogProps, confirm: confirmDelete } = useDestructiveConfirm()

  const [order, setOrder] = useState<SalesOrder | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [pendingTransition, setPendingTransition] = useState<Transition | null>(null)
  const [isDeliveryOpen, setIsDeliveryOpen] = useState(false)
  const [isInvoiceOpen, setIsInvoiceOpen] = useState(false)
  // Invoices created from this order (GET /api/invoices?sales_order_id=).
  const [invoices, setInvoices] = useState<Invoice[]>([])

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch(`/api/sales-orders/${id}`)
      if (!res.ok) throw new Error('load failed')
      const { data } = await res.json()
      setOrder(data as SalesOrder)
    } catch {
      toast({ title: t('load_failed_title'), variant: 'destructive' })
      router.push('/sales-orders')
    } finally {
      setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await fetch(`/api/invoices?sales_order_id=${encodeURIComponent(id)}&limit=200`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw Object.assign(new Error('load failed'), { body: json, status: res.status })
      setInvoices((json?.data ?? []) as Invoice[])
    } catch (err) {
      const e = err as { body?: unknown; status?: number }
      toast({
        title: t('invoices_load_failed_title'),
        description: getErrorMessage(e.body ?? err, { locale: errorLocale, statusCode: e.status }),
        variant: 'destructive',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    void fetchOrder()
    void fetchInvoices()
  }, [fetchOrder, fetchInvoices])

  async function runTransition(action: Transition) {
    if (!order) return
    const res = await fetch(`/api/sales-orders/${order.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      toast({
        title: t('transition_failed_title'),
        description: getErrorMessage(json, { locale: errorLocale, statusCode: res.status }),
        variant: 'destructive',
      })
      return
    }
    setOrder(json.data as SalesOrder)
    toast({ title: t(TRANSITION_COPY[action].toast) })
    setPendingTransition(null)
  }

  async function handleDelete() {
    if (!order) return
    const number = order.order_number ?? ''
    await confirmDelete(
      {
        title: t('delete_confirm_title', { number }),
        description: t('delete_confirm_description'),
        confirmLabel: t('delete_confirm_label'),
        variant: 'destructive',
      },
      async () => {
        const res = await fetch(`/api/sales-orders/${order.id}`, { method: 'DELETE' })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          toast({
            title: t('delete_failed_title'),
            description: getErrorMessage(json, { locale: errorLocale, statusCode: res.status }),
            variant: 'destructive',
          })
          throw new Error('delete failed')
        }
        toast({ title: t('deleted_toast') })
        router.push('/sales-orders')
      },
    )
  }

  if (isLoading) return <DetailPageSkeleton />
  if (!order) return null

  const status = order.status
  const number = order.order_number ?? ''
  const badgeVariant = STATUS_BADGE_VARIANT[status]
  const canEdit = status === 'draft' || status === 'confirmed'
  const canConfirm = status === 'draft'
  const canDeliver = status === 'confirmed' || status === 'completed'
  const canInvoice = status === 'confirmed'
  const canCancel = status === 'draft' || status === 'confirmed'
  const canReopen = status === 'cancelled'
  const canDelete = status === 'draft' || status === 'cancelled'
  const items = [...(order.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  const lockTitle = !canWrite ? t('viewer_disabled_tooltip') : undefined
  const pending = pendingTransition ? TRANSITION_COPY[pendingTransition] : null

  return (
    <div className="space-y-8 stagger-enter">
      <div>
        <Link
          href="/sales-orders"
          className="mb-6 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 data-ph-mask="" className="font-display text-2xl leading-8 tracking-tight">
                {number ? t('title', { number }) : t('title_unnumbered')}
              </h1>
              {badgeVariant ? (
                <Badge variant={badgeVariant}>{tList(STATUS_LABEL_KEY[status])}</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">{tList(STATUS_LABEL_KEY[status])}</span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground" data-ph-mask="">
              {[order.customer?.name, formatDate(order.order_date)].filter(Boolean).join(' · ')}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {canEdit && (
              <Button variant="outline" asChild={canWrite} disabled={!canWrite} title={lockTitle}>
                {canWrite ? (
                  <Link href={`/sales-orders/${order.id}/edit`}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t('action_edit')}
                  </Link>
                ) : (
                  <span>
                    <Lock className="mr-2 h-4 w-4" />
                    {t('action_edit')}
                  </span>
                )}
              </Button>
            )}
            {canDeliver && (
              <Button
                variant={canInvoice ? 'outline' : 'default'}
                onClick={() => setIsDeliveryOpen(true)}
                disabled={!canWrite}
                title={lockTitle}
              >
                {canWrite ? <Truck className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('action_register_delivery')}
              </Button>
            )}
            {canInvoice && (
              <Button onClick={() => setIsInvoiceOpen(true)} disabled={!canWrite} title={lockTitle}>
                {canWrite ? <ReceiptText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('action_create_invoice')}
              </Button>
            )}
            {canConfirm && (
              <Button onClick={() => setPendingTransition('confirm')} disabled={!canWrite} title={lockTitle}>
                {canWrite ? <Check className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('action_confirm')}
              </Button>
            )}
            {canReopen && (
              <Button onClick={() => setPendingTransition('reopen')} disabled={!canWrite} title={lockTitle}>
                {canWrite ? <ClipboardList className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('action_reopen')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <DetailSection kicker={t('section_details')}>
        <DefRow label={t('def_customer')}>
          {order.customer ? (
            <Link href={`/customers/${order.customer.id}`} className="hover:underline">
              {order.customer.name}
            </Link>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('def_order_date')}>
          <span className="tabular-nums">{formatDate(order.order_date)}</span>
        </DefRow>
        <DefRow label={t('def_requested_delivery_date')}>
          {order.requested_delivery_date ? (
            <span className="tabular-nums">{formatDate(order.requested_delivery_date)}</span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        {order.last_delivery_date && (
          <DefRow label={t('def_last_delivery_date')}>
            <span className="tabular-nums">{formatDate(order.last_delivery_date)}</span>
          </DefRow>
        )}
        <DefRow label={t('def_delivery')}>
          <span className="text-muted-foreground">
            {tList(DELIVERY_LABEL_KEY[order.delivery_progress ?? 'none'])}
          </span>
        </DefRow>
        <DefRow label={t('def_invoicing')}>
          <span className="text-muted-foreground">
            {tList(INVOICING_LABEL_KEY[order.invoicing_progress ?? 'none'])}
          </span>
        </DefRow>
        <DefRow label={t('def_currency')}>{order.currency}</DefRow>
        {order.your_reference && <DefRow label={t('def_your_reference')}>{order.your_reference}</DefRow>}
        {order.our_reference && <DefRow label={t('def_our_reference')}>{order.our_reference}</DefRow>}
        {order.source_invoice_id && (
          <DefRow label={t('def_source_invoice')}>
            <Link href={`/invoices/${order.source_invoice_id}`} className="hover:underline">
              {t('source_proforma')}
            </Link>
          </DefRow>
        )}
        {order.notes && (
          <DefRow label={t('def_notes')}>
            <span className="whitespace-pre-wrap">{order.notes}</span>
          </DefRow>
        )}
      </DetailSection>

      <DetailSection kicker={t('section_lines')}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_quantity')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_delivered')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_invoiced')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_remaining')}</th>
                <th className={cn(TH_CLASS, 'hidden text-right md:table-cell')}>{t('th_unit_price')}</th>
                <th className={cn(TH_CLASS, 'hidden text-right md:table-cell')}>{t('th_discount')}</th>
                <th className={cn(TH_CLASS, 'hidden text-right md:table-cell')}>{t('th_vat')}</th>
                <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) =>
                isTextLine(item) ? (
                  <tr key={item.id}>
                    <td colSpan={9} className={cn(TD_CLASS, 'pl-0 pr-0 text-muted-foreground')}>
                      {item.description || ' '}
                    </td>
                  </tr>
                ) : (
                  <tr key={item.id}>
                    <td className={cn(TD_CLASS, 'pl-0')}>{item.description}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {formatQty(item.quantity)} {item.unit}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
                      {formatQty(item.delivered_qty)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
                      {formatQty(item.invoiced_qty ?? 0)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {formatQty(item.remaining_qty ?? Math.max(0, item.quantity - (item.invoiced_qty ?? 0)))}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums md:table-cell')}>
                      {formatCurrency(item.unit_price, order.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground md:table-cell')}>
                      {item.discount_percent > 0 ? `${formatQty(item.discount_percent)} %` : ''}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground md:table-cell')}>
                      {formatQty(item.vat_rate)} %
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>
                      {formatCurrency(item.line_total, order.currency)}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-6 ml-auto w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('subtotal')}</span>
            <span className="tabular-nums">{formatCurrency(order.subtotal, order.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('vat')}</span>
            <span className="tabular-nums">{formatCurrency(order.vat_amount, order.currency)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <span>{t('total')}</span>
            <span className="font-display text-xl tabular-nums">{formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>
      </DetailSection>

      {invoices.length > 0 && (
        <DetailSection kicker={t('section_invoices')}>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'pl-0')}>{t('th_invoice_number')}</th>
                <th className={TH_CLASS}>{t('th_invoice_status')}</th>
                <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_invoice_total')}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const variant = INVOICE_STATUS_BADGE[invoice.status]
                const label = t(INVOICE_STATUS_LABEL_KEY[invoice.status] ?? 'invoice_status_draft')
                return (
                  <tr key={invoice.id} className="transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'pl-0 tabular-nums')}>
                      <Link href={`/invoices/${invoice.id}`} className="hover:underline">
                        {invoice.invoice_number ?? t('invoice_draft_label')}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {variant ? (
                        <Badge variant={variant} className="font-normal">{label}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{label}</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>
                      {formatCurrency(invoice.total, invoice.currency)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </DetailSection>
      )}

      {(canCancel || canDelete) && canWrite && (
        <div className="flex flex-wrap items-center justify-end gap-1">
          {canCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingTransition('cancel')}
              className="min-h-10 text-muted-foreground hover:text-destructive"
            >
              {t('action_cancel')}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              className="min-h-10 text-muted-foreground hover:text-destructive"
            >
              {t('action_delete')}
            </Button>
          )}
        </div>
      )}

      {pending && pendingTransition && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPendingTransition(null)}
          title={t(pending.title, { number })}
          description={t(pending.description)}
          confirmLabel={t(pending.label)}
          cancelLabel={tCommon('cancel')}
          destructive={pending.destructive}
          onConfirm={() => runTransition(pendingTransition)}
        />
      )}

      <RegisterDeliveryDialog
        open={isDeliveryOpen}
        onOpenChange={setIsDeliveryOpen}
        order={order}
        onRegistered={setOrder}
      />
      <CreateInvoiceDialog
        open={isInvoiceOpen}
        onOpenChange={setIsInvoiceOpen}
        order={order}
        onCreated={(next) => {
          setOrder(next)
          void fetchInvoices()
        }}
      />
      <DestructiveConfirmDialog {...deleteDialogProps} />
    </div>
  )
}
