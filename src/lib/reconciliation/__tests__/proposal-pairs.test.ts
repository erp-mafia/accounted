import { describe, it, expect } from 'vitest'
import { proposalPairsOf } from '../proposal-pairs'
import type { ReconciliationItem } from '../schemas'

function proposed(id: string, amount: number, entry: string, group?: string[]): ReconciliationItem {
  return {
    item_id: id,
    item_type: 'skattekonto_transaction',
    side: 'external',
    bucket: 'proposed',
    date: '2026-07-14',
    description: `Händelse ${id}`,
    amount,
    currency: 'SEK',
    proposal: {
      journal_entry_id: entry,
      voucher_number: 7,
      voucher_series: 'M',
      entry_date: '2026-07-14',
      description: 'Skattekonto juli',
      entry_status: 'posted',
      confidence: 0.9,
      reasons: [],
      ...(group ? { external_ids: group } : {}),
    },
    actions: ['match', 'book', 'ignore'],
  }
}

describe('proposalPairsOf', () => {
  it('sends a combined proposal as one pair of all its rows, and a single one as its own pair', () => {
    const group = ['a', 'b', 'c']
    const summary = proposalPairsOf([
      proposed('a', 91, 'M7', group),
      proposed('b', -33682, 'M7', group),
      proposed('c', -35630, 'M7', group),
      proposed('d', 69312, 'A5'),
    ])
    expect(summary.pairs.map((p) => [p.journal_entry_id, p.external_ids])).toEqual([
      ['M7', group],
      ['A5', ['d']],
    ])
    expect(summary.pairs[0].total).toBe(-69221)
    expect(summary).toMatchObject({ row_count: 4, entry_count: 2, total: 91 })
  })

  it('leaves out a group whose rows are not all listed, so the preview never shows a sum the link would not make', () => {
    const summary = proposalPairsOf([proposed('a', 91, 'M7', ['a', 'b']), proposed('d', 69312, 'A5')])
    expect(summary.pairs.map((p) => p.journal_entry_id)).toEqual(['A5'])
    expect(summary.row_count).toBe(1)
  })

  it('ignores rows that are not skattekonto proposals', () => {
    const open: ReconciliationItem = { ...proposed('x', 5, 'A1'), bucket: 'unmatched_external', proposal: null }
    const bank: ReconciliationItem = { ...proposed('y', 5, 'A2'), item_type: 'transaction' }
    expect(proposalPairsOf([open, bank]).pairs).toEqual([])
  })
})
