import { describe, expect, it } from 'vitest'
import { readSkattekontoTwinProbe } from '@/lib/skatteverket/skattekonto-twin-probe'
import type { SkattekontoLedgerCoverInfo } from '@/types/skatteverket'

// A match-candidates candidate carries more than the twin fields (score,
// AGI-period match, combined rows); the dialog keeps only the twin fields.
const CANDIDATE = {
  journal_entry_id: 'je-1',
  voucher_series: 'A',
  voucher_number: 217,
  entry_date: '2026-09-12',
  description: 'Inbetalning skattekonto',
  status: 'posted' as const,
  score: 0.97,
  agi_period_match: true,
  combined_with: [{ id: 'row-2', transaktionsdatum: '2026-09-12', transaktionstext: 'Moms', belopp_skatteverket: 100 }],
}

const COVER: SkattekontoLedgerCoverInfo = {
  account_number: '1630',
  through_date: '2026-06-30',
  kind: 'events_equal',
  event_count: 4,
  event_total: -12000,
  entries: [
    {
      journal_entry_id: 'je-9',
      voucher_series: 'A',
      voucher_number: 88,
      entry_date: '2026-06-30',
      description: 'Skattekonto jan-jun',
      status: 'posted',
      open_amount: -12000,
    },
  ],
  entry_count: 1,
}

describe('readSkattekontoTwinProbe', () => {
  it('answers with the twins, reduced to the twin fields', () => {
    expect(readSkattekontoTwinProbe({ data: { candidates: [CANDIDATE] } })).toEqual({
      kind: 'twin',
      twins: [
        {
          journal_entry_id: 'je-1',
          voucher_series: 'A',
          voucher_number: 217,
          entry_date: '2026-09-12',
          description: 'Inbetalning skattekonto',
          status: 'posted',
        },
      ],
    })
  })

  it('answers with the cover when no single verifikat carries the row', () => {
    expect(readSkattekontoTwinProbe({ data: { candidates: [], ledger_cover: COVER } })).toEqual({
      kind: 'cover',
      cover: COVER,
    })
  })

  it('prefers the twins when both are present, as the booking guard does', () => {
    expect(readSkattekontoTwinProbe({ data: { candidates: [CANDIDATE], ledger_cover: COVER } })?.kind).toBe('twin')
  })

  it('answers null when the ledger holds neither', () => {
    expect(readSkattekontoTwinProbe({ data: { candidates: [] } })).toBeNull()
  })

  it('answers null for a body that is not the match-candidates answer', () => {
    expect(readSkattekontoTwinProbe(null)).toBeNull()
    expect(readSkattekontoTwinProbe(undefined)).toBeNull()
    expect(readSkattekontoTwinProbe('oops')).toBeNull()
    expect(readSkattekontoTwinProbe({ error: 'Saknar transaktions-id' })).toBeNull()
    expect(readSkattekontoTwinProbe({ data: null })).toBeNull()
    expect(readSkattekontoTwinProbe({ data: { candidates: 'x', ledger_cover: 'y' } })).toBeNull()
  })
})
