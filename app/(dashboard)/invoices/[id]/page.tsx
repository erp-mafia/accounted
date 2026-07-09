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
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
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
  CalendarClock,
  Pencil,
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

// A line is periodiserad when both period dates are set: the revenue was
// parked on the 29xx interim account and dissolves monthly via accrual_schedules.
const itemHasAccrual = (item: InvoiceItem): boolean =>
  !!(item.accrual_period_start && item.accrual_period_end)

const accrualMonth = (date: string): string => date.slice(0, 7)

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
  // Payment history backing the new Betalningsstatus card. Fetched alongside
  // the invoice itself so the card stays in sync with paid_amount /
  // remaining_amount on the invoice row.
  const [payments, setPayments] = useState<
    Array<{
      id: string
      payment_date: string
      amount: number
      currency: string
      journal_entry_id: string | null
      voucher_series: string | null
      voucher_number: number | null
    }>
  >([])
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
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [nextNumberPreview, setNextNumberPreview] = useState<string | null>(null)
  const [oreRounding, setOreRounding] = useState<boolean>(true)
  const [vatRegistered, setVatRegistered] = useState<boolean>(true)

  const statusLabel = (status: InvoiceStatus): string => t(`status_${status}`)
  const reminderLevelLabel = (level: 1 | 2 | 3): string => t(`reminder_level_${level}`)

  useEffect(() => {
    fetchInvoice()
  }, [id])

  async function fetchInvoice() {
    setIsLoading(true)

    // Invoice, reminders, and payments all key on the route id — one
    // parallel batch. Only the follow-ups below need the invoice row.
    const [{ data, error }, { data: reminderData }, { data: paymentData }] =
      await Promise.all([
        supabase
          .from('invoices')
          .select(`
            *,
            customer:customers(*),
            items:invoice_items(*)
          `)
          .eq('id', id)
          .single(),
        supabase
          .from('invoice_reminders')
          .select('*')
          .eq('invoice_id', id)
          .order('sent_at', { ascending: false }),
        // Payment history for the Betalningsstatus card. Joins the
        // journal_entries row to get voucher_series + voucher_number so each
        // payment row can link to its verifikat. Manual payments (no tx, no
        // JE) still surface with the amount + date.
        supabase
          .from('invoice_payments')
          .select(
            'id, payment_date, amount, currency, journal_entry_id, journal_entries(voucher_series, voucher_number)',
          )
          .eq('invoice_id', id)
          .order('payment_date', { ascending: true }),
      ])

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

    if (reminderData) {
      setReminders(reminderData as InvoiceReminder[])
    }

    if (paymentData) {
      type PaymentRow = {
        id: string
        payment_date: string
        amount: number
        currency: string
        journal_entry_id: string | null
        journal_entries: { voucher_series: string | null; voucher_number: number | null } | null
      }
      setPayments(
        (paymentData as unknown as PaymentRow[]).map((p) => ({
          id: p.id,
          payment_date: p.payment_date,
          amount: p.amount,
          currency: p.currency,
          journal_entry_id: p.journal_entry_id,
          voucher_series: p.journal_entries?.voucher_series ?? null,
          voucher_number: p.journal_entries?.voucher_number ?? null,
        })),
      )
    }

    // Follow-ups that need the invoice row: company settings (öresavrundning
    // + VAT registration so the detail view matches the PDF — see
    // pdf-template.tsx:792 and :876), the credit note, the original invoice,
    // and the proforma source. Independent of each other → parallel.
    const [settingsRes, creditNoteRes, originalRes, convertedRes] =
      await Promise.all([
        data.company_id
          ? supabase
              .from('company_settings')
              .select('ore_rounding, vat_registered')
              .eq('company_id', data.company_id)
              .maybeSingle()
          : Promise.resolve(null),
        data.status === 'credited'
          ? supabase
              .from('invoices')
              .select('id, invoice_number')
              .eq('credited_invoice_id', id)
              .single()
          : Promise.resolve(null),
        data.credited_invoice_id
          ? supabase
              .from('invoices')
              .select('id, invoice_number')
              .eq('id', data.credited_invoice_id)
              .single()
          : Promise.resolve(null),
        data.converted_from_id
          ? supabase
              .from('invoices')
              .select('id, invoice_number')
              .eq('id', data.converted_from_id)
              .single()
          : Promise.resolve(null),
      ])

    if (settingsRes) {
      const settings = settingsRes.data
      setOreRounding(settings?.ore_rounding ?? true)
      if (typeof settings?.vat_registered === 'boolean') {
        setVatRegistered(settings.vat_registered)
      }
    }
    if (creditNoteRes?.data) {
      setCreditNote(creditNoteRes.data as Invoice)
    }
    if (originalRes?.data) {
      setOriginalInvoice(originalRes.data as Invoice)
    }
    if (convertedRes?.data) {
      setConvertedFromInvoice(convertedRes.data as Invoice)
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
        // Only drafts and proformas can be cancelled directly: sent/overdue/paid
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

  // Open the finalize dialog and peek the next F-number so the user can see
  // which number they'll get before committing. Read-only (peek_next_invoice_number);
  // the real number is allocated atomically on confirm and may differ by one if
  // another invoice is created in between.
  async function openFinalizeDialog() {
    setNextNumberPreview(null)
    setShowFinalizeDialog(true)
    try {
      const r = await fetch('/api/invoices/next-number?document_type=invoice')
      if (r.ok) {
        const json = await r.json()
        const preview = json?.data?.preview
        // Only show a value that looks like a real invoice number. Guards the
        // preview against an unexpected/oversized API response being rendered
        // verbatim, a short alphanumeric token (optional series prefix), never
        // free-form text.
        setNextNumberPreview(
          typeof preview === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(preview) ? preview : null
        )
      }
    } catch {
      // Best-effort preview; the dialog still works without it.
    }
  }

  // "Granska & skapa": finalize an unnumbered draft into a real invoice:
  // allocate the F-number and emit invoice.created. After this the invoice
  // behaves like any draft (send / makulera), no longer hard-deletable.
  async function finalizeInvoice() {
    if (!invoice) return

    setIsFinalizing(true)

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/finalize`, {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error?.message || t('fallback_try_again'))
      }

      toast({
        title: t('finalized_toast_title'),
        description: t('finalized_toast_description', { number: data.data?.invoice_number ?? '' }),
      })

      setShowFinalizeDialog(false)
      fetchInvoice()
    } catch (error) {
      toast({
        title: t('finalize_failed_title'),
        description: error instanceof Error ? error.message : t('fallback_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsFinalizing(false)
    }
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
        throw new Error(data.error?.message || t('cancel_failed_fallback'))
      }

      // Unnumbered drafts are hard deleted ("Ta bort"); numbered drafts are
      // makulerade and keep their number in the series.
      toast(
        invoice.invoice_number
          ? {
              title: t('cancelled_toast_title'),
              description: t('cancelled_with_number', { number: invoice.invoice_number }),
            }
          : {
              title: t('removed_toast_title'),
              description: t('removed_toast_description'),
            }
      )

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
  // An unnumbered draft is one saved via "Spara som utkast" that hasn't been
  // finalized: no F-number yet, so it can still be reviewed-and-created or
  // hard-deleted. Once finalized it gets a number and behaves like any draft.
  const isUnnumberedDraft = invoice.status === 'draft' && !invoice.invoice_number && isRealInvoice
  // A numbered draft is issued-but-unsent ("Ej skickad"), distinct from an
  // unnumbered draft ("Utkast"). Display-only: the DB status stays 'draft'.
  const isUnsentNumberedInvoice = invoice.status === 'draft' && !!invoice.invoice_number && isRealInvoice
  const displayStatusVariant = isUnsentNumberedInvoice ? 'outline' : statusVariant
  const displayStatusLabel = isUnsentNumberedInvoice ? t('status_unsent') : statusLabel(invoice.status)
  // Self-billing invoices we received: the document is the counterparty's, so
  // there is no own PDF to render and no send step: it arrives already booked.
  const isSelfBilled = !!invoice.is_self_billed
  // A draft (no committed verifikat, not sent, not self-billed) can be edited
  // in place (header + lines) via /invoices/{id}/edit. Sent/paid invoices are
  // immutable (BFL); they are corrected with a credit note instead.
  const isEditableDraft = isEditableInvoiceDraft(invoice)
  const hasAccruedItems = invoice.items.some(itemHasAccrual)
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
              <h1 className={cn('font-display text-2xl sm:text-3xl tracking-tight', !invoice.invoice_number && !isSelfBilled && 'italic text-muted-foreground')}>{isSelfBilled ? invoiceDisplayNumber(invoice as Invoice) : (invoice.invoice_number ?? '-')}</h1>
              {isProforma && (
                <Badge variant="outline">{t('badge_proforma')}</Badge>
              )}
              {isDeliveryNote && (
                <Badge variant="success">{t('badge_delivery_note')}</Badge>
              )}
              {isSelfBilled && (
                <Badge variant="outline">{t('badge_self_billed')}</Badge>
              )}
              <Badge variant={displayStatusVariant as 'default' | 'secondary' | 'destructive' | 'outline'}>
                {displayStatusLabel}
              </Badge>
              {hasAccruedItems && (
                <Badge variant="outline" className="gap-1">
                  <CalendarClock className="h-3 w-3" />
                  {t('badge_accrued')}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground">
              {t('created_at', { date: formatDate(invoice.created_at) })}
              {invoice.sent_at && t('sent_at_suffix', { date: formatDate(invoice.sent_at) })}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {isEditableDraft && canWrite && (
            <Link href={`/invoices/${invoice.id}/edit`}>
              <Button variant="outline">
                <Pencil className="mr-2 h-4 w-4" />
                {t('edit_draft')}
              </Button>
            </Link>
          )}
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
          {isUnnumberedDraft && (
            <Button
              onClick={openFinalizeDialog}
              disabled={isFinalizing || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {canWrite ? <FileText className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('finalize_action')}
            </Button>
          )}
          {invoice.status === 'draft' && !isDeliveryNote && invoice.invoice_number && (
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
          {/* No own PDF for a received self-billing invoice: the verifikationsunderlag is the document the customer sent us. */}
          {!isSelfBilled && (
            <Button variant="outline" onClick={downloadPDF} disabled={isDownloading}>
              {isDownloading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {t('download_pdf')}
            </Button>
          )}
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
              {customer.customer_type !== 'individual' && customer.org_number && (
                <p className="text-muted-foreground">{t('org_number_label', { value: customer.org_number })}</p>
              )}
              {customer.customer_type !== 'individual' && customer.vat_number && (
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
              {/* Header, desktop */}
              <div className="hidden sm:grid grid-cols-12 gap-4 text-sm font-medium text-muted-foreground border-b pb-2">
                <div className="col-span-5">{t('th_description')}</div>
                <div className="col-span-2 text-right">{t('th_quantity')}</div>
                <div className="col-span-1 text-center">{t('th_unit')}</div>
                <div className="col-span-2 text-right">{t('th_unit_price')}</div>
                <div className="col-span-2 text-right">{t('th_amount')}</div>
              </div>

              {/* Items, desktop. Free-text rows span the full width with no
                  numeric columns; a blank one renders as a spacer. */}
              <div className="hidden sm:block space-y-4">
                {invoice.items.map((item) =>
                  item.line_type === 'text' ? (
                    <div key={item.id} className="grid grid-cols-12 gap-4 text-sm">
                      <div className="col-span-12 text-muted-foreground">{item.description || ' '}</div>
                    </div>
                  ) : (
                    <div key={item.id} className="grid grid-cols-12 gap-4 text-sm">
                      <div className="col-span-5">
                        {item.description}
                        {itemHasAccrual(item) && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <CalendarClock className="h-3 w-3 shrink-0" />
                            <span className="tabular-nums">
                              {t('accrual_line_info', {
                                from: accrualMonth(item.accrual_period_start!),
                                to: accrualMonth(item.accrual_period_end!),
                              })}
                              {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
                            </span>
                          </p>
                        )}
                      </div>
                      <div className="col-span-2 text-right">{item.quantity}</div>
                      <div className="col-span-1 text-center">{item.unit}</div>
                      <div className="col-span-2 text-right">
                        {formatCurrency(item.unit_price, invoice.currency)}
                      </div>
                      <div className="col-span-2 text-right font-medium">
                        {formatCurrency(item.line_total, invoice.currency)}
                      </div>
                    </div>
                  )
                )}
              </div>

              {/* Items, mobile cards */}
              <div className="sm:hidden space-y-2">
                {invoice.items.map((item) =>
                  item.line_type === 'text' ? (
                    <p key={item.id} className="text-sm text-muted-foreground px-1">{item.description || ' '}</p>
                  ) : (
                    <div key={item.id} className="border rounded-lg p-3 text-sm space-y-1.5">
                      <p className="font-medium">{item.description}</p>
                      {itemHasAccrual(item) && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarClock className="h-3 w-3 shrink-0" />
                          <span className="tabular-nums">
                            {t('accrual_line_info', {
                              from: accrualMonth(item.accrual_period_start!),
                              to: accrualMonth(item.accrual_period_end!),
                            })}
                            {item.accrual_balance_account && ` · ${item.accrual_balance_account}`}
                          </span>
                        </p>
                      )}
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span>{item.quantity} {item.unit} × {formatCurrency(item.unit_price, invoice.currency)}</span>
                      </div>
                      <p className="text-right font-medium">
                        {formatCurrency(item.line_total, invoice.currency)}
                      </p>
                    </div>
                  )
                )}
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
                    if (vatRegistered === false && invoice.vat_amount === 0) {
                      return null
                    }
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
                <span className="text-muted-foreground">{isSelfBilled ? t('external_number_label') : t('invoice_number_label')}</span>
                <span className={cn('font-medium', !invoice.invoice_number && !isSelfBilled && 'italic text-muted-foreground')}>{isSelfBilled ? invoiceDisplayNumber(invoice as Invoice) : (invoice.invoice_number ?? '-')}</span>
              </div>
              {isSelfBilled && (invoice as Invoice).self_billing_agreement_ref && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('agreement_ref_label')}</span>
                  <span className="font-medium">{(invoice as Invoice).self_billing_agreement_ref}</span>
                </div>
              )}
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
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('your_reference_label')}</span>
                  <span className="text-right">
                    {invoice.your_reference.split(',').map((ref) => ref.trim()).join(', ')}
                  </span>
                </div>
              )}
              {invoice.our_reference && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('our_reference_label')}</span>
                  <span className="text-right">
                    {invoice.our_reference.split(',').map((ref) => ref.trim()).join(', ')}
                  </span>
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

          {/* Betalningsstatus card. Shows for both `paid` and `partially_paid`
              so the user always sees how much has been paid + what remains +
              the individual payment events. Previously only the `paid` case
              had a card, leaving partially-paid invoices without any visible
              paid_amount/remaining_amount: surfaced by user feedback after
              PR #614. */}
          {(invoice.status === 'paid' || invoice.status === 'partially_paid') && (
            <Card>
              <CardHeader>
                <CardTitle
                  className={cn(
                    'flex items-center gap-2',
                    invoice.status === 'paid' && 'text-success',
                    invoice.status === 'partially_paid' && 'text-warning-foreground',
                  )}
                >
                  {invoice.status === 'paid' ? (
                    <CheckCircle className="h-5 w-5" />
                  ) : (
                    <AlertTriangle className="h-5 w-5" />
                  )}
                  {invoice.status === 'paid'
                    ? t('paid_card_title')
                    : t('payment_status_card_title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Paid / remaining summary. Right-aligned tabular nums so
                    the two columns scan cleanly. Same SEK / invoice.currency
                    formatter as the items table. */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t('payment_status_paid_label')}
                    </p>
                    <p className="font-display text-xl tabular-nums mt-1">
                      {formatCurrency(invoice.paid_amount ?? 0, invoice.currency)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t('payment_status_remaining_label')}
                    </p>
                    <p
                      className={cn(
                        'font-display text-xl tabular-nums mt-1',
                        invoice.status === 'partially_paid' && 'text-warning-foreground',
                      )}
                    >
                      {formatCurrency(
                        invoice.remaining_amount ??
                          Math.max(0, invoice.total - (invoice.paid_amount ?? 0)),
                        invoice.currency,
                      )}
                    </p>
                  </div>
                </div>

                {invoice.status === 'paid' && invoice.paid_at && (
                  <p className="text-sm text-muted-foreground">
                    {t('paid_received_at', { date: formatDate(invoice.paid_at) })}
                  </p>
                )}

                {/* Payment history. Each row links to its verifikat when one
                    exists. Compact list: dates and amounts tabular-nums for
                    column alignment, the voucher link sits to the right with
                    a small chevron. */}
                <div className="space-y-2">
                  <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    {t('payment_status_payments_heading')}
                  </p>
                  {payments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('payment_status_empty')}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border -mx-2">
                      {payments.map((p) => {
                        const voucherLabel =
                          p.voucher_series && p.voucher_number != null
                            ? `${p.voucher_series}-${p.voucher_number}`
                            : null
                        return (
                          <li
                            key={p.id}
                            className="flex items-center justify-between gap-3 px-2 py-2 text-sm transition-colors hover:bg-secondary/60 rounded"
                          >
                            <span className="tabular-nums text-muted-foreground">
                              {formatDate(p.payment_date)}
                            </span>
                            <span className="font-medium tabular-nums flex-1 text-right">
                              {formatCurrency(p.amount, p.currency)}
                            </span>
                            {p.journal_entry_id && voucherLabel ? (
                              <Link
                                href={`/bookkeeping/${p.journal_entry_id}`}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                              >
                                {t('payment_status_view_voucher', { label: voucherLabel })}
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t('payment_status_view_voucher_unlinked')}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
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
                                  <MessageSquare className="h-3 w-3 text-destructive" />
                                  <span className="text-xs text-destructive">{t('reminder_objection')}</span>
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
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
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
              {/* Secondary actions only. The primary next-step for every status
                  (convert / finalize / send / mark-paid) lives in the header
                  action row next to the status badge: this card holds the
                  reversible/destructive alternatives so there is one obvious
                  next step, not two competing copies of it. */}
              <CardContent className="space-y-2">
                {isProforma && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => updateStatus('cancelled')}
                    disabled={isUpdating}
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    {t('cancel_action')}
                  </Button>
                )}
                {!isProforma && invoice.status === 'draft' && (
                  isUnnumberedDraft ? (
                    <Button
                      variant="outline"
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => setShowDeleteDialog(true)}
                      disabled={isDeleting}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('remove_action')}
                    </Button>
                  ) : (
                    <>
                      {/* When the customer has an email the header offers "Send via
                          email" as the primary; keep the manual-mark-sent path here
                          as the secondary alternative (it is not in the header). */}
                      {!isDeliveryNote && customerHasEmail && (
                        <>
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
                  )
                )}
                {((invoice.status === 'sent' || invoice.status === 'overdue' || invoice.status === 'paid') && isRealInvoice) && (
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

      {/* Remove/cancel confirmation. A numbered draft is makulerad (status flips
          to 'cancelled', number retained for a gap-free series); an unnumbered
          draft is hard deleted since it never entered the number series. */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{invoice.invoice_number ? t('delete_dialog_title') : t('remove_dialog_title')}</DialogTitle>
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
                  {t('remove_dialog_desc')}
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
              {invoice.invoice_number ? t('delete_dialog_confirm') : t('remove_dialog_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Finalize confirmation, "Granska & skapa". Allocates the F-number and
          turns the unnumbered draft into a real, issued invoice. */}
      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('finalize_dialog_title')}</DialogTitle>
            <DialogDescription>{t('finalize_dialog_desc')}</DialogDescription>
          </DialogHeader>
          {nextNumberPreview && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-4 py-3">
              <span className="text-sm text-muted-foreground">{t('finalize_dialog_number_label')}</span>
              <span className="text-base font-medium tabular-nums">{nextNumberPreview}</span>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFinalizeDialog(false)} disabled={isFinalizing}>
              {t('finalize_dialog_cancel')}
            </Button>
            <Button onClick={finalizeInvoice} disabled={isFinalizing}>
              {isFinalizing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('finalize_dialog_confirm')}
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
