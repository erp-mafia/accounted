'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, CheckCircle, CreditCard, FileText, Trash2, Lock, Undo2, Info } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import Link from 'next/link'
import { AccountNumber } from '@/components/ui/account-number'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { SupplierInvoice, SupplierInvoiceItem, SupplierInvoicePayment } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const statusVariants: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'destructive',
  credited: 'secondary',
  reversed: 'secondary',
}

export default function SupplierInvoiceDetailPage() {
  const { canWrite } = useCanWrite()
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('supplier_invoice_detail')
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPayDialogOpen, setIsPayDialogOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [isProcessing, setIsProcessing] = useState(false)
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    Array<{
      id: string
      date: string
      amount: number
      description: string | null
      merchant_name: string | null
    }> | null
  >(null)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  const statusLabels = useMemo<Record<string, string>>(() => ({
    registered: t('status_registered'),
    approved: t('status_approved'),
    paid: t('status_paid'),
    partially_paid: t('status_partially_paid'),
    overdue: t('status_overdue'),
    disputed: t('status_disputed'),
    credited: t('status_credited'),
    reversed: t('status_reversed'),
  }), [t])

  async function fetchInvoice() {
    setIsLoading(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}`)
    const { data, error } = await res.json()
    if (error) {
      toast({ title: t('load_failed_title'), description: error, variant: 'destructive' })
    } else {
      setInvoice(data)
      setPayAmount(String(data.remaining_amount))
      setPaymentDate(new Date().toISOString().split('T')[0])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoice()
  }, [params.id])

  async function handleApprove() {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/approve`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('approve_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('approved_title'), description: t('approved_description') })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleMarkPaid(force: boolean = false) {
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: parseFloat(payAmount), payment_date: paymentDate, ...(force ? { force: true } : {}) }),
    })
    const result = await res.json()
    if (!res.ok) {
      if (result?.error?.code === 'SI_PAID_LIKELY_DUPLICATE' && Array.isArray(result.error.details?.candidates)) {
        setDuplicateCandidates(result.error.details.candidates)
        setIsPayDialogOpen(false)
      } else {
        toast({ title: t('payment_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
      }
    } else {
      toast({
        title: result.status === 'paid' ? t('paid_title') : t('partial_payment_title'),
        description: t('amount_registered_description', { amount: formatAmount(parseFloat(payAmount)) }),
      })
      setIsPayDialogOpen(false)
      setDuplicateCandidates(null)
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleCredit() {
    const ok = await confirmAction({
      title: t('credit_confirm_title'),
      description: t('credit_confirm_description'),
      confirmLabel: t('credit_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/credit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('credit_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('credit_success_title') })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: t('delete_confirm_title'),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return
    const res = await fetch(`/api/supplier-invoices/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('delete_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
    } else {
      toast({ title: t('deleted_title') })
      router.push('/supplier-invoices')
    }
  }

  async function handleUncredit() {
    const ok = await confirmAction({
      title: t('uncredit_confirm_title'),
      description: t('uncredit_confirm_description'),
      confirmLabel: t('uncredit_confirm_label'),
      variant: 'warning',
    })
    if (!ok) return
    setIsProcessing(true)
    const res = await fetch(`/api/supplier-invoices/${params.id}/uncredit`, { method: 'POST' })
    const result = await res.json()
    if (!res.ok) {
      toast({
        title: t('uncredit_failed_title'),
        description: getErrorMessage(result, { context: 'supplier_invoice' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: t('uncredit_success_title'),
        description: t('uncredit_success_description'),
      })
      fetchInvoice()
    }
    setIsProcessing(false)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Card className="animate-pulse"><CardContent className="h-48" /></Card>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('not_found')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/supplier-invoices')}>
          {t('back')}
        </Button>
      </div>
    )
  }

  const items = (invoice.items || []) as SupplierInvoiceItem[]
  const payments = (invoice.payments || []) as SupplierInvoicePayment[]

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => router.push('/supplier-invoices')} aria-label={t('back_aria')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="font-display text-2xl sm:text-3xl font-medium tracking-tight">
                {t('arrival_header', { number: invoice.arrival_number })}
              </h1>
              <Badge variant={statusVariants[invoice.status] || 'secondary'}>
                {statusLabels[invoice.status] || invoice.status}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm sm:text-base truncate">
              {t('header_subtitle', {
                supplier: invoice.supplier?.name ?? '',
                number: invoice.supplier_invoice_number,
              })}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <AgentSparkleButton
            intentId="supplier_invoice.review"
            intentArgs={{ supplier_invoice_id: invoice.id }}
            contextRef={`supplier_invoice:${invoice.id}`}
            size="default"
          />
          {invoice.status === 'registered' && !invoice.is_credit_note && (
            <>
              <Button
                onClick={handleApprove}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <CheckCircle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('approve')}
              </Button>
              <Button
                variant="destructive"
                size="icon"
                onClick={handleDelete}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                aria-label={t('delete_confirm_label')}
              >
                {canWrite ? <Trash2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </Button>
            </>
          )}
          {['approved', 'overdue', 'partially_paid'].includes(invoice.status) && (
            <>
              <Button
                onClick={() => setIsPayDialogOpen(true)}
                disabled={isProcessing || !canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <CreditCard className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('mark_paid')}
              </Button>
              {invoice.status !== 'partially_paid' && (
                <Button
                  variant="outline"
                  onClick={handleCredit}
                  disabled={isProcessing || !canWrite}
                  title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                >
                  {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                  {t('credit_note_button')}
                </Button>
              )}
            </>
          )}
          {invoice.status === 'credited' && !invoice.is_credit_note && (
            <Button
              variant="outline"
              onClick={handleUncredit}
              disabled={isProcessing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <Undo2 className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('uncredit_button')}
            </Button>
          )}
        </div>
      </div>

      {/* Credit note banner — explain why this row has no edit/delete affordances and where to undo */}
      {invoice.is_credit_note && (
        <div className="rounded-lg border bg-muted/40 p-4 flex gap-3 text-sm">
          <Info className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">{t('credit_note_banner_title')}</p>
            <p className="text-muted-foreground">
              {t('credit_note_banner_prefix')}{' '}
              {(invoice as SupplierInvoice & { credited_original?: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original ? (
                <Link
                  href={`/supplier-invoices/${(invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.id}`}
                  className="text-primary hover:underline font-medium"
                >
                  {t('credit_note_banner_link', { number: (invoice as SupplierInvoice & { credited_original: { id: string; supplier_invoice_number: string; arrival_number: number } }).credited_original.supplier_invoice_number })}
                </Link>
              ) : (
                <span>{t('credit_note_banner_original_fallback')}</span>
              )}
              {t('credit_note_banner_suffix')}
            </p>
          </div>
        </div>
      )}

      {/* Invoice details */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('invoice_info_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('arrival_number_label')}</span>
              <span className="font-mono">{invoice.arrival_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('invoice_number_label')}</span>
              <span>{invoice.supplier_invoice_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('invoice_date_label')}</span>
              <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('due_date_label')}</span>
              <span className="tabular-nums">{formatDate(invoice.due_date)}</span>
            </div>
            {invoice.delivery_date && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('delivery_date_label')}</span>
                <span>{invoice.delivery_date}</span>
              </div>
            )}
            {invoice.payment_reference && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('ocr_reference_label')}</span>
                <span className="font-mono">{invoice.payment_reference}</span>
              </div>
            )}
            {invoice.reverse_charge && (
              <div className="mt-2">
                <Badge variant="warning">{t('reverse_charge_badge')}</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('amounts_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('net_excl_vat')}</span>
              <span className="font-mono">{formatAmount(invoice.subtotal)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('vat_label')}</span>
              <span className="font-mono">{formatAmount(invoice.vat_amount)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between font-bold text-base pt-2 border-t">
              <span>{t('total_label')}</span>
              <span className="font-mono">{formatAmount(invoice.total)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between pt-2">
              <span className="text-muted-foreground">{t('paid_label')}</span>
              <span className="font-mono text-success">{formatAmount(invoice.paid_amount)} {invoice.currency}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{t('remaining_label')}</span>
              <span className="font-mono">{formatAmount(invoice.remaining_amount)} {invoice.currency}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Supplier info */}
      {invoice.supplier && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('supplier_section_title')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <Link href={`/suppliers/${invoice.supplier.id}`} className="text-primary hover:underline font-medium">
              {invoice.supplier.name}
            </Link>
            <div className="text-muted-foreground mt-1">
              {invoice.supplier.org_number && <span>{t('org_number_inline', { number: invoice.supplier.org_number })}</span>}
              {invoice.supplier.email}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Line items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('rows_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="pb-2">{t('col_description')}</th>
                  <th className="pb-2 w-16 text-right">{t('col_quantity')}</th>
                  <th className="pb-2 w-16">{t('col_unit')}</th>
                  <th className="pb-2 w-28 text-right">{t('col_unit_price')}</th>
                  <th className="pb-2 w-20">{t('col_account')}</th>
                  <th className="pb-2 w-16 text-right">{t('col_vat_rate')}</th>
                  <th className="pb-2 w-28 text-right">{t('col_amount')}</th>
                  <th className="pb-2 w-24 text-right">{t('col_vat')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2">{item.description}</td>
                    <td className="py-2 text-right">{item.quantity}</td>
                    <td className="py-2">{item.unit}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.unit_price)}</td>
                    <td className="py-2"><AccountNumber number={item.account_number} /></td>
                    <td className="py-2 text-right">{Math.round(item.vat_rate * 100)}%</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.line_total)}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(item.vat_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {items.map((item) => (
              <div key={item.id} className="border rounded-lg p-3 space-y-1.5">
                <div className="font-medium text-sm">{item.description}</div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{item.quantity} {item.unit} × {formatAmount(item.unit_price)}</span>
                  <span className="font-mono">{formatAmount(item.line_total)} kr</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span><AccountNumber number={item.account_number} /> · {t('vat_inline', { rate: Math.round(item.vat_rate * 100) })}</span>
                  <span className="font-mono">{t('vat_amount_inline', { amount: formatAmount(item.vat_amount) })}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment history */}
      {payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('payment_history_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="pb-2">{t('col_date')}</th>
                    <th className="pb-2 text-right">{t('col_amount_short')}</th>
                    <th className="pb-2">{t('col_voucher')}</th>
                    <th className="pb-2">{t('col_note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 tabular-nums">{formatDate(p.payment_date)}</td>
                      <td className="py-2 text-right font-mono">{formatAmount(p.amount)} {p.currency}</td>
                      <td className="py-2">
                        {p.journal_entry_id ? (
                          <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono text-xs">
                            {p.journal_entry_id.substring(0, 8)}...
                          </Link>
                        ) : '-'}
                      </td>
                      <td className="py-2 text-muted-foreground">{p.notes || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-3">
              {payments.map((p) => (
                <div key={p.id} className="border rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="tabular-nums">{formatDate(p.payment_date)}</span>
                    <span className="font-mono font-medium">{formatAmount(p.amount)} {p.currency}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {p.journal_entry_id ? (
                      <Link href={`/bookkeeping/${p.journal_entry_id}`} className="text-primary hover:underline font-mono">
                        {p.journal_entry_id.substring(0, 8)}...
                      </Link>
                    ) : <span>-</span>}
                    <span>{p.notes || ''}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Journal entries (sambandskrav) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('vouchers_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {invoice.registration_journal_entry_id ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('registration_voucher')}</span>
              <Link
                href={`/bookkeeping/${invoice.registration_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.registration_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          ) : (
            <p className="text-muted-foreground">{t('no_registration_voucher')}</p>
          )}
          {invoice.payment_journal_entry_id && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('payment_voucher')}</span>
              <Link
                href={`/bookkeeping/${invoice.payment_journal_entry_id}`}
                className="text-primary hover:underline font-mono"
              >
                {invoice.payment_journal_entry_id.substring(0, 8)}...
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {invoice.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('notes_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{invoice.notes}</p>
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Pay Dialog */}
      <Dialog open={isPayDialogOpen} onOpenChange={setIsPayDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pay_dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="payment-date">{t('payment_date_label')}</Label>
              <Input
                id="payment-date"
                type="date"
                value={paymentDate}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full sm:w-48"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-amount">{t('payment_amount_label')}</Label>
              <Input
                id="payment-amount"
                type="number"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('remaining_to_pay', { amount: formatAmount(invoice.remaining_amount), currency: invoice.currency })}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsPayDialogOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={() => handleMarkPaid(false)} disabled={isProcessing}>
                {isProcessing ? t('processing') : t('register_payment')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Duplicate-payment warning dialog */}
      <Dialog
        open={duplicateCandidates !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateCandidates(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('duplicate_payment_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {duplicateCandidates?.length === 1
                ? t('duplicate_payment_description_one')
                : t('duplicate_payment_description_many')}
            </p>
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              {duplicateCandidates?.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium tabular-nums">{formatDate(c.date)}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.merchant_name || c.description || t('bank_transaction_fallback')}
                    </div>
                  </div>
                  <div className="tabular-nums font-medium">
                    {formatAmount(Math.abs(c.amount))} {invoice.currency}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/transactions?highlight=${c.id}`)}
                  >
                    {t('go_to')}
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setDuplicateCandidates(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleMarkPaid(true)}
                disabled={isProcessing}
              >
                {isProcessing ? t('processing') : t('create_voucher_anyway')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
