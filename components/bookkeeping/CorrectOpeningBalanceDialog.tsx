'use client'

import { useMemo, useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import OpeningBalanceRowEditor, {
  type EditableRow,
  type OpeningBalanceEditorState,
} from '@/components/import/OpeningBalanceRowEditor'
import type { JournalEntry, JournalEntryLine } from '@/types'

interface Props {
  /** The currently-linked, posted opening-balance verifikat being corrected. */
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}

let seedIdCounter = 0

// Map the booked IB's lines into editable rows. account_name isn't stored on
// the line, so resolve it from BAS for display (cosmetic: only account_number
// + amounts are sent on save).
function seedRowsFromEntry(entry: JournalEntry): EditableRow[] {
  const lines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  return lines.map((l) => {
    const bas = BAS_REFERENCE.find((a) => a.account_number === l.account_number)
    return {
      id: l.id || `seed_${++seedIdCounter}`,
      account_number: l.account_number,
      account_name: bas?.account_name ?? '',
      debit_amount: Number(l.debit_amount) || 0,
      credit_amount: Number(l.credit_amount) || 0,
      validation_errors: [],
      bas_match: bas?.account_name ?? null,
    }
  })
}

/**
 * Inline correction of an already-booked opening-balance verifikat. The user
 * edits the IB's lines directly; on save we POST to
 * /api/import/opening-balance/correct, which (BFL-compliant) stornoes the old
 * IB, books a corrected one, and relinks the period to it. Works regardless of
 * how the IB was created (SIE import, CSV/Excel import, or year-end carry).
 */
export default function CorrectOpeningBalanceDialog({
  entry,
  open,
  onOpenChange,
  onCorrected,
}: Props) {
  const { toast } = useToast()
  const initialRows = useMemo(() => seedRowsFromEntry(entry), [entry])
  const [state, setState] = useState<OpeningBalanceEditorState | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = useCallback(async () => {
    if (!state?.canSubmit || isSubmitting) return

    setIsSubmitting(true)
    try {
      const lines = state.rows
        .filter((r) => r.debit_amount > 0 || r.credit_amount > 0)
        .map((r) => ({
          account_number: r.account_number,
          debit_amount: r.debit_amount,
          credit_amount: r.credit_amount,
        }))

      const res = await fetch('/api/import/opening-balance/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiscal_period_id: entry.fiscal_period_id, lines }),
      })

      const result = await res.json()

      if (!res.ok) {
        const err = new Error('Failed to correct opening balances') as Error & {
          body?: unknown
          status?: number
        }
        err.body = result
        err.status = res.status
        throw err
      }

      toast({
        title: 'Ingående balanser korrigerade',
        description: 'Den gamla IB-verifikationen stornades och en ny bokfördes.',
      })
      onOpenChange(false)
      onCorrected()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      toast({
        title: 'Kunde inte korrigera ingående balanser',
        description: getErrorMessage(anyErr.body ?? err, {
          context: 'journal_entry',
          statusCode: anyErr.status,
        }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [state, isSubmitting, entry.fiscal_period_id, toast, onOpenChange, onCorrected])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Korrigera ingående balanser</DialogTitle>
          <DialogDescription>
            Ändra beloppen nedan och spara. Den befintliga IB-verifikationen (
            {formatVoucher(entry)}) makuleras och en ny bokförs med de korrigerade beloppen.
          </DialogDescription>
        </DialogHeader>

        {/* Storno explanation: a booked verifikat can't be edited in place */}
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p className="text-sm text-warning">
            En bokförd verifikation kan inte ändras direkt (Bokföringslagen). När du sparar stornas
            den gamla IB-verifikationen och en ny bokförs: båda sparas som en spårbar rättelse.
          </p>
        </div>

        <OpeningBalanceRowEditor initialRows={initialRows} onChange={setState} />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!state?.canSubmit || isSubmitting}>
            {isSubmitting ? 'Sparar...' : 'Korrigera ingående balanser'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
