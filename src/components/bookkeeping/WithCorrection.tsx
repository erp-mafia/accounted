'use client'

import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'

type CorrectionHandle = { open: () => void; isLoading: boolean }

/**
 * A menu's "Skapa ändringsverifikation" item needs the opener of
 * CorrectionAffordance, and the affordance (it owns the correction dialog)
 * must outlive the menu content, which unmounts on select: rendered inside
 * the menu, the fetch resolved into an unmounted component and the dialog
 * never opened. So it wraps the whole menu when there is a voucher to
 * correct, and is a pass-through otherwise (no hooks, so free on list rows).
 */
export function WithCorrection({
  journalEntryId,
  onCorrected,
  children,
}: {
  journalEntryId: string | null
  onCorrected?: () => void
  children: (correction: CorrectionHandle | null) => React.ReactNode
}) {
  if (!journalEntryId) return <>{children(null)}</>
  return (
    <CorrectionAffordance journalEntryId={journalEntryId} onCorrected={onCorrected}>
      {(correction) => children(correction)}
    </CorrectionAffordance>
  )
}
