import { describe, it, expect } from 'vitest'
import {
  FALLBACK_CONFIDENCE_FACTOR,
  calculateMatchConfidence,
} from '@/lib/documents/core-receipt-matcher'
import {
  UNDERLAG_MATCH_DATE_TOLERANCE_DAYS,
  rankBankRowsForUnderlag,
  underlagPaymentFacts,
  underlagTotalSek,
  type UnbookedBankRow,
} from '../underlag-bank-candidates'
import type { InvoiceExtractionResult } from '@/types'

/**
 * The one ranking behind the inbox match picker and Bokför direkt
 * (useUnderlagBankCandidates). Moved out of the picker's render memo, where it
 * could not be tested; these pin what it ranked on.
 */
function extracted(over: Record<string, unknown>): InvoiceExtractionResult {
  return over as unknown as InvoiceExtractionResult
}

function row(over: Partial<UnbookedBankRow> & { id: string }): UnbookedBankRow {
  return {
    date: '2026-09-10',
    description: 'Kortköp',
    merchant_name: null,
    amount: -100,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    ...over,
  }
}

const today = new Date('2026-09-10')

describe('underlagPaymentFacts', () => {
  it('reads total, currency, date and supplier', () => {
    const facts = underlagPaymentFacts(
      extracted({
        totals: { total: 250 },
        invoice: { currency: ' eur ', invoiceDate: '2026-09-01' },
        supplier: { name: 'Acme AB' },
      }),
    )
    expect(facts).toMatchObject({ total: 250, currency: 'EUR', invoiceDate: '2026-09-01', supplier: 'Acme AB' })
  })

  it('demotes a total promoted from a prominent amount to the fallback amounts', () => {
    const facts = underlagPaymentFacts(
      extracted({
        totals: { total: 250 },
        totalSource: 'prominent',
        prominentAmounts: [{ amount: 250, label: 'Att betala' }, { amount: 0, label: null }],
      }),
    )
    expect(facts.total).toBeNull()
    expect(facts.prominentAmounts).toEqual([{ amount: 250, label: 'Att betala' }])
  })

  it('drops an unreadable date and defaults the currency to SEK', () => {
    const facts = underlagPaymentFacts(extracted({ invoice: { invoiceDate: 'igår' } }))
    expect(facts.invoiceDate).toBeNull()
    expect(facts.currency).toBe('SEK')
  })
})

describe('underlagTotalSek', () => {
  it('is the total on SEK, the rate-converted total on a priced foreign underlag, else null', () => {
    const sek = underlagPaymentFacts(extracted({ totals: { total: 100 } }))
    const eur = underlagPaymentFacts(extracted({ totals: { total: 100 }, invoice: { currency: 'EUR' } }))
    expect(underlagTotalSek(sek, null)).toBe(100)
    expect(underlagTotalSek(eur, 11.234)).toBe(1123.4)
    expect(underlagTotalSek(eur, null)).toBeNull()
  })
})

describe('rankBankRowsForUnderlag', () => {
  const facts = underlagPaymentFacts(
    extracted({
      totals: { total: 100 },
      invoice: { currency: 'SEK', invoiceDate: '2026-09-10' },
      supplier: { name: 'Acme AB' },
    }),
  )

  it('scores with the receipt matcher at the 120-day ranking tolerance', () => {
    const [ranked] = rankBankRowsForUnderlag([row({ id: 'a', description: 'ACME AB', amount: -100 })], facts, null, today)
    const expected = calculateMatchConfidence(0, 0, 1, UNDERLAG_MATCH_DATE_TOLERANCE_DAYS)
    expect(ranked.confidence).toBe(expected.confidence)
    expect(ranked.reasons).toEqual(expected.matchReasons)
  })

  it('puts the exact amount and supplier first, best match first', () => {
    const ranked = rankBankRowsForUnderlag(
      [
        row({ id: 'far', description: 'Annat', amount: -3000, date: '2026-05-01' }),
        row({ id: 'right', description: 'ACME AB', amount: -100 }),
        row({ id: 'near', description: 'Annat', amount: -100 }),
      ],
      facts,
      null,
      today,
    )
    expect(ranked.map((r) => r.row.id)).toEqual(['right', 'near', 'far'])
  })

  it('has no amount signal for a foreign underlag with no rate yet (750 EUR is not 750 SEK)', () => {
    const eur = underlagPaymentFacts(extracted({ totals: { total: 750 }, invoice: { currency: 'EUR', invoiceDate: '2026-09-10' } }))
    const [ranked] = rankBankRowsForUnderlag([row({ id: 'a', amount: -750 })], eur, null, today)
    expect(ranked.reasons).not.toContain('Exakt belopp')
  })

  it('compares a foreign underlag through SEK once the rate is known, and hints the foreign row in kronor', () => {
    const eur = underlagPaymentFacts(extracted({ totals: { total: 100 }, invoice: { currency: 'EUR', invoiceDate: '2026-09-10' } }))
    const [sekRow] = rankBankRowsForUnderlag([row({ id: 'a', amount: -1150 })], eur, 11.5, today)
    expect(sekRow.reasons).toContain('Exakt belopp')
    const [usdRow] = rankBankRowsForUnderlag(
      [row({ id: 'b', amount: -10, currency: 'usd', amount_sek: -104.37 })],
      eur,
      11.5,
      today,
    )
    expect(usdRow.currency).toBe('USD')
    expect(usdRow.amountSek).toBe(-104.37)
  })

  it('discounts a match on a printed amount when the document has no total', () => {
    const noTotal = underlagPaymentFacts(
      extracted({ prominentAmounts: [{ amount: 100, label: null }], invoice: { invoiceDate: '2026-09-10' } }),
    )
    const [ranked] = rankBankRowsForUnderlag([row({ id: 'a', amount: -100 })], noTotal, null, today)
    const full = calculateMatchConfidence(0, 0, 0, UNDERLAG_MATCH_DATE_TOLERANCE_DAYS)
    expect(ranked.confidence).toBeCloseTo(full.confidence * FALLBACK_CONFIDENCE_FACTOR, 2)
  })
})

describe('rankBankRowsForUnderlag: the money goes the way the document says', () => {
  const rows = [
    row({ id: 'out', amount: -430, description: 'TAXI STOCKHOLM K3667' }),
    row({ id: 'in', amount: 15000, description: 'Inbetalning kund 1043' }),
  ]

  it('never offers a purchase receipt or invoice an incoming payment', () => {
    for (const documentKind of ['receipt', 'supplier_invoice']) {
      const facts = underlagPaymentFacts(extracted({ documentKind, totals: { total: 430 }, supplier: { name: 'Taxi Stockholm' } }))
      expect(facts.direction).toBe('out')
      expect(rankBankRowsForUnderlag(rows, facts, null, today).map((r) => r.row.id)).toEqual(['out'])
    }
  })

  it('offers a credit note, or a refund below zero, only money coming in', () => {
    const credit = underlagPaymentFacts(extracted({ documentKind: 'credit_note', totals: { total: -500 } }))
    expect(rankBankRowsForUnderlag(rows, credit, null, today).map((r) => r.row.id)).toEqual(['in'])
    const refund = underlagPaymentFacts(extracted({ documentKind: 'receipt', totals: { total: -430 } }))
    expect(refund.direction).toBe('in')
    expect(rankBankRowsForUnderlag(rows, refund, null, today).map((r) => r.row.id)).toEqual(['in'])
  })

  it('a document that says neither keeps rows of both signs', () => {
    const unknown = underlagPaymentFacts(extracted({ totals: { total: 430 } }))
    expect(unknown.direction).toBeNull()
    expect(rankBankRowsForUnderlag(rows, unknown, null, today)).toHaveLength(2)
  })
})
