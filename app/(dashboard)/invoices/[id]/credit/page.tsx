'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getVatTreatmentLabel } from '@/lib/invoices/vat-rules'
import { Loader2, ArrowLeft, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import SendInvoiceDialog from '@/components/invoices/SendInvoiceDialog'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getCreditNoteSendMode } from '@/lib/invoices/credit-note-send-mode'
import { creditConfirmNumber } from '@/lib/invoices/display'
import type { Invoice, InvoiceItem, Customer } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
}

export default function CreateCreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { canWrite } = useCanWrite()
  const { isSandbox } = useCompany()
  const canEmail = useCapability(CAPABILITY.email_send)
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
  const [createdCreditNote, setCreatedCreditNote] = useState<InvoiceWithRelations | null>(null)
  const [showSendPrompt, setShowSendPrompt] = useState(false)

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
    setReason(t('reason_default', { number: creditConfirmNumber(data) ?? '' }))
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoice()
  }, [id])

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
        // Map the parsed body plus the status, never `new Error(data.error)`:
        // the route answers thrown errors with the canonical envelope
        // `{ error: { code, message } }`, and the Error constructor would
        // stringify that object to "[object Object]", discarding the route's
        // own Swedish reason.
        const body = await response.json().catch(() => null)
        toast({
          title: t('create_failed_title'),
          description: getUserErrorMessage(body, { statusCode: response.status }),
          variant: 'destructive',
        })
        setIsSubmitting(false)
        return
      }

      const { data: creditNote } = await response.json() as { data: InvoiceWithRelations }

      toast({
        title: t('created_toast_title'),
        description: creditNote.invoice_number
          ? t('created_toast_description', { number: creditNote.invoice_number })
          : undefined,
      })

      setCreatedCreditNote(creditNote)
      setShowSendPrompt(true)
    } catch (error) {
      toast({
        title: t('create_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('try_again'),
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
  const sendMode = getCreditNoteSendMode({
    customerHasEmail: !!createdCreditNote?.customer.email,
    isSandbox,
    canEmail,
  })

  function handleSendPromptOpenChange(open: boolean) {
    setShowSendPrompt(open)
    if (!open && createdCreditNote) {
      router.push(`/invoices/${createdCreditNote.id}`)
    }
  }

  // Self-billed invoices have invoice_number null by design; the confirm
  // number falls back to the counterparty's external number, the one the
  // user actually sees on the invoice (issue #1820).
  const confirmNumber = creditConfirmNumber(invoice)
  const confirmMismatch = Boolean(confirmText) && confirmText !== confirmNumber

  return (
    <div className="space-y-8 stagger-enter">
      {createdCreditNote && (
        <SendInvoiceDialog
          open={showSendPrompt}
          onOpenChange={handleSendPromptOpenChange}
          invoice={createdCreditNote}
          mode={sendMode}
          onSuccess={() => undefined}
        />
      )}

      {/* Back link on its own quiet row, same as the invoice document */}
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('back')}
      </button>

      {/* Header: serif title with the explanation behind "?", the credited
          invoice as the kicker, and the one attention sentence under it. */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
          <HelpPopover>{t('warning_description')}</HelpPopover>
        </div>
        {/* data-ph-mask: the kicker carries the invoice number */}
        <p data-ph-mask="" className="mt-1 text-sm text-muted-foreground">
          {t('subtitle', { number: confirmNumber ?? '' })}
        </p>
        <AttnLine className="mt-3">{t('warning_title')}</AttnLine>
      </div>

      {/* Original invoice: read-only context as plain rows */}
      <DetailSection kicker={t('original_card_title')}>
        <DefRow label={t('invoice_number_label')}>
          <span className="tabular-nums">{confirmNumber}</span>
        </DefRow>
        <DefRow label={t('date_label')}>
          <span className="tabular-nums">{formatDate(invoice.invoice_date)}</span>
        </DefRow>
        <DefRow label={t('customer_label')}>{customer.name}</DefRow>
        <DefRow label={t('vat_treatment_label')}>{getVatTreatmentLabel(invoice.vat_treatment)}</DefRow>
      </DetailSection>

      {/* Credit note preview: the invoice lines negated, as the list-page
          table idiom straight on the panel, totals as a right-aligned block. */}
      <DetailSection
        kicker={t('preview_card_title')}
        aside={
          // data-ph-mask: the credit note number derives from the invoice number
          <span data-ph-mask="" className="text-[11px] tabular-nums text-muted-foreground">
            {t('preview_card_description', { number: confirmNumber ?? '' })}
          </span>
        }
      >
        <table className="hidden w-full border-collapse text-[13px] sm:table">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_quantity')}</th>
              <th className={TH_CLASS}>{t('th_unit')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('th_unit_price')}</th>
              <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('th_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id}>
                <td className={cn(TD_CLASS, 'pl-0')}>{item.description}</td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums text-destructive')}>
                  -{Math.abs(item.quantity)}
                </td>
                <td className={cn(TD_CLASS, 'text-muted-foreground')}>{item.unit}</td>
                <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                  {formatCurrency(item.unit_price, invoice.currency)}
                </td>
                <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums text-destructive')}>
                  {formatCurrency(-Math.abs(item.line_total), invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile: one flat row per line, no numeric columns to cram. */}
        <div className="divide-y divide-border text-sm sm:hidden">
          {invoice.items.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p>{item.description}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  -{Math.abs(item.quantity)} {item.unit} × {formatCurrency(item.unit_price, invoice.currency)}
                </p>
              </div>
              <span className="shrink-0 tabular-nums text-destructive">
                {formatCurrency(-Math.abs(item.line_total), invoice.currency)}
              </span>
            </div>
          ))}
        </div>

        <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm tabular-nums">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{t('subtotal')}</span>
            <span className="text-destructive">
              {formatCurrency(-Math.abs(invoice.subtotal), invoice.currency)}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{t('vat_at_rate', { rate: invoice.vat_rate })}</span>
            <span className="text-destructive">
              {formatCurrency(-Math.abs(invoice.vat_amount), invoice.currency)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
            <span>{t('total')}</span>
            <span className="font-display text-xl text-destructive">
              {formatCurrency(-Math.abs(invoice.total), invoice.currency)}
            </span>
          </div>
          {invoice.currency !== 'SEK' && invoice.total_sek && (
            <div className="flex justify-between gap-4 text-muted-foreground">
              <span>{t('in_sek', { rate: invoice.exchange_rate ?? 1 })}</span>
              <span className="text-destructive">{formatCurrency(-Math.abs(invoice.total_sek))}</span>
            </div>
          )}
        </div>
      </DetailSection>

      {/* Reason: shown on the credit note (the note lives behind the "?") */}
      <DetailSection
        kicker={t('reason_card_title')}
        help={<HelpPopover>{t('reason_card_description')}</HelpPopover>}
      >
        <Label htmlFor="reason" className="sr-only">{t('reason_label')}</Label>
        <Textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reason_placeholder')}
          rows={3}
        />
      </DetailSection>

      {/* Confirmation: type the invoice number to arm the action */}
      <DetailSection kicker={t('confirm_card_title')}>
        <Label htmlFor="confirm-invoice-number" className="block text-sm font-normal leading-5 text-muted-foreground">
          {t('confirm_card_description_1')}
          {/* data-ph-mask: the invoice number is user data */}
          <span data-ph-mask="" className="font-mono font-semibold text-foreground">{confirmNumber}</span>
          {t('confirm_card_description_2')}
        </Label>
        <Input
          id="confirm-invoice-number"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={confirmNumber ?? ''}
          disabled={!confirmNumber}
          className={cn(
            // ph-no-capture: the placeholder carries the invoice number, and
            // replay masking covers input values, not attributes.
            'ph-no-capture mt-3 max-w-xs',
            confirmMismatch && 'border-destructive'
          )}
        />
      </DetailSection>

      {/* Actions: one footer row right after the confirm step, so the flow
          reads top to bottom and ends on the button it arms. */}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => router.back()}>
          {t('cancel')}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
            !confirmNumber ||
            confirmText !== confirmNumber ||
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
