'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { getVatTreatmentLabel } from '@/lib/invoices/vat-rules'
import { invoiceNumberDisplay } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import {
  Loader2,
  ArrowLeft,
  Send,
  CheckCircle,
  FileText,
  Download,
  XCircle,
  Mail,
  ReceiptText,
  ExternalLink,
  Bell,
  AlertTriangle,
  MessageSquare,
  Trash2,
  Lock,
} from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import PaymentBookingDialog from '@/components/invoices/PaymentBookingDialog'
import SendInvoiceDialog from '@/components/invoices/SendInvoiceDialog'
import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Invoice, InvoiceItem, Customer, InvoiceStatus, InvoiceReminder, InvoiceDocumentType } from '@/types'

const statusVariantMap: Record<InvoiceStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  draft: 'secondary',
  sent: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  cancelled: 'secondary',
  credited: 'secondary',
}

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
  sent_at?: string
  // Optional reference to the issuance verifikation. Populated by the
  // backend when the invoice flow auto-books an entry on send; absent on
  // older invoices and on companies where issuance is not auto-booked.
  journal_entry_id?: string | null
}

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { canWrite } = useCanWrite()
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoice_detail')

  const [invoice, setInvoice] = useState<InvoiceWithRelations | null>(null)
  const [reminders, setReminders] = useState<InvoiceReminder[]>([])
  const [creditNote, setCreditNote] = useState<Invoice | null>(null)
  const [originalInvoice, setOriginalInvoice] = useState<Invoice | null>(null)
  const [convertedFromInvoice, setConvertedFromInvoice] = useState<Invoice | null>(null)
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)
  const [showSendDialog, setShowSendDialog] = useState(false)
  const [sendDialogMode, setSendDialogMode] = useState<'email' | 'manual'>('email')
  const [isConverting, setIsConverting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [oreRounding, setOreRounding] = useState<boolean>(true)

  const statusLabel = (status: InvoiceStatus): string => t(`status_${status}`)
  const reminderLevelLabel = (level: 1 | 2 | 3): string => t(`reminder_level_${level}`)

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

    // Sort items by sort_order
    if (data.items) {
      data.items.sort((a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order)
    }

    setInvoice(data as InvoiceWithRelations)

    // Fetch the öresavrundning setting so the detail view matches the PDF.
    if (data.company_id) {
      const { data: settings } = await supabase
        .from('company_settings')
        .select('ore_rounding')
        .eq('company_id', data.company_id)
        .maybeSingle()
      setOreRounding(settings?.ore_rounding ?? true)
    }

    // Fetch reminders for this invoice
    const { data: reminderData } = await supabase
      .from('invoice_reminders')
      .select('*')
      .eq('invoice_id', id)
      .order('sent_at', { ascending: false })

    if (reminderData) {
      setReminders(reminderData as InvoiceReminder[])
    }

    // If this invoice is credited, find the credit note
    if (data.status === 'credited') {
      const { data: creditNoteData } = await supabase
        .from('invoices')
        .select('id, invoice_number')
        .eq('credited_invoice_id', id)
        .single()

      if (creditNoteData) {
        setCreditNote(creditNoteData as Invoice)
      }
    }

    // If this is a credit note, fetch the original invoice
    if (data.credited_invoice_id) {
      const { data: originalData } = await supabase
        .from('invoices')
        .select('id, invoice_number')
        .eq('id', data.credited_invoice_id)
        .single()

      if (originalData) {
        setOriginalInvoice(originalData as Invoice)
      }
    }

    // If this invoice was converted from a proforma, fetch it
    if (data.converted_from_id) {
      const { data: convertedData } = await supabase
        .from('invoices')
        .select('id, invoice_number')
        .eq('id', data.converted_from_id)
        .single()

      if (convertedData) {
        setConvertedFromInvoice(convertedData as Invoice)
      }
    }

    setIsLoading(false)
  }

  async function updateStatus(status: InvoiceStatus) {
    if (!invoice) return

    setIsUpdating(true)

    try {
      if (status === 'sent') {
        // Use mark-sent API for proper bookkeeping
        const response = await fetch(`/api/invoices/${invoice.id}/mark-sent`, {
          method: 'POST',
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || t('mark_sent_failed_fallback'))
        }
      } else if (status === 'cancelled') {
        // Only drafts and proformas can be cancelled directly — sent/overdue/paid
        // invoices have committed journal entries and require a credit note instead
        if (invoice.status !== 'draft') {
          const docType = ((invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice') as InvoiceDocumentType
          if (docType !== 'proforma') {
            throw new Error(t('cancel_posted_error'))
          }
        }
        const { error } = await supabase
          .from('invoices')
          .update({ status })
          .eq('id', invoice.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase
          .from('invoices')
          .update({ status })
          .eq('id', invoice.id)
        if (error) throw new Error(error.message)
      }

      toast({
        title: t('status_update_toast_title'),
        description: t('status_update_toast_description', { status: statusLabel(status).toLowerCase() }),
      })
      fetchInvoice()
    } catch (error) {
      toast({
        title: t('status_update_failed_title'),
        description: error instanceof Error ? error.message : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsUpdating(false)
  }

  function openSendDialog(mode: 'email' | 'manual') {
    setSendDialogMode(mode)
    setShowSendDialog(true)
  }

  async function convertToInvoice() {
    if (!invoice) return
    setIsConverting(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/convert`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('convert_failed_fallback'))
      }

      toast({
        title: t('converted_toast_title'),
        description: t('converted_toast_description', { number: data.data.invoice_number }),
      })

      router.push(`/invoices/${data.data.id}`)
    } catch (error) {
      toast({
        title: t('convert_failed_title'),
        description: error instanceof Error ? error.message : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsConverting(false)
  }

  async function downloadPDF() {
    if (!invoice) return

    setIsDownloading(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/pdf`)

      if (!response.ok) {
        throw new Error(t('pdf_generate_failed'))
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `faktura-${invoice.invoice_number ?? `utkast-${invoice.id.slice(0, 8)}`}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      toast({
        title: t('pdf_downloaded_title'),
        description: invoice.invoice_number
          ? t('pdf_downloaded_with_number', { number: invoice.invoice_number })
          : t('pdf_downloaded_draft'),
      })
    } catch (error) {
      toast({
        title: t('pdf_download_failed_title'),
        description: error instanceof Error ? error.message : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsDownloading(false)
  }

  async function deleteInvoice() {
    if (!invoice) return

    setIsDeleting(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || t('cancel_failed_fallback'))
      }

      toast({
        title: t('cancelled_toast_title'),
        description: invoice.invoice_number
          ? t('cancelled_with_number', { number: invoice.invoice_number })
          : t('cancelled_draft'),
      })

      router.push('/invoices')
    } catch (error) {
      toast({
        title: t('cancel_failed_title'),
        description: error instanceof Error ? error.message : t('fallback_try_again'),
        variant: 'destructive',
      })
    }

    setIsDeleting(false)
    setShowDeleteDialog(false)
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

  const statusVariant = statusVariantMap[invoice.status]
  const customer = invoice.customer
  const customerHasEmail = !!customer.email
  const docType = ((invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice') as InvoiceDocumentType
  const isProforma = docType === 'proforma'
  const isDeliveryNote = docType === 'delivery_note'
  const isRealInvoice = docType === 'invoice'
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.back()} aria-label={t('back')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className={cn('font-display text-2xl sm:text-3xl font-medium tracking-tight', !invoice.invoice_number && 'italic text-muted-foreground')}>{invoiceNumberDisplay(invoice.invoice_number)}</h1>
              {isProforma && (
                <Badge variant="secondary" className="bg-primary/10 text-primary">{t('badge_proforma')}</Badge>
              )}
              {isDeliveryNote && (
                <Badge variant="secondary" className="bg-success/10 text-success">{t('badge_delivery_note')}</Badge>
              )}
              <Badge variant={statusVariant as 'default' | 'secondary' | 'destructive'}>
                {statusLabel(invoice.status)}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {t('created_at', { date: formatDate(invoice.created_at) })}
              {invoice.sent_at && t('sent_at_suffix', { date: formatDate(invoice.sent_at) })}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {isProforma && invoice.status !== 'cancelled' && (
            <Button
              onClick={convertToInvoice}
              disabled={isConverting || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isConverting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : !canWrite ? (
                <Lock className="mr-2 h-4 w-4" />
              ) : (
                <FileText className="mr-2 h-4 w-4" />
              )}
              {t('convert_to_invoice')}
            </Button>
          )}
          {invoice.status === 'draft' && !isDeliveryNote && (
            customerHasEmail ? (
              <Button
                onClick={() => openSendDialog('email')}
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <Mail className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('send_via_email')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={() => openSendDialog('manual')}
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? <Send className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
                {t('mark_sent_manually')}
              </Button>
            )
          )}
          {isDeliveryNote && invoice.status === 'draft' && (
            <Button
              variant="secondary"
              onClick={() => updateStatus('sent')}
              disabled={isUpdating || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <Send className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('mark_as_sent')}
            </Button>
          )}
          {(invoice.status === 'sent' || invoice.status === 'overdue') && isRealInvoice && (
            <Button
              onClick={() => setShowPaymentDialog(true)}
              disabled={isUpdating || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <CheckCircle className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('mark_as_paid')}
            </Button>
          )}
          <Button variant="outline" onClick={downloadPDF} disabled={isDownloading}>
            {isDownloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {t('download_pdf')}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:auto-rows-min lg:items-start">
        {/* Customer info */}
        <Card className="lg:col-span-2 lg:row-start-1">
          <CardHeader>
            <CardTitle>{t('customer_card_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <p className="font-medium text-lg">{customer.name}</p>
              {customer.org_number && (
                <p className="text-muted-foreground">{t('org_number_label', { value: customer.org_number })}</p>
              )}
              {customer.vat_number && (
                <p className="text-muted-foreground">{t('vat_number_label', { value: customer.vat_number })}</p>
              )}
              <div className="flex flex-wrap gap-4 pt-2 text-sm text-muted-foreground">
                {customer.email && (
                  <span>{customer.email}</span>
                )}
                {customer.phone && (
                  <span>{customer.phone}</span>
                )}
              </div>
              {(customer.address_line1 || customer.city) && (
                <div className="text-sm text-muted-foreground pt-1">
                  {customer.address_line1 && <p>{customer.address_line1}</p>}
                  {customer.address_line2 && <p>{customer.address_line2}</p>}
                  <p>
                    {customer.postal_code} {customer.city}
                    {customer.country !== 'SE' && `, ${customer.country}`}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Invoice items */}
        <Card className="lg:col-span-2 lg:row-start-2">
          <CardHeader>
            <CardTitle>{t('items_card_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Header — desktop */}
              <div className="hidden sm:grid grid-cols-12 gap-4 text-sm font-medium text-muted-foreground border-b pb-2">
                <div className="col-span-5">{t('th_description')}</div>
                <div className="col-span-2 text-right">{t('th_quantity')}</div>
                <div className="col-span-1 text-center">{t('th_unit')}</div>
                <div className="col-span-2 text-right">{t('th_unit_price')}</div>
                <div className="col-span-2 text-right">{t('th_amount')}</div>
              </div>

              {/* Items — desktop */}
              <div className="hidden sm:block space-y-4">
                {invoice.items.map((item) => (
                  <div key={item.id} className="grid grid-cols-12 gap-4 text-sm">
                    <div className="col-span-5">{item.description}</div>
                    <div className="col-span-2 text-right">{item.quantity}</div>
                    <div className="col-span-1 text-center">{item.unit}</div>
                    <div className="col-span-2 text-right">
                      {formatCurrency(item.unit_price, invoice.currency)}
                    </div>
                    <div className="col-span-2 text-right font-medium">
                      {formatCurrency(item.line_total, invoice.currency)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Items — mobile cards */}
              <div className="sm:hidden space-y-2">
                {invoice.items.map((item) => (
                  <div key={item.id} className="border rounded-lg p-3 text-sm space-y-1.5">
                    <p className="font-medium">{item.description}</p>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>{item.quantity} {item.unit} × {formatCurrency(item.unit_price, invoice.currency)}</span>
                    </div>
                    <p className="text-right font-medium">
                      {formatCurrency(item.line_total, invoice.currency)}
                    </p>
                  </div>
                ))}
              </div>

              <Separator />

              {/* Totals */}
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('subtotal')}</span>
                  <span>{formatCurrency(invoice.subtotal, invoice.currency)}</span>
                </div>
                {(() => {
                  const vatByRate = new Map<number, number>()
                  for (const item of invoice.items) {
                    const rate = item.vat_rate ?? 0
                    const lineVat = Math.round(item.line_total * (rate / 100) * 100) / 100
                    vatByRate.set(rate, (vatByRate.get(rate) || 0) + lineVat)
                  }
                  const entries = Array.from(vatByRate.entries())
                    .filter(([, vat]) => vat > 0)
                    .sort(([a], [b]) => b - a)

                  if (entries.length === 0) {
                    return (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('vat_label')}</span>
                        <span>{formatCurrency(0, invoice.currency)}</span>
                      </div>
                    )
                  }

                  return entries.map(([rate, vat]) => (
                    <div key={rate} className="flex justify-between">
                      <span className="text-muted-foreground">{t('vat_at_rate', { rate })}</span>
                      <span>{formatCurrency(vat, invoice.currency)}</span>
                    </div>
                  ))
                })()}
                <Separator />
                {(() => {
                  const rounding = getDisplayTotal(invoice, { ore_rounding: oreRounding })
                  return (
                    <>
                      {rounding.applies && (
                        <div className="flex justify-between text-sm text-muted-foreground">
                          <span>{t('ore_rounding')}</span>
                          <span>{formatCurrency(rounding.roundingDelta, 'SEK')}</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold text-lg">
                        <span>{t('total')}</span>
                        <span>{formatCurrency(rounding.displayed, invoice.currency)}</span>
                      </div>
                    </>
                  )
                })()}
                {invoice.currency !== 'SEK' && invoice.total_sek && (
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>{t('in_sek', { rate: invoice.exchange_rate ?? 1 })}</span>
                    <span>{formatCurrency(invoice.total_sek)}</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        {(invoice.notes || invoice.reverse_charge_text) && (
            <Card className="lg:col-span-2 lg:row-start-3">
            <CardHeader>
              <CardTitle>{t('notes_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {invoice.reverse_charge_text && (
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-sm font-medium">{t('reverse_charge_label')}</p>
                  <p className="text-sm text-muted-foreground">{invoice.reverse_charge_text}</p>
                </div>
              )}
              {invoice.notes && <p className="text-sm">{invoice.notes}</p>}
            </CardContent>
          </Card>
          )}

        {/* Sidebar */}
        <div className="lg:col-start-3 lg:row-start-1 lg:row-span-3 space-y-6">
          {/* Invoice details */}
          <Card>
            <CardHeader>
              <CardTitle>{t('details_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('invoice_number_label')}</span>
                <span className={cn('font-medium', !invoice.invoice_number && 'italic text-muted-foreground')}>{invoiceNumberDisplay(invoice.invoice_number)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('invoice_date_label')}</span>
                <span>{formatDate(invoice.invoice_date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('due_date_label')}</span>
                <span>{formatDate(invoice.due_date)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('currency_label')}</span>
                <span>{invoice.currency}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('vat_treatment_label')}</span>
                <span className="text-right text-sm">
                  {getVatTreatmentLabel(invoice.vat_treatment)}
                </span>
              </div>
              {invoice.your_reference && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">{t('your_reference_label')}</span>
                  <div className="flex flex-wrap gap-1">
                    {invoice.your_reference.split(',').map((ref, i) => (
                      <Badge key={i} variant="secondary" className="text-xs font-normal">
                        {ref.trim()}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {invoice.our_reference && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">{t('our_reference_label')}</span>
                  <div className="flex flex-wrap gap-1">
                    {invoice.our_reference.split(',').map((ref, i) => (
                      <Badge key={i} variant="secondary" className="text-xs font-normal">
                        {ref.trim()}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {invoice.journal_entry_id && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground text-sm">{t('bookkeeping_label')}</span>
                    <div className="flex flex-col items-end gap-1.5">
                      <Link
                        href={`/bookkeeping/${invoice.journal_entry_id}`}
                        className="text-sm hover:underline tabular-nums"
                      >
                        {t('view_voucher')}
                      </Link>
                      {canWrite && (
                        <CorrectionAffordance
                          journalEntryId={invoice.journal_entry_id}
                          onCorrected={fetchInvoice}
                        >
                          {({ open, isLoading }) => (
                            <button
                              type="button"
                              onClick={open}
                              disabled={isLoading}
                              className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
                            >
                              {isLoading ? t('correction_loading') : t('correction_prompt')}
                            </button>
                          )}
                        </CorrectionAffordance>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Payment info */}
          {invoice.status === 'paid' && invoice.paid_at && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-success">
                  <CheckCircle className="h-5 w-5" />
                  {t('paid_card_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t('paid_received_at', { date: formatDate(invoice.paid_at) })}
                </p>
                {invoice.paid_amount && (
                  <p className="text-lg font-bold mt-2">
                    {formatCurrency(invoice.paid_amount, invoice.currency)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Reminders Card */}
          {(invoice.status === 'sent' || invoice.status === 'overdue' || reminders.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5" />
                  {t('reminders_card_title')}
                </CardTitle>
                {reminders.length === 0 && (
                  <CardDescription>
                    {t('reminders_description')}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent>
                {reminders.length > 0 ? (
                  <div className="space-y-3">
                    {reminders.map((reminder) => (
                      <div
                        key={reminder.id}
                        className="flex items-start justify-between p-3 bg-muted rounded-lg"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={reminder.reminder_level === 3 ? 'destructive' : reminder.reminder_level === 2 ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {t('reminder_level_label', { level: reminder.reminder_level })}
                            </Badge>
                            <span className="text-sm font-medium">
                              {reminderLevelLabel(reminder.reminder_level as 1 | 2 | 3)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t('reminder_sent_to', { date: formatDate(reminder.sent_at), email: reminder.email_to })}
                          </p>
                          {reminder.response_type && (
                            <div className="flex items-center gap-1 mt-1">
                              {reminder.response_type === 'marked_paid' ? (
                                <>
                                  <CheckCircle className="h-3 w-3 text-success" />
                                  <span className="text-xs text-success">{t('reminder_marked_paid')}</span>
                                </>
                              ) : (
                                <>
                                  <MessageSquare className="h-3 w-3 text-orange-600" />
                                  <span className="text-xs text-orange-600">{t('reminder_objection')}</span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('reminders_empty')}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Credit note reference (if this invoice was credited) */}
          {invoice.status === 'credited' && creditNote && (
            <Card className="border-warning/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-warning">
                  <ReceiptText className="h-5 w-5" />
                  {t('credited_card_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('credited_description')}
                </p>
                <Link href={`/invoices/${creditNote.id}`}>
                  <Button variant="outline" size="sm" className="w-full">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('see_credit_note', { number: creditNote.invoice_number ?? '' })}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Original invoice reference (if this is a credit note) */}
          {invoice.credited_invoice_id && originalInvoice && (
            <Card className="border-primary/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ReceiptText className="h-5 w-5" />
                  {t('credit_note_card_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('credit_note_description')}
                </p>
                <Link href={`/invoices/${originalInvoice.id}`}>
                  <Button variant="outline" size="sm" className="w-full">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('see_original_invoice', { number: originalInvoice.invoice_number ?? '' })}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Converted from proforma */}
          {convertedFromInvoice && (
            <Card className="border-blue-300">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-blue-600">
                  <FileText className="h-5 w-5" />
                  {t('converted_card_title')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-2">
                  {t('converted_description')}
                </p>
                <Link href={`/invoices/${convertedFromInvoice.id}`}>
                  <Button variant="outline" size="sm" className="w-full">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('see_proforma', { number: convertedFromInvoice.invoice_number ?? '' })}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Status actions */}
          {invoice.status !== 'cancelled' && invoice.status !== 'credited' && !invoice.credited_invoice_id && (
            <Card>
              <CardHeader>
                <CardTitle>{t('actions_card_title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {isProforma && (
                  <>
                    <Button
                      className="w-full"
                      onClick={convertToInvoice}
                      disabled={isConverting}
                    >
                      {isConverting ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileText className="mr-2 h-4 w-4" />
                      )}
                      {t('convert_to_invoice')}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => updateStatus('cancelled')}
                      disabled={isUpdating}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      {t('cancel_action')}
                    </Button>
                  </>
                )}
                {!isProforma && invoice.status === 'draft' && (
                  <>
                    {!isDeliveryNote && customerHasEmail ? (
                      <>
                        <Button
                          className="w-full"
                          onClick={() => openSendDialog('email')}
                        >
                          <Mail className="mr-2 h-4 w-4" />
                          {t('send_via_email')}
                        </Button>
                        <Button
                          variant="ghost"
                          className="w-full text-muted-foreground"
                          onClick={() => openSendDialog('manual')}
                        >
                          <Send className="mr-2 h-4 w-4" />
                          {t('mark_sent_manually')}
                        </Button>
                        <p className="text-[11px] text-muted-foreground/60 px-1 -mt-1">
                          {t('send_manual_hint_with_email')}
                        </p>
                      </>
                    ) : (
                      <>
                        {!isDeliveryNote && (
                          <div className="flex items-start gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg mb-2 dark:bg-yellow-950/30 dark:border-yellow-800">
                            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 flex-shrink-0" />
                            <p className="text-xs text-yellow-700 dark:text-yellow-400">
                              {t('no_customer_email_warning')}
                            </p>
                          </div>
                        )}
                        <Button
                          className="w-full"
                          onClick={() => openSendDialog('manual')}
                        >
                          <Send className="mr-2 h-4 w-4" />
                          {t('mark_sent_manually')}
                        </Button>
                        <p className="text-[11px] text-muted-foreground/60 px-1 -mt-1">
                          {t('send_manual_hint_no_email')}
                        </p>
                      </>
                    )}
                    <Button
                      variant="outline"
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => setShowDeleteDialog(true)}
                      disabled={isDeleting}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('delete_draft')}
                    </Button>
                  </>
                )}
                {(invoice.status === 'sent' || invoice.status === 'overdue') && isRealInvoice && (
                  <>
                    <Button
                      className="w-full"
                      onClick={() => setShowPaymentDialog(true)}
                      disabled={isUpdating}
                    >
                      <CheckCircle className="mr-2 h-4 w-4" />
                      {t('mark_as_paid')}
                    </Button>
                    <Link href={`/invoices/${invoice.id}/credit`} className="block">
                      <Button variant="outline" className="w-full">
                        <ReceiptText className="mr-2 h-4 w-4" />
                        {t('create_credit_note')}
                      </Button>
                    </Link>
                  </>
                )}
                {invoice.status === 'paid' && isRealInvoice && (
                  <Link href={`/invoices/${invoice.id}/credit`} className="block">
                    <Button variant="outline" className="w-full">
                      <ReceiptText className="mr-2 h-4 w-4" />
                      {t('create_credit_note')}
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Cancel confirmation dialog. The invoice transitions to status='cancelled'
          and the F-series number is retained so the sequence stays gap-free. */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete_dialog_title')}</DialogTitle>
            <DialogDescription>
              {invoice.invoice_number ? (
                <>
                  {t('delete_dialog_desc_with_number_1')}
                  <strong>{t('delete_dialog_status_makulerad')}</strong>
                  {t('delete_dialog_desc_with_number_2')}
                  <span className="mt-2 block text-muted-foreground">
                    {t('delete_dialog_number_kept', { number: invoice.invoice_number })}
                  </span>
                </>
              ) : (
                <>
                  {t('delete_dialog_desc_no_number')}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} disabled={isDeleting}>
              {t('delete_dialog_cancel')}
            </Button>
            <Button variant="destructive" onClick={deleteInvoice} disabled={isDeleting}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('delete_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PaymentBookingDialog
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        invoice={invoice}
        onSuccess={() => {
          fetchInvoice()
          toast({
            title: t('paid_toast_title'),
            description: t('paid_toast_description', { number: invoice.invoice_number ?? '' }),
          })
        }}
      />
      {invoice && (
        <SendInvoiceDialog
          open={showSendDialog}
          onOpenChange={setShowSendDialog}
          invoice={invoice}
          mode={sendDialogMode}
          onSuccess={() => fetchInvoice()}
        />
      )}
    </div>
  )
}
