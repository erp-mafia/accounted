'use client'

import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import JournalEntryForm, { type FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { JournalEntry, JournalEntryLine } from '@/types'

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

  const initialLines: FormLine[] = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((l) => ({
      account_number: l.account_number,
      debit_amount: Number(l.debit_amount) > 0 ? String(l.debit_amount) : '',
      credit_amount: Number(l.credit_amount) > 0 ? String(l.credit_amount) : '',
      line_description: l.line_description || '',
      // Carry the line's dimensions into the form: the PATCH replaces all
      // lines, so omitting this would silently strip existing tags.
      dimensions:
        l.dimensions && Object.keys(l.dimensions).length > 0 ? { ...l.dimensions } : undefined,
    }))

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
          onUpdated={onUpdated}
        />
      </DialogContent>
    </Dialog>
  )
}
