'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, FileText, Inbox, X } from 'lucide-react'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { resolveSekAmount, buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import type { BookingTemplateLibrary, CashAccount } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'

interface TransactionBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onBooked: (
    transactionId: string,
    journalEntryId: string,
    attachedDocumentId?: string | null,
    /** True when the transaction was LINKED to an existing voucher via the
     *  duplicate guard's match action: no new verifikat was created. */
    matched?: boolean,
  ) => void
  preselectedTemplate?: BookingTemplateLibrary | null
}

function buildInitialLines(
  transaction: TransactionWithInvoice,
  bankLineDescription: string,
  bankAccount: string = '1930',
): FormLine[] {
  const sekAmount = Math.round(Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  )) * 100) / 100
  const amountStr = sekAmount.toFixed(2)
  const isExpense = transaction.amount < 0

  const isForeign = !!transaction.currency && transaction.currency !== 'SEK'
  const currencyMeta = isForeign
    ? buildCurrencyMetadata(
        transaction.currency,
        Math.abs(transaction.amount),
        transaction.exchange_rate
      )
    : {}

  const bankLine: FormLine = {
    account_number: bankAccount,
    debit_amount: isExpense ? '' : amountStr,
    credit_amount: isExpense ? amountStr : '',
    line_description: bankLineDescription,
    ...currencyMeta,
  }

  const counterLine: FormLine = {
    account_number: '',
    debit_amount: isExpense ? amountStr : '',
    credit_amount: isExpense ? '' : amountStr,
    line_description: '',
  }

  return isExpense ? [bankLine, counterLine] : [bankLine, counterLine]
}

function buildInitialLinesFromTemplate(
  transaction: TransactionWithInvoice,
  template: BookingTemplateLibrary,
  bankAccount: string = '1930',
): FormLine[] {
  const sekAmount = Math.round(Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  )) * 100) / 100
  const lines = applyTemplate(template.lines, sekAmount)

  const isForeign = !!transaction.currency && transaction.currency !== 'SEK'
  const currencyMeta = isForeign
    ? buildCurrencyMetadata(
        transaction.currency,
        Math.abs(transaction.amount),
        transaction.exchange_rate
      )
    : {}

  return lines.map((line, i) => {
    const raw = template.lines[i]
    if (raw?.type === 'settlement') {
      return { ...line, ...(isForeign ? currencyMeta : {}), account_number: bankAccount }
    }
    return line
  })
}

export default function TransactionBookingDialog({
  open,
  onOpenChange,
  transaction,
  onBooked,
  preselectedTemplate,
}: TransactionBookingDialogProps) {
  const t = useTranslations('tx_booking_dialog')
  const { toast } = useToast()
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [pickedInboxDocs, setPickedInboxDocs] = useState<AvailableInboxDoc[]>([])
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  const [bankAccount, setBankAccount] = useState<string | null>(null)
  const [bankAccountName, setBankAccountName] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !transaction) return
    setBankAccount(null)
    setBankAccountName(null)
    let cancelled = false
    fetch('/api/cash-accounts')
      .then((r) => {
        if (!r.ok) throw new Error(`cash-accounts fetch failed: ${r.status}`)
        return r.json()
      })
      .then((json) => {
        if (cancelled) return
        const accounts = (json.data ?? []) as CashAccount[]
        const { account } = resolveAccount(
          accounts,
          transaction.cash_account_id ?? null,
          transaction.currency ?? 'SEK',
        )
        // Use the matched account's own name instead of a generic label.
        const matched =
          accounts.find((a) => a.id === transaction.cash_account_id) ??
          accounts.find((a) => a.ledger_account === account)
        setBankAccount(account)
        setBankAccountName(matched?.name ?? null)
      })
      .catch(() => {
        if (!cancelled) setBankAccount('1930')
      })
    return () => { cancelled = true }
  }, [open, transaction?.id])

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  const handleBooked = async (transactionId: string, journalEntryId: string, matched = false) => {
    // Link any attached documents to the new journal entry: freshly uploaded
    // files, and existing inbox documents picked via InboxDocumentPicker. For
    // picked docs, inbox_item_id stamps the inbox item as consumed so it drops
    // out of the active inbox: see app/api/documents/[id]/link/route.ts.
    // transaction_id additionally pins the doc to the transaction row so the
    // /transactions list shows the underlag indicator (first linked doc wins).
    const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
    let linkFailCount = 0
    let firstLinkedDocId: string | null = null
    for (const file of filesToLink) {
      try {
        const res = await fetch(`/api/documents/${file.id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journal_entry_id: journalEntryId,
            transaction_id: transactionId,
          }),
        })
        if (!res.ok) linkFailCount++
        else firstLinkedDocId ??= file.id ?? null
      } catch {
        linkFailCount++
      }
    }
    for (const doc of pickedInboxDocs) {
      try {
        const res = await fetch(`/api/documents/${doc.document_id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journal_entry_id: journalEntryId,
            inbox_item_id: doc.inbox_item_id,
            transaction_id: transactionId,
          }),
        })
        if (!res.ok) linkFailCount++
        else firstLinkedDocId ??= doc.document_id
      } catch {
        linkFailCount++
      }
    }
    if (linkFailCount > 0) {
      toast({
        title: t('doc_link_failed_title'),
        description: t('doc_link_failed_description', { count: linkFailCount }),
        variant: 'destructive',
      })
    }

    // The server pins only when the tx has no document_id yet (first linked
    // doc wins): mirror that here so the optimistic state never claims a
    // pin the server refused to swap.
    const pinnedDocId = transaction.document_id ? null : firstLinkedDocId
    if (pinnedDocId) {
      // Same event AgentChat dispatches after uploads: flips the inbox card's
      // paperclip optimistically without a refetch.
      window.dispatchEvent(
        new CustomEvent('Accounted:transaction-document-linked', {
          detail: { transaction_id: transactionId, document_id: pinnedDocId },
        }),
      )
    }

    setUploadedFiles([])
    setPickedInboxDocs([])
    onBooked(transactionId, journalEntryId, pinnedDocId, matched)
  }

  // The receipt to show beside the form. A transaction may arrive with a
  // pre-linked document; otherwise the user attaches one in-dialog (upload or
  // inbox pick) and it appears here as soon as it's available.
  const uploadedDoc = uploadedFiles.find((f) => f.status === 'uploaded' && f.id)
  const pickedDoc = pickedInboxDocs[0]
  const preexistingDocId = transaction.document_id ?? null
  const inDialogDocId = uploadedDoc?.id ?? pickedDoc?.document_id ?? null
  const currentDocId = preexistingDocId ?? inDialogDocId
  const currentDocMime = preexistingDocId ? null : uploadedDoc?.file.type ?? null
  const currentDocName = preexistingDocId
    ? null
    : uploadedDoc?.fileName ?? pickedDoc?.file_name ?? null

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        setUploadedFiles([])
        setPickedInboxDocs([])
        setInboxPickerOpen(false)
      }
      onOpenChange(o)
    }}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
              isIncome
                ? 'text-success'
                : 'text-destructive'
            }`}
          >
            {isIncome ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{transaction.description}</p>
            <p className="text-xs text-muted-foreground">{formatDate(transaction.date)}</p>
          </div>
          <p className={`font-medium text-sm flex-shrink-0 ${isIncome ? 'text-success' : ''}`}>
            {isIncome ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
          {/* Document column: sticky on desktop so the receipt stays visible
              while the form scrolls; stacks above the form on smaller screens. */}
          <div className="flex h-[45vh] flex-col gap-3 lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">
            {currentDocId ? (
              <DocumentViewerPane
                documentId={currentDocId}
                mime={currentDocMime}
                fileName={currentDocName}
                className="min-h-0 flex-1"
              />
            ) : (
              <div className="min-h-0 flex-1">
                <DocumentUploadZone
                  files={uploadedFiles}
                  onFilesChange={setUploadedFiles}
                />
              </div>
            )}

            {/* Attach controls: only when the transaction has no pre-linked
                document (a pre-linked one is already the verifikat's underlag). */}
            {!preexistingDocId && (
              <div className="shrink-0 space-y-2">
                {pickedInboxDocs.length > 0 && (
                  <div className="space-y-1">
                    {pickedInboxDocs.map((doc) => (
                      <div
                        key={doc.document_id}
                        className="flex items-center gap-2 text-sm py-1.5 px-2 rounded bg-muted/50"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="truncate flex-1">
                          {doc.supplier_name ?? doc.file_name}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 shrink-0"
                          aria-label={t('doc_picked_remove')}
                          onClick={() =>
                            setPickedInboxDocs((prev) =>
                              prev.filter((d) => d.document_id !== doc.document_id),
                            )
                          }
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setInboxPickerOpen(true)}
                  >
                    <Inbox className="h-4 w-4 mr-2" />
                    {t('doc_pick_existing')}
                  </Button>
                  {inDialogDocId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setUploadedFiles([])
                        setPickedInboxDocs([])
                      }}
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" />
                      {t('doc_clear')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Booking form */}
          <div className="space-y-4">
            {bankAccount !== null && (
              <JournalEntryForm
                key={`${transaction.id}-${preselectedTemplate?.id ?? 'default'}-${bankAccount}`}
                embedded
                initialLines={
                  preselectedTemplate
                    ? buildInitialLinesFromTemplate(transaction, preselectedTemplate, bankAccount)
                    : buildInitialLines(transaction, bankAccountName ?? t('bank_line_description'), bankAccount)
                }
                initialDate={transaction.date}
                initialDescription={transaction.description}
                submitUrl={`/api/transactions/${transaction.id}/book`}
                sourceType="bank_transaction"
                sourceId={transaction.id}
                onEntryCreated={(entryId) => handleBooked(transaction.id, entryId)}
                duplicateMatchTransaction={{
                  id: transaction.id,
                  cash_account_id: transaction.cash_account_id ?? null,
                  currency: transaction.currency ?? 'SEK',
                }}
                // Duplicate guard match: the bank line was linked to an existing
                // voucher (no new entry). Reuse the booked flow so attached
                // documents land on that verifikat and the row leaves the list.
                onDuplicateMatched={(journalEntryId) => handleBooked(transaction.id, journalEntryId, true)}
              />
            )}
          </div>
        </div>

        <InboxDocumentPicker
          open={inboxPickerOpen}
          onClose={() => setInboxPickerOpen(false)}
          onSelect={(doc) =>
            setPickedInboxDocs((prev) =>
              prev.some((d) => d.document_id === doc.document_id) ? prev : [...prev, doc],
            )
          }
        />
      </DialogContent>
    </Dialog>
  )
}
