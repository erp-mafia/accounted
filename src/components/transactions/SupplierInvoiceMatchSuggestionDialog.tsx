'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { BankHeldPaymentNotes, useBankHeldPaymentWarnings } from '@/components/payments/BankHeldPaymentNotes'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'

/** An open supplier invoice the categorize route named (TX_CATEGORIZE_SUGGEST_SI_MATCH details.candidates). */
export interface SupplierInvoiceMatchCandidate {
  supplier_invoice_id: string
  invoice_number: string | null
  invoice_date: string
  remaining_amount: number
  currency: string
  supplier_name: string | null
}

/**
 * A plain booking on 2440 that an open supplier invoice of the same amount
 * from the same supplier explains: match the invoice instead
 * (POST /api/transactions/[id]/match-supplier-invoice, booked here), or book
 * anyway. A payment the bank holds for a candidate (Betala via banken) is
 * said before "Matcha", which waits for the answer: the row may be that
 * payment, or another debit while a signed one still goes out on its date.
 * Loaded with next/dynamic when the suggestion opens, as the page's other
 * dialogs are.
 */
export default function SupplierInvoiceMatchSuggestionDialog({
  transactionId,
  candidates,
  onMatched,
  onCancel,
  onBookAnyway,
}: {
  transactionId: string
  candidates: readonly SupplierInvoiceMatchCandidate[]
  /** The match is booked: the page lets the row go. */
  onMatched: (supplierInvoiceId: string, journalEntryId: string | null) => void
  onCancel: () => void
  onBookAnyway: () => void
}) {
  const t = useTranslations('transactions')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const [processing, setProcessing] = useState(false)
  const bankPayments = useBankHeldPaymentWarnings(
    candidates.map((c) => c.supplier_invoice_id),
    'bank_row',
  )

  async function match(supplierInvoiceId: string) {
    setProcessing(true)
    try {
      const response = await fetch(`/api/transactions/${transactionId}/match-supplier-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_invoice_id: supplierInvoiceId }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('match_failed_title'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('supplier_invoice_matched_title'), description: t('supplier_invoice_matched_description') })
      onMatched(supplierInvoiceId, (result as { journal_entry_id?: string | null }).journal_entry_id ?? null)
    } catch {
      toast({ title: t('match_failed_title'), description: t('match_failed_description_retry'), variant: 'destructive' })
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog_pick_supplier_invoice')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('si_match_suggestion_body')}</p>
          <BankHeldPaymentNotes warnings={bankPayments.warnings} failed={bankPayments.failed} />
          <div className="space-y-2 rounded-lg p-3 bg-control shadow-raised">
            {candidates.map((c) => (
              <div key={c.supplier_invoice_id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {c.supplier_name || t('si_match_suggestion_supplier')}
                    {c.invoice_number ? ` · ${c.invoice_number}` : null}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {formatDate(c.invoice_date)} ·{' '}
                    {t('si_match_suggestion_remaining', { amount: formatCurrency(c.remaining_amount, c.currency) })}
                  </div>
                </div>
                <Button onClick={() => void match(c.supplier_invoice_id)} disabled={processing || bankPayments.pending}>
                  {t('si_match_suggestion_match')}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
            <Button variant="outline" onClick={onBookAnyway} disabled={processing}>
              {t('si_match_suggestion_book_anyway')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
