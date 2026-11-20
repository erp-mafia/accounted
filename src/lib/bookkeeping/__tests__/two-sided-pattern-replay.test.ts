/**
 * A learned line pattern whose business lines sit on both sides replays to
 * an entry that balances (crm#1746).
 *
 * Ratios are stored normalized over every line whichever side it is on, so
 * tjänstepension (7412) with its särskild löneskatt (7533 against 2514)
 * stores 0.6734 / 0.1633 / 0.1633. Replayed at those ratios the pension took
 * two thirds of the payment and debits never met credits, so the engine
 * refused every booking from such a template. The replay now scales by the
 * net of the larger side over the other.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMappingResultFromCounterpartyTemplate,
  verifikatTemplateShape,
} from '@/lib/bookkeeping/counterparty-templates'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { roundOre } from '@/lib/money'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { LinePatternEntry } from '@/types'

/** The pattern production stores for a pension voucher with särskild löneskatt (SIE learner). */
const PENSION: LinePatternEntry[] = [
  { account: '7412', type: 'business', side: 'debit', ratio: 0.6734 },
  { account: '7533', type: 'business', side: 'debit', ratio: 0.1633 },
  { account: '2514', type: 'business', side: 'credit', ratio: 0.1633 },
]

function replay(pattern: LinePatternEntry[], amount: number) {
  const template = makeCategorizationTemplate({
    debit_account: '7412',
    credit_account: '1930',
    vat_treatment: null,
    vat_account: null,
    line_pattern: pattern,
  })
  const tx = makeTransaction({ amount })
  const result = buildMappingResultFromCounterpartyTemplate(
    { template, matchMethod: 'exact_normalized', confidence: 0.9 }, tx, 'aktiebolag',
  )
  const entry = buildTransactionEntryLines(tx, result)
  return {
    lines: entry.map((l) => ({ account: l.account_number, debit: l.debit_amount, credit: l.credit_amount })),
    debits: roundOre(entry.reduce((s, l) => s + l.debit_amount, 0)),
    credits: roundOre(entry.reduce((s, l) => s + l.credit_amount, 0)),
  }
}

describe('two-sided learned pattern replay (crm#1746)', () => {
  it('books the whole payment as pension and the löneskatt beside it, balanced', () => {
    const { lines, debits, credits } = replay(PENSION, -11000)
    expect(debits).toBe(credits)
    expect(lines).toEqual([
      { account: '7412', debit: 11000, credit: 0 },
      { account: '7533', debit: 2667.51, credit: 0 },
      { account: '2514', debit: 0, credit: 2667.51 },
      { account: '1930', debit: 0, credit: 11000 },
    ])
  })

  it('replays the pattern a pension verifikat teaches the same way', () => {
    const shape = verifikatTemplateShape([
      { account: '7412', amount: 10000 },
      { account: '7533', amount: 2426 },
      { account: '2514', amount: -2426 },
      { account: '1930', amount: -10000 },
    ])
    expect(shape?.linePattern).toEqual(PENSION)
    const { debits, credits, lines } = replay(shape!.linePattern!, -10000)
    expect(debits).toBe(credits)
    expect(lines.find((l) => l.account === '7412')).toEqual({ account: '7412', debit: 10000, credit: 0 })
  })

  it('leaves a one-sided pattern exactly as before', () => {
    const { lines } = replay(
      [
        { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
        { account: '6540', type: 'business', side: 'debit', ratio: 0.6 },
        { account: '5420', type: 'business', side: 'debit', ratio: 0.4 },
      ],
      -1250,
    )
    expect(lines).toEqual([
      { account: '2641', debit: 250, credit: 0 },
      { account: '6540', debit: 600, credit: 0 },
      { account: '5420', debit: 400, credit: 0 },
      { account: '1930', debit: 0, credit: 1250 },
    ])
  })
})
