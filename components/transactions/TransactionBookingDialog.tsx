'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, ChevronDown, ChevronUp, Paperclip } from 'lucide-react'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { resolveSekAmount, buildCurrencyMetadata } from '@/lib/bookkeeping/currency-utils'
import type { TransactionWithInvoice } from './transaction-types'

interface TransactionBookingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onBooked: (transactionId: string, journalEntryId: string) => void
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

export default function TransactionBookingDialog({
  open,
  onOpenChange,
  transaction,
  onBooked,
}: TransactionBookingDialogProps) {
  const t = useTranslations('tx_booking_dialog')
  const { toast } = useToast()
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [showUploadZone, setShowUploadZone] = useState(false)

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  const handleBooked = async (transactionId: string, journalEntryId: string) => {
    // Link any uploaded documents to the new journal entry
    const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
    if (filesToLink.length > 0) {
      let linkFailCount = 0
      for (const file of filesToLink) {
        try {
          await fetch(`/api/documents/${file.id}/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ journal_entry_id: journalEntryId }),
          })
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
    }

    setUploadedFiles([])
    setShowUploadZone(false)
    onBooked(transactionId, journalEntryId)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        setUploadedFiles([])
        setShowUploadZone(false)
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
              {uploadedFiles.filter((f) => f.status === 'uploaded').length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('doc_attached_count', { count: uploadedFiles.filter((f) => f.status === 'uploaded').length })}
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
            <div className="px-3 pb-3">
              <DocumentUploadZone
                files={uploadedFiles}
                onFilesChange={setUploadedFiles}
                compact
              />
            </div>
          )}
        </div>

        <JournalEntryForm
          key={transaction.id}
          embedded
          initialLines={buildInitialLines(transaction, t('bank_line_description'))}
          initialDate={transaction.date}
          initialDescription={transaction.description}
          submitUrl={`/api/transactions/${transaction.id}/book`}
          sourceType="bank_transaction"
          sourceId={transaction.id}
          onEntryCreated={(entryId) => handleBooked(transaction.id, entryId)}
        />
      </DialogContent>
    </Dialog>
  )
}
