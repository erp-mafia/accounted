'use client'

import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { Currency, JournalEntry, JournalEntryLine } from '@/types'

interface Props {
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after the draft is successfully updated. */
  onUpdated: () => void
}

/**
 * Edit a DRAFT verifikat. Wraps JournalEntryForm in edit mode, pre-filled from
 * the draft's header + lines; the form PATCHes the entry in place and it stays
 * a draft (the user posts it separately). Only ever opened for status==='draft'
 * entries: the engine + DB triggers reject edits on committed entries anyway.
 */
export default function EditDraftEntryDialog({ entry, open, onOpenChange, onUpdated }: Props) {
  const t = useTranslations('bookkeeping')

  const sortedLines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  // The PATCH replaces all lines wholesale, so EVERYTHING a line carries must
  // round-trip through the form: dimensions, per-line FX metadata (currency /
  // amount_in_currency / exchange_rate) and tax_code. Omitting any of them
  // meant a plain text edit silently reset a foreign-currency draft to SEK
  // and stripped its tax code (issue #1174).
  const initialLines: FormLine[] = sortedLines.map((l) => ({
    account_number: l.account_number,
    debit_amount: Number(l.debit_amount) > 0 ? String(l.debit_amount) : '',
    credit_amount: Number(l.credit_amount) > 0 ? String(l.credit_amount) : '',
    line_description: l.line_description || '',
    currency: l.currency && l.currency !== 'SEK' ? l.currency : undefined,
    amount_in_currency: l.amount_in_currency ?? undefined,
    exchange_rate: l.exchange_rate ?? undefined,
    tax_code: l.tax_code ?? undefined,
    dimensions:
      l.dimensions && Object.keys(l.dimensions).length > 0 ? { ...l.dimensions } : undefined,
  }))

  // Hydrate the form's currency picker + FX fields from the stored FX line so
  // a EUR draft is displayed as EUR instead of silently reading SEK.
  const fxLine = sortedLines.find((l) => l.currency && l.currency !== 'SEK')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // Same guard as Ny verifikat: an accidental outside-click must not
        // discard in-progress edits.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('edit_draft_dialog_title')}</DialogTitle>
        </DialogHeader>
        <JournalEntryForm
          key={entry.id}
          bare
          editEntryId={entry.id}
          initialLines={initialLines}
          initialDate={entry.entry_date}
          initialDescription={entry.description}
          initialNotes={entry.notes ?? undefined}
          initialVoucherSeries={entry.voucher_series}
          initialCurrency={fxLine ? (fxLine.currency as Currency) : undefined}
          initialExchangeRate={fxLine?.exchange_rate ?? undefined}
          initialForeignAmount={fxLine?.amount_in_currency ?? undefined}
          onUpdated={onUpdated}
        />
      </DialogContent>
    </Dialog>
  )
}
