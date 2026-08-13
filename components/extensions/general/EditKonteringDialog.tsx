'use client'

/**
 * Change everything about a proposed kontering, in one place.
 *
 * The rail used to offer three overlapping ways to alter a booking, none of
 * which said what it covered: an "Ändra" beside the date, an "Ändra kontering"
 * at the bottom, and a "Bokför som verifikat" entry in a menu that in practice
 * did what the primary button already did. This is the one control, and its
 * scope is the whole verifikat: date, series, description, every line.
 *
 * It is a dialog rather than an inline editor because a 340px rail cannot hold
 * an account picker, two money columns and a delete control per row without
 * something being clipped, and because the document has to stay readable while
 * the numbers are being changed. That is the same shape TransactionBookingDialog
 * already uses, for the same reason.
 *
 * The form is JournalEntryForm, unchanged. It already carries the series
 * picker, per-line descriptions, dimensions, currency, the balance check and
 * the confirm-before-post step, and it posts through the sanctioned route. The
 * alternative was extending BookDirectlyDialog, whose lines are seeded by three
 * effects that fight anything injected into them, and whose FormLine has no
 * room for line text, dimensions or tax codes.
 */
import { useTranslations } from 'next-intl'
import { formatCurrency, formatDate } from '@/lib/utils'
import JournalEntryForm from '@/components/bookkeeping/JournalEntryForm'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ProposedLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

export default function EditKonteringDialog({
  open,
  onOpenChange,
  itemId,
  documentId,
  documentMime,
  documentUrl,
  fileName,
  transactionId,
  entryDate,
  description,
  lines,
  matchedTransaction = null,
  onBooked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  documentId: string | null
  documentMime: string | null
  documentUrl: string | null
  fileName: string | null
  transactionId: string | null
  entryDate: string
  description: string
  lines: ProposedLine[]
  /** SEK amount and date of the matched bank row, when there is one. Shown
      beside the title so the kronor figure stays visible even if the user
      clears the rows: on a foreign-currency invoice this is the only place
      the SEK amount exists at all. */
  matchedTransaction?: { amount_sek: number; date: string } | null
  onBooked: (entryId: string) => void
}) {
  const t = useTranslations('inbox_workspace')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ändra kontering</DialogTitle>
          {matchedTransaction && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('dialog_matched_transaction')}: {formatCurrency(matchedTransaction.amount_sek)} ·{' '}
              {formatDate(matchedTransaction.date)}
            </p>
          )}
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
          <div className="min-w-0">
            <JournalEntryForm
              // Remount per item so a second underlag never inherits the
              // first one's draft: the form seeds its state from the initial
              // props once, by design.
              key={itemId}
              embedded
              // An unknown supplier has no proposal, and passing [] here is
              // not the same as passing nothing: the form seeds two blank rows
              // only when this is undefined, so an empty array opened the
              // dialog with no rows at all and a "lägg till rad" between the
              // user and typing anything.
              initialLines={
                lines.length > 0
                  ? lines.map((l) => ({
                      account_number: l.account_number,
                      debit_amount: l.debit_amount ? String(l.debit_amount) : '',
                      credit_amount: l.credit_amount ? String(l.credit_amount) : '',
                      line_description: l.description,
                    }))
                  : undefined
              }
              initialDate={entryDate}
              initialDescription={description}
              submitUrl={`/api/extensions/ext/invoice-inbox/items/${itemId}/book-direct`}
              sourceType={transactionId ? 'bank_transaction' : 'manual'}
              sourceId={transactionId ?? undefined}
              // source_id is metadata the schema strips. The route needs
              // transaction_id to book the underlag against its bank line;
              // without it the verifikat posts standalone, the transaction
              // stays unbooked and the match is cleared.
              extraBody={transactionId ? { transaction_id: transactionId } : undefined}
              onEntryCreated={onBooked}
            />
          </div>

          {/* The document stays readable while the numbers change: checking a
              VAT rate against the paper is the reason to open this at all. */}
          <aside className="min-w-0">
            {documentId ? (
              <DocumentViewerPane
                documentId={documentId}
                mime={documentMime}
                downloadUrl={documentUrl}
                fileName={fileName}
                className="h-[60vh]"
              />
            ) : (
              <div className="h-[60vh] grid place-items-center rounded-lg border text-xs text-muted-foreground">
                {t('dialog_no_document')}
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
