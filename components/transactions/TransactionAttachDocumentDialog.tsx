'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight, FileText, Inbox, Loader2, X } from 'lucide-react'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import InboxDocumentPicker from '@/components/bookkeeping/InboxDocumentPicker'
import type { AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import type { TransactionWithInvoice } from './transaction-types'

interface TransactionAttachDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onAttached: (transactionId: string, documentId: string) => void
}

/**
 * Standalone "Matcha mot underlag" dialog for the /transactions view: the
 * mirror of the Documents view's TransactionMatchPicker (doc → tx direction).
 * Pick an unconsumed inbox document or upload a new file, then pin it to the
 * transaction via POST /api/transactions/[id]/attach-document. The pin is
 * single-valued (transactions.document_id); for booked rows the route
 * propagates the link onto the verifikation immediately.
 */
export default function TransactionAttachDocumentDialog({
  open,
  onOpenChange,
  transaction,
  onAttached,
}: TransactionAttachDocumentDialogProps) {
  const t = useTranslations('tx_attach_dialog')
  const { toast } = useToast()
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [pickedDoc, setPickedDoc] = useState<AvailableInboxDoc | null>(null)
  const [inboxPickerOpen, setInboxPickerOpen] = useState(false)
  const [isAttaching, setIsAttaching] = useState(false)

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  // Single selection: transactions.document_id pins exactly one doc, so an
  // inbox pick replaces any upload and vice versa.
  const selectedDocumentId =
    pickedDoc?.document_id ??
    uploadedFiles.find((f) => f.status === 'uploaded' && f.id)?.id ??
    null

  const reset = () => {
    setUploadedFiles([])
    setPickedDoc(null)
    setInboxPickerOpen(false)
  }

  const handleAttach = async () => {
    if (!selectedDocumentId || isAttaching) return
    setIsAttaching(true)
    try {
      const res = await fetch(`/api/transactions/${transaction.id}/attach-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: selectedDocumentId }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: unknown }
        // The route returns Swedish domain messages (immutability, locked
        // period) as a plain string: surface them verbatim.
        toast({
          title: t('error_toast'),
          description: typeof json.error === 'string' ? json.error : undefined,
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('success_toast') })
      // Same event AgentChat and the booking dialog dispatch: flips the inbox
      // card's indicator optimistically without a refetch.
      window.dispatchEvent(
        new CustomEvent('Accounted:transaction-document-linked', {
          detail: { transaction_id: transaction.id, document_id: selectedDocumentId },
        }),
      )
      onAttached(transaction.id, selectedDocumentId)
      reset()
      onOpenChange(false)
    } catch {
      // Network-level failure: fetch rejected before a response existed.
      toast({ title: t('error_toast'), variant: 'destructive' })
    } finally {
      setIsAttaching(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {/* Transaction summary: same block as TransactionBookingDialog */}
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

        {transaction.document_id && (
          <p className="text-xs text-muted-foreground">{t('already_attached_hint')}</p>
        )}

        <div className="space-y-2">
          <DocumentUploadZone
            files={uploadedFiles}
            onFilesChange={(files) => {
              setUploadedFiles(files)
              if (files.length > 0) setPickedDoc(null)
            }}
            maxFiles={1}
            compact
            disabled={isAttaching}
          />
          {pickedDoc && (
            <div className="flex items-center gap-2 text-sm py-1.5 px-2 rounded bg-muted/50">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate flex-1">
                {pickedDoc.supplier_name ?? pickedDoc.file_name}
              </span>
              {pickedDoc.amount != null && (
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {formatCurrency(pickedDoc.amount, pickedDoc.currency ?? 'SEK')}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                aria-label={t('selected_remove')}
                onClick={() => setPickedDoc(null)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isAttaching}
            onClick={() => setInboxPickerOpen(true)}
          >
            <Inbox className="h-4 w-4 mr-2" />
            {t('pick_existing')}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={isAttaching} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={!selectedDocumentId || isAttaching} onClick={handleAttach}>
            {isAttaching ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('attaching')}
              </>
            ) : (
              t('confirm')
            )}
          </Button>
        </DialogFooter>

        <InboxDocumentPicker
          open={inboxPickerOpen}
          onClose={() => setInboxPickerOpen(false)}
          onSelect={(doc) => {
            setPickedDoc(doc)
            setUploadedFiles([])
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
