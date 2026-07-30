'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, Edit, Trash2, FileText, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import SupplierForm from '@/components/suppliers/SupplierForm'
import Link from 'next/link'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { Supplier, SupplierType, CreateSupplierInput, SupplierInvoice } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Supplier invoices carry their own currency; "kr" is only correct for SEK.
function amountWithCurrency(amount: number, currency?: string | null): string {
  return `${formatAmount(amount)} ${!currency || currency === 'SEK' ? 'kr' : currency}`
}

interface SupplierCurrencyStats {
  currency: string
  total_outstanding: number
  total_paid: number
}

interface SupplierStats {
  invoice_count: number
  by_currency: SupplierCurrencyStats[]
}

export default function SupplierDetailPage() {
  const { canWrite } = useCanWrite()
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('supplier_detail')
  const [supplier, setSupplier] = useState<Supplier & { stats?: SupplierStats } | null>(null)
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  const supplierTypeLabels = useMemo<Record<SupplierType, string>>(() => ({
    swedish_business: t('type_swedish'),
    eu_business: t('type_eu'),
    non_eu_business: t('type_non_eu'),
  }), [t])

  async function fetchSupplier() {
    setIsLoading(true)
    // try/finally: this runs from an effect, so a throw out of fetch/res.json()
    // (dropped connection, non-JSON error page) would be an unhandled rejection
    // and leave isLoading stuck true on a spinner that never resolves.
    try {
      const res = await fetch(`/api/suppliers/${params.id}`)
      const body = await res.json().catch(() => null)
      // `body.error` is the canonical envelope OBJECT, not a string: handing it
      // straight to the toast made the root <Toaster> render an object as a
      // React child, which throws past every segment error boundary and lands
      // the whole app on global-error. Route it through getErrorMessage, same
      // as every other call site in this file.
      if (!res.ok || body?.error) {
        toast({
          title: t('load_failed_title'),
          description: getErrorMessage(body, { statusCode: res.status, context: 'supplier' }),
          variant: 'destructive',
        })
      } else {
        setSupplier(body.data)
      }
    } catch (err) {
      toast({
        title: t('load_failed_title'),
        description: getErrorMessage(err, { context: 'supplier' }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function fetchInvoices() {
    const res = await fetch(
      `/api/supplier-invoices?status=all&supplier_id=${encodeURIComponent(String(params.id))}`,
    )
    const { data } = await res.json()
    if (data) {
      setInvoices(data as SupplierInvoice[])
    }
  }

  useEffect(() => {
    fetchSupplier()
    fetchInvoices()
  }, [params.id])

  async function handleUpdate(data: CreateSupplierInput) {
    setIsSaving(true)
    const res = await fetch(`/api/suppliers/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('update_failed_title'), description: getErrorMessage(result, { context: 'supplier' }), variant: 'destructive' })
    } else {
      toast({ title: t('saved_title'), description: t('saved_description') })
      setSupplier({ ...result.data, stats: supplier?.stats })
      setIsEditOpen(false)
    }
    setIsSaving(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: t('delete_confirm_title'),
      description: t('delete_confirm_description', { name: supplier?.name ?? '' }),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return

    const res = await fetch(`/api/suppliers/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: t('delete_failed_title'), description: getErrorMessage(result, { context: 'supplier' }), variant: 'destructive' })
    } else {
      toast({ title: t('deleted_title'), description: t('deleted_description') })
      router.push('/suppliers')
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!supplier) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('not_found')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/suppliers')}>
          {t('back')}
        </Button>
      </div>
    )
  }

  const statusVariants: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
    registered: 'secondary',
    approved: 'default',
    paid: 'success',
    partially_paid: 'warning',
    overdue: 'destructive',
    credited: 'secondary',
  }

  const statusLabels: Record<string, string> = {
    registered: t('status_registered'),
    approved: t('status_approved'),
    paid: t('status_paid'),
    partially_paid: t('status_partially_paid'),
    overdue: t('status_overdue'),
    credited: t('status_credited'),
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.push('/suppliers')} aria-label={t('back_aria')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display text-2xl leading-8 tracking-tight">{supplier.name}</h1>
            <p className="text-muted-foreground">
              {supplierTypeLabels[supplier.supplier_type]}
              {supplier.org_number && t('org_number_inline', { number: supplier.org_number })}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setIsEditOpen(true)}
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {canWrite ? <Edit className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
            {t('edit')}
          </Button>
          <Button
            variant="destructive"
            size="icon"
            onClick={handleDelete}
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            aria-label={t('delete_confirm_label')}
          >
            {canWrite ? <Trash2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t('outstanding')}</CardTitle>
          </CardHeader>
          <CardContent>
            {(supplier.stats?.by_currency?.length ? supplier.stats.by_currency : [{ currency: supplier.default_currency || 'SEK', total_outstanding: 0, total_paid: 0 }]).map((row) => (
              <p key={row.currency} className="font-display text-2xl tabular-nums">
                {amountWithCurrency(row.total_outstanding, row.currency)}
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t('total_paid')}</CardTitle>
          </CardHeader>
          <CardContent>
            {(supplier.stats?.by_currency?.length ? supplier.stats.by_currency : [{ currency: supplier.default_currency || 'SEK', total_outstanding: 0, total_paid: 0 }]).map((row) => (
              <p key={row.currency} className="font-display text-2xl tabular-nums">
                {amountWithCurrency(row.total_paid, row.currency)}
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t('invoice_count')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums">{supplier.stats?.invoice_count || 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Contact & Payment Info */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('contact_section_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {supplier.email && <p>{t('email_inline', { email: supplier.email })}</p>}
            {supplier.phone && <p>{t('phone_inline', { phone: supplier.phone })}</p>}
            {supplier.address_line1 && <p>{supplier.address_line1}</p>}
            {supplier.postal_code && <p>{supplier.postal_code} {supplier.city}</p>}
            {supplier.vat_number && <p>{t('vat_inline', { vat: supplier.vat_number })}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('payment_section_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {supplier.bankgiro && <p>{t('bankgiro_inline', { value: supplier.bankgiro })}</p>}
            {supplier.plusgiro && <p>{t('plusgiro_inline', { value: supplier.plusgiro })}</p>}
            {supplier.iban && <p>{t('iban_inline', { value: supplier.iban })}</p>}
            {supplier.bic && <p>{t('bic_inline', { value: supplier.bic })}</p>}
            <p>{t('payment_terms_inline', { days: supplier.default_payment_terms })}</p>
            <p>{t('currency_inline', { currency: supplier.default_currency })}</p>
            {supplier.default_expense_account && <p>{t('expense_account_inline', { account: supplier.default_expense_account })}</p>}
          </CardContent>
        </Card>
      </div>

      {/* Invoices */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t('invoices_section_title')}</CardTitle>
          <Link href="/supplier-invoices?new=1">
            <Button size="sm">
              <FileText className="mr-2 h-4 w-4" />
              {t('new_invoice')}
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              {t('no_invoices')}
            </p>
          ) : (
            <>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_arrival')}</TableHead>
                    <TableHead>{t('col_invoice_number')}</TableHead>
                    <TableHead>{t('col_date')}</TableHead>
                    <TableHead>{t('col_due')}</TableHead>
                    <TableHead className="text-right">{t('col_amount')}</TableHead>
                    <TableHead className="text-right">{t('col_remaining')}</TableHead>
                    <TableHead>{t('col_status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono tabular-nums">{inv.arrival_number}</TableCell>
                      <TableCell>
                        <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline">
                          {inv.supplier_invoice_number}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.invoice_date)}</TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.due_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{amountWithCurrency(inv.total, inv.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">{amountWithCurrency(inv.remaining_amount, inv.currency)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariants[inv.status] || 'secondary'}>
                          {statusLabels[inv.status] || inv.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-3">
              {invoices.map((inv) => (
                <div key={inv.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline font-medium text-sm">
                      {inv.supplier_invoice_number}
                    </Link>
                    <Badge variant={statusVariants[inv.status] || 'secondary'}>
                      {statusLabels[inv.status] || inv.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground tabular-nums">{formatDate(inv.invoice_date)} → {formatDate(inv.due_date)}</span>
                    <span className="font-mono">{amountWithCurrency(inv.total, inv.currency)}</span>
                  </div>
                  {Number(inv.remaining_amount) > 0 && Number(inv.remaining_amount) !== Number(inv.total) && (
                    <div className="text-xs text-muted-foreground text-right">
                      {t('remaining_inline', { amount: amountWithCurrency(inv.remaining_amount, inv.currency) })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('edit_dialog_title')}</DialogTitle>
          </DialogHeader>
          <SupplierForm
            onSubmit={handleUpdate}
            isLoading={isSaving}
            initialData={{
              name: supplier.name,
              supplier_type: supplier.supplier_type,
              email: supplier.email || '',
              phone: supplier.phone || '',
              address_line1: supplier.address_line1 || '',
              address_line2: supplier.address_line2 || '',
              postal_code: supplier.postal_code || '',
              city: supplier.city || '',
              country: supplier.country || 'SE',
              org_number: supplier.org_number || '',
              vat_number: supplier.vat_number || '',
              bankgiro: supplier.bankgiro || '',
              plusgiro: supplier.plusgiro || '',
              iban: supplier.iban || '',
              bic: supplier.bic || '',
              default_expense_account: supplier.default_expense_account || '',
              default_payment_terms: supplier.default_payment_terms,
              default_currency: supplier.default_currency || 'SEK',
              notes: supplier.notes || '',
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
