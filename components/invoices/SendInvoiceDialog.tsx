'use client'

import { useState, useEffect, useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { JournalEntryReviewContent } from '@/components/bookkeeping/JournalEntryReviewContent'
import { proposeSendLines } from '@/lib/bookkeeping/propose-send-lines'
import { formatCurrency } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { creditNoteNeedsJournalEntry } from '@/lib/invoices/issue-credit-note'
import { Loader2, Mail, Send } from 'lucide-react'
import type { Invoice, InvoiceItem, Customer, EntityType } from '@/types'

interface InvoiceWithRelations extends Invoice {
  customer: Customer
  items: InvoiceItem[]
}

interface SendInvoiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: InvoiceWithRelations
  /** 'email' sends via email, 'manual' marks as sent without email */
  mode: 'email' | 'manual'
  onSuccess: () => void
}

export default function SendInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  mode,
  onSuccess,
}: SendInvoiceDialogProps) {
  const { toast } = useToast()
  const supabase = createClient()
  const { company, isSandbox } = useCompany()
  const canEmail = useCapability(CAPABILITY.email_send)
  const t = useTranslations('invoice_send_dialog')
  const locale = useLocale() as 'sv' | 'en'
  const isCreditNote = !!invoice.credited_invoice_id
  const isCreditRepair = isCreditNote && invoice.status === 'sent'

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  const [entityType, setEntityType] = useState<EntityType>('enskild_firma')
  const [periodName, setPeriodName] = useState('')
  const [isInitialized, setIsInitialized] = useState(false)
  const [shouldBookOnIssue, setShouldBookOnIssue] = useState(true)

  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      return
    }

    let cancelled = false

    async function init() {
      try {
        if (!company?.id) throw new Error(t('no_active_company'))

        const [settingsResult, periodResult, originalResult] = await Promise.all([
          supabase
            .from('company_settings')
            .select('accounting_method, entity_type')
            .eq('company_id', company.id)
            .maybeSingle(),
          supabase
            .from('fiscal_periods')
            .select('name')
            .eq('company_id', company.id)
            .lte('start_date', invoice.invoice_date)
            .gte('end_date', invoice.invoice_date)
            .maybeSingle(),
          invoice.credited_invoice_id
            ? supabase
                .from('invoices')
                .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
                .eq('id', invoice.credited_invoice_id)
                .eq('company_id', company.id)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ])

        if (settingsResult.error) throw new Error(t('company_settings_failed'))
        if (periodResult.error) throw new Error(t('fiscal_period_failed'))
        if (originalResult.error) throw new Error(t('original_invoice_failed'))

        if (cancelled) return

        const method = (settingsResult.data?.accounting_method || 'accrual') as 'accrual' | 'cash'
        setAccountingMethod(method)
        setEntityType((settingsResult.data?.entity_type as EntityType) || 'enskild_firma')
        setPeriodName(periodResult.data?.name || '')
        setShouldBookOnIssue(
          invoice.credited_invoice_id && originalResult.data
            ? creditNoteNeedsJournalEntry(method, originalResult.data)
            : method === 'accrual',
        )
        setIsInitialized(true)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('load_failed_title'),
          description: err instanceof Error ? err.message : t('try_again'),
          variant: 'destructive',
        })
        onOpenChange(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [open, invoice.id, invoice.invoice_date, company?.id])

  const proposedLines = useMemo(() => {
    if (!isInitialized || !shouldBookOnIssue) return []

    return proposeSendLines({
      invoice: {
        invoice_number: invoice.invoice_number,
        total: invoice.total,
        total_sek: invoice.total_sek,
        subtotal: invoice.subtotal,
        subtotal_sek: invoice.subtotal_sek,
        vat_amount: invoice.vat_amount,
        vat_amount_sek: invoice.vat_amount_sek,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate,
        vat_treatment: invoice.vat_treatment,
        credited_invoice_id: invoice.credited_invoice_id,
        items: invoice.items,
        default_dimensions: invoice.default_dimensions,
      },
      entityType,
    })
  }, [isInitialized, shouldBookOnIssue, entityType, invoice])

  const { totalDebit, totalCredit } = useMemo(() => {
    let totalDebit = 0
    let totalCredit = 0
    for (const line of proposedLines) {
      totalDebit += parseFloat(line.debit_amount) || 0
      totalCredit += parseFloat(line.credit_amount) || 0
    }
    return { totalDebit, totalCredit }
  }, [proposedLines])

  const handleConfirm = async () => {
    setIsSubmitting(true)

    try {
      const url = mode === 'email'
        ? `/api/invoices/${invoice.id}/send`
        : `/api/invoices/${invoice.id}/mark-sent`

      const response = await fetch(url, { method: 'POST' })

      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'invoice', locale))
      }
      const data = await response.json()

      onSuccess()

      if (mode === 'email') {
        onOpenChange(false)
        const successMessage = data.message || t('send_success_default', { email: invoice.customer.email ?? '' })
        toast({
          title: t(
            shouldBookOnIssue && !data.partial
              ? isCreditNote
                ? 'credit_send_book_success_title'
                : 'send_book_success_title'
              : isCreditNote
                ? 'credit_send_success_title'
                : 'send_success_title',
          ),
          description: data.partial
            ? t('partial_success', { message: successMessage })
            : isCreditNote
              ? t('credit_send_success', { email: invoice.customer.email ?? '' })
              : successMessage,
        })
      } else {
        // For manual send, just close: no email to confirm
        onOpenChange(false)
        toast({
          title: t(
            isCreditRepair
              ? 'credit_repair_success_title'
              : shouldBookOnIssue && !data.partial
                ? isCreditNote
                  ? 'credit_mark_book_success_title'
                  : 'mark_book_success_title'
              : isCreditNote
                ? 'credit_mark_success_title'
                : 'mark_success_title',
          ),
          description: data.partial
            ? t('mark_partial_success')
            : isCreditNote
              ? shouldBookOnIssue
                ? t('credit_mark_success_voucher_created')
                : t('credit_mark_success_no_voucher')
              : accountingMethod === 'accrual'
                ? t('mark_success_voucher_created')
                : undefined,
        })
      }
    } catch (error) {
      toast({
        title: t(isCreditNote ? 'credit_send_failed_title' : 'send_failed_title'),
        description: error instanceof Error ? error.message : t('try_again'),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const showJournalPreview = shouldBookOnIssue && proposedLines.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {t(
              isCreditRepair
                ? 'title_credit_repair'
                : isCreditNote
                  ? mode === 'email'
                    ? 'title_credit_email'
                    : 'title_credit_manual'
                  : mode === 'email'
                    ? 'title_email'
                    : 'title_manual',
            )}
            {invoice.invoice_number ? t('title_suffix', { number: invoice.invoice_number }) : ''}
          </DialogTitle>
          <DialogDescription>
            {formatCurrency(invoice.total, invoice.currency)}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <>{t('description_sek_suffix', { amount: formatCurrency(invoice.total_sek) })}</>
            )}
            {mode === 'email' && invoice.customer.email && (
              <>{t('description_to_email', { email: invoice.customer.email })}</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!isInitialized ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {isSandbox && mode === 'email' && (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
                E-postutskick är avstängt i sandlådan. Använd istället
                &laquo;Markera som skickad&raquo; för att testa det resterande
                flödet.
              </div>
            )}
            {!isSandbox && !canEmail && mode === 'email' && (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
                E-postutskick kräver ett abonnemang.{' '}
                <a href="/settings/billing" className="underline underline-offset-2">
                  Uppgradera
                </a>{' '}
                eller använd &laquo;Markera som skickad&raquo;.
              </div>
            )}
            {showJournalPreview ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('journal_preview_intro')}
                </p>
                <JournalEntryReviewContent
                  periodName={periodName}
                  entryDate={invoice.invoice_date}
                  description={t(isCreditNote ? 'credit_voucher_description' : 'voucher_description', {
                    numberSpace: invoice.invoice_number ? ` ${invoice.invoice_number}` : '',
                    customerSuffix: invoice.customer.name ? `, ${invoice.customer.name}` : '',
                  })}
                  lines={proposedLines}
                  totalDebit={totalDebit}
                  totalCredit={totalCredit}
                  showBalanceBadge={true}
                  hideDate={!periodName}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {!shouldBookOnIssue
                  ? t(isCreditNote ? 'explain_credit_cash' : 'explain_cash')
                  : mode === 'email'
                    ? t('explain_email', { email: invoice.customer.email ?? '' })
                    : t('explain_manual')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
            className="w-full sm:w-auto min-h-11"
          >
            {t(isCreditNote ? 'later' : 'cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting || !isInitialized || (mode === 'email' && (isSandbox || !canEmail))}
            className="w-full sm:w-auto min-h-11"
            title={
              mode === 'email' && isSandbox
                ? 'E-postutskick är avstängt i sandlådan'
                : mode === 'email' && !canEmail
                  ? 'E-postutskick kräver ett abonnemang'
                  : undefined
            }
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : mode === 'email' ? (
              <Mail className="mr-2 h-4 w-4" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {t(
              isCreditRepair
                ? 'complete_credit_bookkeeping'
                : isCreditNote
                  ? mode === 'email'
                    ? shouldBookOnIssue
                      ? 'send_credit_note_and_book'
                      : 'send_credit_note'
                    : shouldBookOnIssue
                      ? 'mark_credit_note_sent_and_book'
                      : 'mark_credit_note_sent'
                  : mode === 'email'
                    ? shouldBookOnIssue
                      ? 'send_invoice_and_book'
                      : 'send_invoice'
                    : shouldBookOnIssue
                      ? 'mark_as_sent_and_book'
                      : 'mark_as_sent',
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
