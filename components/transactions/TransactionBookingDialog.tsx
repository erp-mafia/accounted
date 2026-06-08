'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, ChevronDown, ChevronUp, FileText, Inbox, Paperclip, X } from 'lucide-react'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { resolveSekAmount, buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import type { BookingTemplateLibrary } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

interface TransactionBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onBooked: (transactionId: string, journalEntryId: string) => void
  preselectedTemplate?: BookingTemplateLibrary | null
}

function buildInitialLines(transaction: TransactionWithInvoice, bankLineDescription: string): FormLine[] {
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
    account_number: '1930',
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
): FormLine[] {
  const sekAmount = Math.round(Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  )) * 100) / 100
  const lines = applyTemplate(template.lines, sekAmount)

  // Match buildInitialLines's foreign-currency handling: attach original
  // currency/amount/exchange_rate metadata to the settlement (bank/cash) legs
  // so the journal entry retains the foreign-currency annotation. Without
  // this the entry is silently recorded in SEK only.
  const isForeign = !!transaction.currency && transaction.currency !== 'SEK'
  if (!isForeign) return lines
  const currencyMeta = buildCurrencyMetadata(
    transaction.currency,
    Math.abs(transaction.amount),
    transaction.exchange_rate
  )
  return lines.map((line, i) => {
    const raw = template.lines[i]
    return raw?.type === 'settlement' ? { ...line, ...currencyMeta } : line
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
  const [showUploadZone, setShowUploadZone] = useState(false)
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  const handleBooked = async (transactionId: string, journalEntryId: string) => {
    // Link any attached documents to the new journal entry: freshly uploaded
    // files, and existing inbox documents picked via InboxDocumentPicker. For
    // picked docs, inbox_item_id stamps the inbox item as consumed so it drops
    // out of the active inbox — see app/api/documents/[id]/link/route.ts.
    const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
    let linkFailCount = 0
    for (const file of filesToLink) {
      try {
        const res = await fetch(`/api/documents/${file.id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ journal_entry_id: journalEntryId }),
        })
        if (!res.ok) linkFailCount++
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
          }),
        })
        if (!res.ok) linkFailCount++
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

    setUploadedFiles([])
    setPickedInboxDocs([])
    setShowUploadZone(false)
    onBooked(transactionId, journalEntryId)
  }

  const attachedCount =
    uploadedFiles.filter((f) => f.status === 'uploaded').length + pickedInboxDocs.length

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        setUploadedFiles([])
        setPickedInboxDocs([])
        setShowUploadZone(false)
        setInboxPickerOpen(false)
      }
      onOpenChange(o)
    }}>
      <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
              isIncome
                ? 'bg-success/10 text-success'
                : 'bg-destructive/10 text-destructive'
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

        {/* Document upload section */}
        <div className="rounded-lg border">
          <button
            type="button"
            onClick={() => setShowUploadZone(!showUploadZone)}
            className="flex items-center justify-between w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{t('doc_label')}</span>
              {attachedCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('doc_attached_count', { count: attachedCount })}
                </span>
              )}
            </div>
            {showUploadZone ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showUploadZone && (
            <div className="px-3 pb-3 space-y-2">
              <DocumentUploadZone
                files={uploadedFiles}
                onFilesChange={setUploadedFiles}
                compact
              />
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
                      {doc.amount != null && (
                        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                          {formatCurrency(doc.amount, doc.currency ?? 'SEK')}
                        </span>
                      )}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setInboxPickerOpen(true)}
              >
                <Inbox className="h-4 w-4 mr-2" />
                {t('doc_pick_existing')}
              </Button>
            </div>
          )}
        </div>

        <JournalEntryForm
          key={`${transaction.id}-${preselectedTemplate?.id ?? 'default'}`}
          embedded
          initialLines={
            preselectedTemplate
              ? buildInitialLinesFromTemplate(transaction, preselectedTemplate)
              : buildInitialLines(transaction, t('bank_line_description'))
          }
          initialDate={transaction.date}
          initialDescription={transaction.description}
          submitUrl={`/api/transactions/${transaction.id}/book`}
          sourceType="bank_transaction"
          sourceId={transaction.id}
          onEntryCreated={(entryId) => handleBooked(transaction.id, entryId)}
        />

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
