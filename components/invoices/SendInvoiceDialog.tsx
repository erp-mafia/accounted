'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
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
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
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

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  const [entityType, setEntityType] = useState<EntityType>('enskild_firma')
  const [periodName, setPeriodName] = useState('')
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    if (!open) {
      setIsInitialized(false)
      return
    }

    let cancelled = false

    async function init() {
      try {
        if (!company?.id) throw new Error(t('no_active_company'))

        // Fetch company settings
        const { data: settings, error } = await supabase
          .from('company_settings')
          .select('accounting_method, entity_type')
          .eq('company_id', company.id)
          .maybeSingle()

        if (error) throw new Error(t('company_settings_failed'))
        if (cancelled) return

        // Fetch fiscal period for the invoice date
        const { data: period } = await supabase
          .from('fiscal_periods')
          .select('name')
          .eq('company_id', company.id)
          .lte('start_date', invoice.invoice_date)
          .gte('end_date', invoice.invoice_date)
          .maybeSingle()

        if (cancelled) return

        setAccountingMethod((settings?.accounting_method || 'accrual') as 'accrual' | 'cash')
        setEntityType((settings?.entity_type as EntityType) || 'enskild_firma')
        setPeriodName(period?.name || '')
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
    if (!isInitialized || accountingMethod !== 'accrual') return []

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
        items: invoice.items,
        default_dimensions: invoice.default_dimensions,
      },
      entityType,
    })
  }, [isInitialized, accountingMethod, entityType, invoice])

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
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('send_failed_fallback'))
      }

      onSuccess()

      if (mode === 'email') {
        onOpenChange(false)
        toast({
          title: t('send_success_title'),
          description: data.message || t('send_success_default', { email: invoice.customer.email ?? '' }),
        })
      } else {
        // For manual send, just close: no email to confirm
        onOpenChange(false)
        toast({
          title: t('mark_success_title'),
          description: accountingMethod === 'accrual'
            ? t('mark_success_voucher_created')
            : undefined,
        })
      }
    } catch (error) {
      toast({
        title: t('send_failed_title'),
        description: error instanceof Error ? error.message : t('try_again'),
        variant: 'destructive',
      })
    }

    setIsSubmitting(false)
  }

  const handleClose = () => {
    onOpenChange(false)
  }

  const showJournalPreview = accountingMethod === 'accrual' && proposedLines.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {mode === 'email' ? t('title_email') : t('title_manual')}{invoice.invoice_number ? t('title_suffix', { number: invoice.invoice_number }) : ''}
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
                  description={t('voucher_description', {
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
                {accountingMethod === 'cash'
                  ? t('explain_cash')
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
            {t('cancel')}
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
            {mode === 'email' ? t('send_invoice') : t('mark_as_sent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
