'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { use } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import CustomerForm from '@/components/customers/CustomerForm'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import {
  ArrowLeft,
  Building,
  Globe,
  User,
  Mail,
  Phone,
  MapPin,
  Edit2,
  Trash2,
  Loader2,
  Receipt,
  Lock,
} from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatDate } from '@/lib/utils'
import { invoiceNumberDisplay } from '@/lib/invoices/display'
import type { Customer, CustomerType, CreateCustomerInput } from '@/types'

const CUSTOMER_TYPE_KEY: Record<CustomerType, string> = {
  individual: 'type_individual',
  swedish_business: 'type_swedish_business',
  eu_business: 'type_eu_business',
  non_eu_business: 'type_non_eu_business',
}

const customerTypeIcons: Record<CustomerType, React.ElementType> = {
  individual: User,
  swedish_business: Building,
  eu_business: Globe,
  non_eu_business: Globe,
}

interface RelatedInvoice {
  id: string
  invoice_number: string | null
  invoice_date: string
  due_date: string
  status: string
  total: number
  currency: string
  payment_status: string
}

interface CustomerWithRelations extends Customer {
  invoices: RelatedInvoice[]
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('customer_detail')
  const [customer, setCustomer] = useState<CustomerWithRelations | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  useEffect(() => {
    fetchCustomer()
  }, [id])

  async function fetchCustomer() {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/customers/${id}`)
      if (!response.ok) {
        throw new Error('Not found')
      }
      const { data } = await response.json()
      setCustomer(data)
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      router.push('/customers')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleUpdate(data: CreateCustomerInput) {
    setIsUpdating(true)
    try {
      const response = await fetch(`/api/customers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error('Update failed')
      }

      toast({
        title: t('updated_title'),
        description: data.name,
      })
      setIsEditOpen(false)
      fetchCustomer()
    } catch {
      toast({
        title: t('update_failed_title'),
        description: t('retry'),
        variant: 'destructive',
      })
    } finally {
      setIsUpdating(false)
    }
  }

  async function handleDelete() {
    if (!customer) return
    const ok = await confirmAction({
      title: t('delete_confirm_title', { name: customer.name }),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return

    try {
      const response = await fetch(`/api/customers/${id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Delete failed')
      }

      toast({
        title: t('deleted_title'),
        description: customer.name,
      })
      router.push('/customers')
    } catch {
      toast({
        title: t('delete_failed_title'),
        description: t('retry'),
        variant: 'destructive',
      })
    }
  }

  const formatCurrency = (amount: number | null, currency: string | null) => {
    if (!amount) return '-'
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: currency || 'SEK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!customer) return null

  const Icon = customerTypeIcons[customer.customer_type]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/customers"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('back')}
          </Link>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-2xl md:text-3xl tracking-tight">{customer.name}</h1>
              <Badge variant="secondary">{t(CUSTOMER_TYPE_KEY[customer.customer_type])}</Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditOpen(true)}
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {canWrite ? <Edit2 className="h-4 w-4 mr-1" /> : <Lock className="h-4 w-4 mr-1" />}
            {t('edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            className="text-destructive hover:text-destructive"
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {canWrite ? <Trash2 className="h-4 w-4 mr-1" /> : <Lock className="h-4 w-4 mr-1" />}
            {t('delete')}
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Contact */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_contact')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {customer.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <a href={`mailto:${customer.email}`} className="hover:underline">
                  {customer.email}
                </a>
              </div>
            )}
            {customer.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {customer.phone}
              </div>
            )}
            {(customer.address_line1 || customer.city) && (
              <div className="flex items-start gap-2 text-sm">
                <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div>
                  {customer.address_line1 && <p>{customer.address_line1}</p>}
                  {customer.address_line2 && <p>{customer.address_line2}</p>}
                  {(customer.postal_code || customer.city) && (
                    <p>{[customer.postal_code, customer.city].filter(Boolean).join(' ')}</p>
                  )}
                  {customer.country && <p>{customer.country}</p>}
                </div>
              </div>
            )}
            {!customer.email && !customer.phone && !customer.address_line1 && !customer.city && (
              <p className="text-sm text-muted-foreground">{t('no_contact_info')}</p>
            )}
          </CardContent>
        </Card>

        {/* Business details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_business')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {customer.org_number && (
              <div className="text-sm">
                <span className="text-muted-foreground">{t('label_org_number')} </span>
                {customer.org_number}
              </div>
            )}
            {customer.vat_number && (
              <div className="text-sm flex items-center gap-2">
                <span className="text-muted-foreground">{t('label_vat')} </span>
                {customer.vat_number}
                {customer.vat_number_validated && (
                  <Badge variant="success" className="text-xs">{t('verified')}</Badge>
                )}
              </div>
            )}
            <div className="text-sm">
              <span className="text-muted-foreground">{t('label_payment_terms')} </span>
              {t('payment_terms_value', { days: customer.default_payment_terms || 30 })}
            </div>
            {!customer.org_number && !customer.vat_number && (
              <p className="text-sm text-muted-foreground">{t('no_business_info')}</p>
            )}
          </CardContent>
        </Card>

        {/* Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_summary')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Receipt className="h-4 w-4 text-muted-foreground" />
              <span>{t('invoice_count', { count: customer.invoices?.length || 0 })}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Notes */}
      {customer.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_notes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{customer.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Related invoices */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            {t('section_invoices')}
            {customer.invoices?.length > 0 && (
              <Badge variant="secondary">{customer.invoices.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {customer.invoices?.length > 0 ? (
            <div className="space-y-2">
              {customer.invoices.map((invoice) => (
                <Link
                  key={invoice.id}
                  href={`/invoices/${invoice.id}`}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <p className={cn('font-medium', !invoice.invoice_number && 'italic text-muted-foreground')}>{invoiceNumberDisplay(invoice.invoice_number)}</p>
                    <p className="text-sm text-muted-foreground tabular-nums">{formatDate(invoice.invoice_date)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums">
                      {formatCurrency(invoice.total, invoice.currency)}
                    </span>
                    <Badge variant={invoice.payment_status === 'paid' ? 'success' : 'secondary'}>
                      {invoice.payment_status === 'paid'
                        ? t('invoice_status_paid')
                        : invoice.payment_status === 'overdue'
                          ? t('invoice_status_overdue')
                          : t('invoice_status_unpaid')}
                    </Badge>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('no_invoices')}
            </p>
          )}
        </CardContent>
      </Card>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Edit dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('edit_dialog_title')}</DialogTitle>
          </DialogHeader>
          <CustomerForm
            onSubmit={handleUpdate}
            isLoading={isUpdating}
            initialData={{
              name: customer.name,
              customer_type: customer.customer_type,
              email: customer.email || undefined,
              phone: customer.phone || undefined,
              address_line1: customer.address_line1 || undefined,
              address_line2: customer.address_line2 || undefined,
              postal_code: customer.postal_code || undefined,
              city: customer.city || undefined,
              country: customer.country || undefined,
              org_number: customer.org_number || undefined,
              vat_number: customer.vat_number || undefined,
              default_payment_terms: customer.default_payment_terms || undefined,
              notes: customer.notes || undefined,
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
