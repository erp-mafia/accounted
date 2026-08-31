import { describe, it, expect } from 'vitest'
import {
  CANDIDATE_MIN_CONFIDENCE,
  scoreUnderlagCandidates,
} from '../underlag-candidates'
import type { InboxChannelContext, InvoiceExtractionResult } from '@/types'

function ctx(partial: Partial<InboxChannelContext>): InboxChannelContext {
  return { channel: 'whatsapp', ...partial }
}

function extraction(partial: {
  supplier?: string | null
  date?: string | null
  total?: number | null
  vat?: number | null
  currency?: string
  prominentAmounts?: { amount: number; label: string | null }[]
  totalSource?: 'prominent' | null
}): InvoiceExtractionResult {
  return {
    supplier: {
      name: partial.supplier ?? null,
      orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null,
    },
    invoice: {
      invoiceNumber: null, invoiceDate: partial.date ?? null, dueDate: null,
      paymentReference: null, currency: partial.currency ?? 'SEK',
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: partial.vat ?? null, total: partial.total ?? null },
    vatBreakdown: [],
    prominentAmounts: partial.prominentAmounts,
    totalSource: partial.totalSource,
    confidence: 0.9,
  } as InvoiceExtractionResult
}

describe('scoreUnderlagCandidates', () => {
  const tx = {
    id: 'tx-1',
    date: '2026-05-12',
    description: 'ESPRESSO HOUSE 1234 STOCKHOLM',
    merchant_name: 'Espresso House',
    amount: -184,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
  }

  it('surfaces an unmatched WhatsApp receipt that matches the transaction', () => {
    // The reported bug: this item is real, sitting in the inbox, and invisible
    // to every lookup because matched_transaction_id is NULL.
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'item-1',
        document_id: 'doc-1',
        extracted_data: extraction({
          supplier: 'Espresso House',
          date: '2026-05-12',
          total: 184,
        }),
        channel_context: ctx({
          representation: {
            participants: [{ name: 'Anna Berg', company: 'Volvo' }],
            purpose: 'kundmöte',
            event_date: null,
            raw_answer: 'jag och Anna',
            answered_at: '2026-05-12T13:00:00Z',
          },
        }),
      },
    ])

    expect(out).toHaveLength(1)
    expect(out[0].inbox_item_id).toBe('item-1')
    expect(out[0].confidence).toBeGreaterThanOrEqual(CANDIDATE_MIN_CONFIDENCE)
    expect(out[0].amountSource).toBe('total')
    // and it brings the captured answers along with it
    expect(out[0].channelContext?.representation?.purpose).toBe('kundmöte')
  })

  it('rejects a same-amount receipt from a different month', () => {
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'item-2',
        document_id: 'doc-2',
        extracted_data: extraction({ supplier: 'Okänd', date: '2026-01-02', total: 184 }),
        channel_context: null,
      },
    ])
    expect(out).toEqual([])
  })

  it('does not propose a receipt whose amount cannot be compared', () => {
    // 184 EUR is not 184 SEK, and with no stored rate the two are not
    // comparable at all. Without an amount signal the score would rest on date
    // + merchant alone and come back as a confident match, so an uncomparable
    // amount disqualifies the candidate outright. Same-merchant same-day is a
    // ranking hint for a human, not evidence of the same economic event.
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'item-3',
        document_id: 'doc-3',
        extracted_data: extraction({
          supplier: 'Espresso House',
          date: '2026-05-12',
          total: 184,
          currency: 'EUR',
        }),
        channel_context: null,
      },
    ])
    expect(out).toEqual([])
  })

  it('skips extractions with no usable signal', () => {
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'item-4',
        document_id: 'doc-4',
        extracted_data: extraction({ supplier: 'Espresso House' }),
        channel_context: null,
      },
    ])
    expect(out).toEqual([])
  })

  it('returns the strongest candidates first', () => {
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'weak',
        document_id: 'doc-w',
        extracted_data: extraction({ supplier: null, date: '2026-05-13', total: 184 }),
        channel_context: null,
      },
      {
        id: 'strong',
        document_id: 'doc-s',
        extracted_data: extraction({ supplier: 'Espresso House', date: '2026-05-12', total: 184 }),
        channel_context: null,
      },
    ])
    expect(out[0].inbox_item_id).toBe('strong')
  })

  it('proposes a non-invoice document via its prominent amounts', () => {
    // The Robotministeriet case: an SEB account agreement (documentKind
    // "other") has no "Att betala" total, only "Anslutnings-/Engångspris
    // 2 500". The bank charges AVGIFT -2500 the same day. Before the
    // prominentAmounts fallback this document was structurally unmatchable.
    const avgiftTx = {
      ...tx,
      description: 'AVGIFT',
      merchant_name: null,
      amount: -2500,
      date: '2026-08-26',
    }
    const out = scoreUnderlagCandidates(avgiftTx, [
      {
        id: 'item-avtal',
        document_id: 'doc-avtal',
        extracted_data: extraction({
          supplier: 'SEB',
          date: '2026-08-26',
          total: null,
          prominentAmounts: [
            { amount: 2500, label: 'Anslutnings-/Engångspris' },
          ],
        }),
        channel_context: null,
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].inbox_item_id).toBe('item-avtal')
    expect(out[0].confidence).toBeGreaterThanOrEqual(CANDIDATE_MIN_CONFIDENCE)
    // ...but never as certainty: a printed figure is not an invoice total.
    expect(out[0].confidence).toBeLessThan(1)
    // Tagged so low-scrutiny consumers (the nightly hunt) can exclude it.
    expect(out[0].amountSource).toBe('prominent')
    // The reason names WHICH figure matched, since total_amount stays null.
    expect(out[0].total_amount).toBeNull()
    // toLocaleString('sv-SE') groups with a non-breaking space (U+00A0).
    expect(out[0].matchReasons.join(' ')).toContain(`2${' '}500`)
    expect(out[0].matchReasons.join(' ')).toContain('Anslutnings-/Engångspris')
  })

  it('scores a promoted total (totalSource prominent) as fallback-grade, not invoice-grade', () => {
    // promoteSingleProminentAmount fills TOTALT for the UI, but matching must
    // not mistake that for an invoice total: same discount, same tagging.
    const out = scoreUnderlagCandidates(
      { ...tx, description: 'AVGIFT', merchant_name: null, amount: -2500, date: '2026-08-26' },
      [
        {
          id: 'item-promoted',
          document_id: 'doc-promoted',
          extracted_data: extraction({
            supplier: 'SEB',
            date: '2026-08-26',
            total: 2500,
            totalSource: 'prominent',
            prominentAmounts: [{ amount: 2500, label: 'Anslutnings-/Engångspris' }],
          }),
          channel_context: null,
        },
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBeLessThan(1)
    expect(out[0].amountSource).toBe('prominent')
  })

  it('scores a user-corrected total at full weight', () => {
    // The fields-PATCH route clears totalSource when a human edits TOTALT:
    // from then on the amount is a verified total, no discount.
    const out = scoreUnderlagCandidates(
      { ...tx, description: 'AVGIFT', merchant_name: null, amount: -2500, date: '2026-08-26' },
      [
        {
          id: 'item-corrected',
          document_id: 'doc-corrected',
          extracted_data: extraction({
            supplier: 'SEB',
            date: '2026-08-26',
            total: 2500,
            totalSource: null,
            prominentAmounts: [{ amount: 9999, label: 'Fel belopp' }],
          }),
          channel_context: null,
        },
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0].confidence).toBe(1)
    expect(out[0].amountSource).toBe('total')
    expect(out[0].total_amount).toBe(2500)
  })

  it('does not let a prominent amount alone carry a dateless document over the floor', () => {
    // Amount agreement without a date is weaker than a total + date pair; the
    // candidate surface trades recall for precision, so this stays in the
    // manual picker only.
    const out = scoreUnderlagCandidates({ ...tx, amount: -25000 }, [
      {
        id: 'item-intyg',
        document_id: 'doc-intyg',
        extracted_data: extraction({
          supplier: 'SEB',
          date: null,
          total: null,
          prominentAmounts: [{ amount: 25000, label: 'Insatt belopp' }],
        }),
        channel_context: null,
      },
    ])
    expect(out).toEqual([])
  })

  it('does not match an avtal to a later charge on amount + merchant alone', () => {
    // A Telia avtal listing 349 kr must not surface for every future 349 kr
    // Telia charge: the fallback requires the document date to agree within
    // the normal tolerance.
    const out = scoreUnderlagCandidates(
      { ...tx, description: 'TELIA SVERIGE AB', merchant_name: 'Telia Sverige AB', amount: -349 },
      [
        {
          id: 'item-telia',
          document_id: 'doc-telia',
          extracted_data: extraction({
            supplier: 'Telia Sverige AB',
            date: '2026-01-15',
            total: null,
            prominentAmounts: [{ amount: 349, label: 'Månadspris' }],
          }),
          channel_context: null,
        },
      ],
    )
    expect(out).toEqual([])
  })

  it('rejects a non-invoice document whose prominent amounts all disagree', () => {
    // Same-day, same merchant, but the printed amounts match nothing: the
    // discount keeps this under the floor, where a real disagreeing invoice
    // total would sit exactly at it.
    const out = scoreUnderlagCandidates(tx, [
      {
        id: 'item-wrong',
        document_id: 'doc-wrong',
        extracted_data: extraction({
          supplier: 'Espresso House',
          date: '2026-05-12',
          total: null,
          prominentAmounts: [{ amount: 9999, label: 'Pris' }],
        }),
        channel_context: null,
      },
    ])
    expect(out).toEqual([])
  })

  it('returns nothing for a transaction with no date or amount', () => {
    expect(
      scoreUnderlagCandidates({ ...tx, date: null }, [
        {
          id: 'item-5',
          document_id: 'doc-5',
          extracted_data: extraction({ supplier: 'Espresso House', date: '2026-05-12', total: 184 }),
          channel_context: null,
        },
      ]),
    ).toEqual([])
  })
})
