'use client'

import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

/**
 * Soft warning shown when the booking-time duplicate guard fires
 * (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): another already-booked transaction
 * shares this one's date + amount + bank account. Never a hard block:
 * genuinely repeated same-day payments (e.g. several identical Swish transfers)
 * are legitimate, so the user can review the existing verifikat or book anyway.
 *
 * Shared by the /transactions list (runCategorize) and the manual booking
 * dialog (JournalEntryForm → /api/transactions/[id]/book). The caller owns the
 * retry: "Bokför ändå" must re-issue the request with force=true bound to
 * `candidate.journal_entry_id` via `expected_duplicate_journal_entry_id`: it
 * is present on both candidate kinds (a sibling-transaction candidate and a
 * ledger-only voucher candidate, which has no transaction_id), and the server
 * re-detects it so a stale id can't wave the guard away.
 */
export default function DuplicateBookingDialog({
  candidate,
  processing = false,
  onBookAnyway,
  onCancel,
}: {
  /** The already-booked sibling, or null to keep the dialog closed. */
  candidate: BookedDuplicateCandidate | null
  processing?: boolean
  onBookAnyway: () => void
  onCancel: () => void
}) {
  const t = useTranslations('transactions')

  return (
    <Dialog
      open={candidate !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog_duplicate_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('dialog_duplicate_body')}</p>
          {candidate && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {candidate.voucher_label
                    ? t('dialog_duplicate_voucher_label', { label: candidate.voucher_label })
                    : t('dialog_duplicate_voucher_generic')}
                </span>
                <span className="tabular-nums">{formatCurrency(candidate.amount)}</span>
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatDate(candidate.entry_date)}
              </div>
              {candidate.description && (
                <div className="truncate text-xs text-muted-foreground">{candidate.description}</div>
              )}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {candidate && (
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground sm:mr-auto">
                <a
                  href={`/bookkeeping/${candidate.journal_entry_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('dialog_duplicate_view_voucher')}
                </a>
              </Button>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onCancel} disabled={processing}>
                {t('dialog_duplicate_cancel')}
              </Button>
              <Button onClick={onBookAnyway} disabled={processing}>
                {t('dialog_duplicate_book_anyway')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
