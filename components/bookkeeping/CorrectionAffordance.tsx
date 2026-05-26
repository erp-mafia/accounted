'use client'

/**
 * Lazy entry point for CorrectionEntryDialog when the user is not on the
 * /bookkeeping/[id] page (e.g. invoice detail, transaction row). Renders a
 * trigger (button or link slot) that, on click, fetches the journal entry
 * with its lines and opens the existing CorrectionEntryDialog.
 *
 * Used by:
 *   - /invoices/[id] when invoice.journal_entry_id is set
 *   - /transactions row menu when transaction.journal_entry_id is set
 *
 * Surfacing the storno+rättelse flow at the point where users notice the
 * mistake matters — the dialog itself was already correct (it pre-fills
 * lines and emits the storno+correction pair per BFL), but it was hidden
 * behind a deep-link the customer never reached.
 */
import { useState } from 'react'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry } from '@/types'

interface Props {
  journalEntryId: string
  onCorrected?: () => void
  /**
   * Render prop: receives the click handler and current loading state.
   * Letting the caller render its own trigger keeps the affordance visually
   * native to its host page (link on invoice detail, menu item in dropdown).
   */
  children: (args: { open: () => void; isLoading: boolean }) => React.ReactNode
}

export default function CorrectionAffordance({ journalEntryId, onCorrected, children }: Props) {
  const { toast } = useToast()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [open, setOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  async function handleOpen() {
    if (isLoading) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${journalEntryId}`)
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte hämta verifikationen',
          description: getErrorMessage(json, { context: 'journal_entry', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const fetched = json.data as JournalEntry
      if (fetched.status !== 'posted') {
        toast({
          title: 'Verifikationen kan inte ändras',
          description:
            'Endast bokförda verifikationer kan rättas. Utkast hanteras direkt under bokföringen.',
          variant: 'destructive',
        })
        return
      }
      setEntry(fetched)
      setOpen(true)
    } catch (err) {
      toast({
        title: 'Kunde inte hämta verifikationen',
        description: getErrorMessage(err, { context: 'journal_entry' }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <>
      {children({ open: handleOpen, isLoading })}
      {entry && (
        <CorrectionEntryDialog
          entry={entry}
          open={open}
          onOpenChange={setOpen}
          onCorrected={() => {
            setOpen(false)
            setEntry(null)
            onCorrected?.()
          }}
        />
      )}
    </>
  )
}
