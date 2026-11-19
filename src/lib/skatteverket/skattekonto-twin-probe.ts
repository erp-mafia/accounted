import type { SkattekontoLedgerCoverInfo, SkattekontoLedgerTwin } from '@/types/skatteverket'

/**
 * What the ledger already holds for one skattekonto row, read from the
 * match-candidates answer (GET .../transaktioner/:id/match-candidates): the
 * verifikat that carry the event on the skattekonto account (the booking
 * guard's LEDGER_TWIN_EXISTS search), or, when none does, the summarised
 * verifikat that hold it in aggregate (LEDGER_COVER_EXISTS). null when the
 * ledger holds neither, or the body is not that answer.
 *
 * The book dialog asks this when it opens and before "Skapa manuellt", so
 * both paths show the same answer the server would give on submit.
 */
export type SkattekontoTwinProbeAnswer =
  | { kind: 'twin'; twins: SkattekontoLedgerTwin[] }
  | { kind: 'cover'; cover: SkattekontoLedgerCoverInfo }
  | null

/** The twin fields of a match-candidates candidate (it carries more). */
function toLedgerTwin(c: SkattekontoLedgerTwin): SkattekontoLedgerTwin {
  return {
    journal_entry_id: c.journal_entry_id,
    voucher_series: c.voucher_series,
    voucher_number: c.voucher_number,
    entry_date: c.entry_date,
    description: c.description,
    status: c.status,
  }
}

export function readSkattekontoTwinProbe(body: unknown): SkattekontoTwinProbeAnswer {
  if (!body || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const { candidates, ledger_cover: cover } = data as { candidates?: unknown; ledger_cover?: unknown }
  if (Array.isArray(candidates) && candidates.length > 0) {
    return { kind: 'twin', twins: (candidates as SkattekontoLedgerTwin[]).map(toLedgerTwin) }
  }
  if (cover && typeof cover === 'object') {
    return { kind: 'cover', cover: cover as SkattekontoLedgerCoverInfo }
  }
  return null
}
