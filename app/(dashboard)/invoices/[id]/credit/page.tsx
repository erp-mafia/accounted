'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getVatTreatmentLabel } from '@/lib/invoices/vat-rules'
import { Loader2, ArrowLeft, AlertTriangle, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Invoice, InvoiceItem, Customer } from '@/types'

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
}

export default function CreateCreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { canWrite } = useCanWrite()
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoice_credit')

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => {
    fetchInvoice()
  }, [id])

  async function fetchInvoice() {
    setIsLoading(true)

    const { data, error } = await supabase
      .from('invoices')
      .select(`
        *,
        customer:customers(*),
        items:invoice_items(*)
      `)
      .eq('id', id)
      .single()

    if (error || !data) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      router.push('/invoices')
      return
    }

    // Check if invoice can be credited
    if (!['sent', 'paid', 'overdue'].includes(data.status)) {
      toast({
        title: t('cannot_credit_title'),
        description: t('cannot_credit_description'),
        variant: 'destructive',
      })
      router.push(`/invoices/${id}`)
      return
    }

    if (data.status === 'credited') {
      toast({
        title: t('already_credited_title'),
        description: t('already_credited_description'),
        variant: 'destructive',
      })
      router.push(`/invoices/${id}`)
      return
    }

    // Sort items by sort_order
    if (data.items) {
      data.items.sort((a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order)
    }

    setInvoice(data as InvoiceWithRelations)
    setReason(t('reason_default', { number: data.invoice_number ?? '' }))
    setIsLoading(false)
  }

  async function handleSubmit() {
    if (!invoice) return

    setIsSubmitting(true)

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credited_invoice_id: invoice.id,
          reason,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || t('create_failed_fallback'))
      }

      const { data: creditNote } = await response.json()

      toast({
        title: t('created_toast_title'),
        description: t('created_toast_description', { number: creditNote.invoice_number }),
      })

      router.push(`/invoices/${creditNote.id}`)
    } catch (error) {
      toast({
        title: t('create_failed_title'),
        description: error instanceof Error ? error.message : t('try_again'),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!invoice) {
    return null
  }

  const customer = invoice.customer

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label={t('back')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="font-display text-2xl md:text-3xl tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('subtitle', { number: invoice.invoice_number ?? '' })}
          </p>
        </div>
      </div>

      {/* Warning */}
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="flex items-start gap-4 pt-6">
          <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-destructive">{t('warning_title')}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('warning_description')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Original invoice info */}
      <Card>
        <CardHeader>
          <CardTitle>{t('original_card_title')}</CardTitle>
          <CardDescription>
            {t('original_card_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">{t('invoice_number_label')}</span>
              <span className="ml-2 font-medium">{invoice.invoice_number}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('date_label')}</span>
              <span className="ml-2">{formatDate(invoice.invoice_date)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('customer_label')}</span>
              <span className="ml-2">{customer.name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t('vat_treatment_label')}</span>
              <span className="ml-2">{getVatTreatmentLabel(invoice.vat_treatment)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Credit note preview */}
      <Card>
        <CardHeader>
          <CardTitle>{t('preview_card_title')}</CardTitle>
          <CardDescription>
            {t('preview_card_description', { number: invoice.invoice_number ?? '' })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Header */}
            <div className="grid grid-cols-12 gap-4 text-sm font-medium text-muted-foreground border-b pb-2">
              <div className="col-span-5">{t('th_description')}</div>
              <div className="col-span-2 text-right">{t('th_quantity')}</div>
              <div className="col-span-1 text-center">{t('th_unit')}</div>
              <div className="col-span-2 text-right">{t('th_unit_price')}</div>
              <div className="col-span-2 text-right">{t('th_amount')}</div>
            </div>

            {/* Items (negated) */}
            {invoice.items.map((item) => (
              <div key={item.id} className="grid grid-cols-12 gap-4 text-sm">
                <div className="col-span-5">{item.description}</div>
                <div className="col-span-2 text-right text-destructive">
                  -{Math.abs(item.quantity)}
                </div>
                <div className="col-span-1 text-center">{item.unit}</div>
                <div className="col-span-2 text-right">
                  {formatCurrency(item.unit_price, invoice.currency)}
                </div>
                <div className="col-span-2 text-right font-medium text-destructive">
                  {formatCurrency(-Math.abs(item.line_total), invoice.currency)}
                </div>
              </div>
            ))}

            <Separator />

            {/* Totals (negated) */}
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('subtotal')}</span>
                <span className="text-destructive">
                  {formatCurrency(-Math.abs(invoice.subtotal), invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('vat_at_rate', { rate: invoice.vat_rate })}</span>
                <span className="text-destructive">
                  {formatCurrency(-Math.abs(invoice.vat_amount), invoice.currency)}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between font-bold text-lg">
                <span>{t('total')}</span>
                <span className="text-destructive">
                  {formatCurrency(-Math.abs(invoice.total), invoice.currency)}
                </span>
              </div>
              {invoice.currency !== 'SEK' && invoice.total_sek && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>{t('in_sek', { rate: invoice.exchange_rate ?? 1 })}</span>
                  <span className="text-destructive">
                    {formatCurrency(-Math.abs(invoice.total_sek))}
                  </span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Reason */}
      <Card>
        <CardHeader>
          <CardTitle>{t('reason_card_title')}</CardTitle>
          <CardDescription>
            {t('reason_card_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="reason">{t('reason_label')}</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reason_placeholder')}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      {/* Confirmation */}
      <Card>
        <CardHeader>
          <CardTitle>{t('confirm_card_title')}</CardTitle>
          <CardDescription>
            {t('confirm_card_description_1')}
            <span className="font-mono font-semibold text-foreground">{invoice.invoice_number}</span>
            {t('confirm_card_description_2')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={invoice.invoice_number ?? ''}
            disabled={!invoice.invoice_number}
            className={cn(
              confirmText && confirmText !== invoice.invoice_number && 'border-destructive'
            )}
          />
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex justify-end gap-4">
        <Button variant="outline" onClick={() => router.back()}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
            !invoice.invoice_number ||
            confirmText !== invoice.invoice_number ||
            !canWrite
          }
          title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('creating')}
            </>
          ) : !canWrite ? (
            <>
              <Lock className="mr-2 h-4 w-4" />
              {t('create_credit_note')}
            </>
          ) : (
            t('create_credit_note')
          )}
        </Button>
      </div>
    </div>
  )
}
