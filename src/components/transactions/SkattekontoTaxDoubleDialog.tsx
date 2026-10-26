'use client'

import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { SkattekontoTaxDoubleCandidate } from '@/lib/transactions/skattekonto-tax-double'

/**
 * The booking guard's skattekonto candidate (issue #50): the bank line is
 * about to be booked straight to a tax account the skattekonto already
 * booked the same tax on this month. Not the same movement, so there is
 * nothing to match: the fix is booking the payment on the skattekonto
 * account instead, which the user does by cancelling and choosing it.
 * "Bokför ändå" re-issues the request with force bound to the candidate,
 * as for every other candidate (DuplicateBookingDialog).
 */
export default function SkattekontoTaxDoubleDialog({
  candidate,
  processing,
  onBookAnyway,
  onCancel,
}: {
  candidate: SkattekontoTaxDoubleCandidate
  processing: boolean
  onBookAnyway: () => void
  onCancel: () => void
}) {
  const t = useTranslations('transactions')
  const { tax_account: taxAccount, skattekonto_account: skattekontoAccount } = candidate.skattekonto

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{t('dialog_duplicate_title')}</DialogTitle>
            <HelpPopover className="shrink-0">
              {t('dialog_duplicate_help_skattekonto', { skattekontoAccount })}
            </HelpPopover>
          </div>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('dialog_duplicate_body_skattekonto', {
              amount: formatCurrency(candidate.amount ?? 0, 'SEK'),
              taxAccount,
            })}
          </p>
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">
                {candidate.voucher_label
                  ? t('dialog_duplicate_voucher_label', { label: candidate.voucher_label })
                  : t('dialog_duplicate_voucher_generic')}
              </span>
              <span className="tabular-nums">{formatCurrency(candidate.amount ?? 0, 'SEK')}</span>
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">{formatDate(candidate.entry_date)}</div>
            {candidate.description && (
              <div className="truncate text-xs text-muted-foreground">{candidate.description}</div>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground sm:mr-auto">
              <a href={`/bookkeeping/${candidate.journal_entry_id}`} target="_blank" rel="noopener noreferrer">
                {t('dialog_duplicate_view_voucher')}
              </a>
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onBookAnyway} disabled={processing}>
                {t('dialog_duplicate_book_anyway')}
              </Button>
              <Button onClick={onCancel} disabled={processing}>
                {t('dialog_duplicate_cancel')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
