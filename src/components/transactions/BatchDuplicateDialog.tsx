'use client'

import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2 } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

/** One flagged row, as the list needs to show it. */
export interface BatchDuplicateRow {
  transactionId: string
  /** The bank row's own date/description/amount, so the user recognises it. */
  date: string | null
  description: string | null
  amount: number | null
  currency: string | null
  candidate: BookedDuplicateCandidate
}

/**
 * The batch answer to the booking-time duplicate guard.
 *
 * DuplicateBookingDialog answers for one row and offers the three single-row
 * resolutions (match, ignore, book anyway). A batch cannot ask that question N
 * times: the page holds one modal slot, so N parallel rows clobbered it and
 * every loser was counted as an unexplained failure (#2488). This dialog asks
 * once, with every flagged row and the verifikat it matched in front of the
 * user, and offers the one resolution that is meaningful for a whole batch:
 * book all of them anyway. Resolving a single row differently (match it to the
 * voucher, ignore it as a duplicate import) stays a per-row decision on the
 * list, exactly as it is for the N-into-one BulkBookDialog.
 */
export default function BatchDuplicateDialog({
  rows,
  processing = false,
  onBookAll,
  onCancel,
}: {
  /** The flagged rows, or null to keep the dialog closed. */
  rows: BatchDuplicateRow[] | null
  processing?: boolean
  onBookAll: () => void
  onCancel: () => void
}) {
  const t = useTranslations('transactions')

  return (
    <Dialog
      open={rows !== null && rows.length > 0}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog_batch_duplicate_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('dialog_batch_duplicate_body', { count: rows?.length ?? 0 })}
          </p>
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dialog_batch_duplicate_col_date')}</TableHead>
                  <TableHead>{t('dialog_batch_duplicate_col_transaction')}</TableHead>
                  <TableHead className="text-right">
                    {t('dialog_batch_duplicate_col_amount')}
                  </TableHead>
                  <TableHead>{t('dialog_batch_duplicate_col_voucher')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(rows ?? []).map((row) => (
                  <TableRow key={row.transactionId}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {row.date ? formatDate(row.date) : ''}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate">{row.description}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.amount != null
                        ? formatCurrency(row.amount, row.currency ?? 'SEK')
                        : t('dialog_duplicate_amount_unknown')}
                    </TableCell>
                    <TableCell>
                      {/* Same target as the single-row dialog's "Visa
                          verifikatet": the evidence has to be one click away,
                          in a new tab so the open batch dialog survives it. */}
                      <a
                        className="underline underline-offset-2 hover:text-foreground"
                        href={`/bookkeeping/${row.candidate.journal_entry_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {row.candidate.voucher_label
                          ? t('dialog_duplicate_voucher_label', { label: row.candidate.voucher_label })
                          : t('dialog_duplicate_voucher_generic')}
                      </a>
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        {formatDate(row.candidate.entry_date)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={processing}>
            {t('dialog_duplicate_cancel')}
          </Button>
          <Button onClick={onBookAll} disabled={processing}>
            {processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('dialog_batch_duplicate_book_all')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
