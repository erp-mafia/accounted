import { describe, it, expect } from 'vitest'
import { creditNoteCreditUsed, outstandingWithCreditUsed, type CreditNoteLink } from '../credit-note-settlement'

// The payment row link_invoice_to_voucher writes on the new invoice when the
// credit note's verifikat is linked to it: dated on the verifikat's date.
// get_ar_ledger_invoices attaches these to the credit note as credit_links.
function link(overrides: Partial<CreditNoteLink> = {}): CreditNoteLink {
  return {
    invoice_id: 'inv-new',
    journal_entry_id: 'je-cn',
    amount: 40000,
    currency: 'SEK',
    payment_exchange_rate: null,
    payment_date: '2026-09-01',
    invoice: { invoice_date: '2026-09-05' },
    ...overrides,
  }
}

// A kreditfaktura issued on a paid invoice, booked on its own verifikat.
function creditNote(links: CreditNoteLink[], overrides: Record<string, unknown> = {}) {
  return { id: 'cn', total: -40000, currency: 'SEK', exchange_rate: null, journal_entry_id: 'je-cn', credit_links: links, ...overrides }
}

describe('creditNoteCreditUsed', () => {
  it('reads nothing from rows that are not credit notes with a verifikat', () => {
    const used = creditNoteCreditUsed([
      { id: 'inv-1', total: 1000, journal_entry_id: 'je-1', credit_links: [link({ journal_entry_id: 'je-1' })] },
      { id: 'cn-unbooked', total: -500, journal_entry_id: null, credit_links: [link()] },
    ])

    expect(used.size).toBe(0)
  })

  it("reads the credit a credit note's verifikat paid on another invoice (crm#1059)", () => {
    const used = creditNoteCreditUsed([
      creditNote([link()]),
      { id: 'inv-new', total: 50000, journal_entry_id: 'je-new', credit_links: null },
    ])

    expect(used.get('cn')).toBe(40000)
    expect(used.has('inv-new')).toBe(false)
  })

  it('adds up every link, a verifikat linked to two invoices included, and ignores a row on the credit note itself', () => {
    // The link refuses a second link to the same invoice only, so the same
    // verifikat can pay two invoices: both uses count.
    const used = creditNoteCreditUsed([
      creditNote([
        link({ invoice_id: 'inv-a' }),
        link({ invoice_id: 'inv-b' }),
        link({ invoice_id: 'cn', amount: 5000 }),
      ]),
    ])

    expect(used.get('cn')).toBe(80000)
  })

  it('never reads more from one link than the credit note holds', () => {
    // A kronor row against a yen credit note: 7 123.46 kr at the credit
    // note's rate is 100 000.06, conversion noise above its 100 000 credit.
    const used = creditNoteCreditUsed([
      creditNote([link({ amount: 7123.46, currency: 'SEK' })], { total: -100000, currency: 'JPY', exchange_rate: 0.07123456 }),
    ])

    expect(used.get('cn')).toBe(100000)
  })

  it('counts a set-off on an as-of date only once the invoice it paid exists', () => {
    // The payment row is dated on the credit note's verifikat (09-01), but
    // the invoice it paid is dated 09-05: in between, 1510 still held the
    // credit.
    expect(creditNoteCreditUsed([creditNote([link()])], '2026-09-04').size).toBe(0)
    expect(creditNoteCreditUsed([creditNote([link()])], '2026-09-05').get('cn')).toBe(40000)
  })

  it('counts a set-off on an as-of date from the payment date when the invoice is older', () => {
    const older = [creditNote([link({ payment_date: '2026-09-10', invoice: { invoice_date: '2026-08-01' } })])]
    expect(creditNoteCreditUsed(older, '2026-09-09').size).toBe(0)
    expect(creditNoteCreditUsed(older, '2026-09-10').get('cn')).toBe(40000)
  })

  it('reads the kronor fallback for a foreign invoice as the whole credit', () => {
    // link_invoice_to_voucher settles a foreign invoice from a plain-SEK
    // verifikat with all of its kronor, whatever the row amount says.
    const used = creditNoteCreditUsed([
      creditNote([link({ amount: 3500, currency: 'EUR', payment_exchange_rate: 11.428571 })]),
    ])

    expect(used.get('cn')).toBe(40000)
  })

  it("converts kronor used from a foreign credit note at the credit note's rate", () => {
    const used = creditNoteCreditUsed([
      creditNote([link({ amount: 5500, currency: 'SEK' })], { total: -1000, currency: 'EUR', exchange_rate: 11 }),
    ])

    expect(used.get('cn')).toBe(500)
  })

  it('leaves out a row in a third currency it cannot read', () => {
    const used = creditNoteCreditUsed([
      creditNote([link({ amount: 900, currency: 'USD' })], { total: -1000, currency: 'EUR', exchange_rate: 11 }),
    ])

    expect(used.size).toBe(0)
  })

  it('attributes nothing when two credit notes share one verifikat', () => {
    const shared = [link({ journal_entry_id: 'je-shared' })]
    const used = creditNoteCreditUsed([
      { id: 'cn-1', total: -30000, currency: 'SEK', journal_entry_id: 'je-shared', credit_links: shared },
      { id: 'cn-2', total: -10000, currency: 'SEK', journal_entry_id: 'je-shared', credit_links: shared },
    ])

    expect(used.size).toBe(0)
  })

  it("reads each credit note's own links", () => {
    const notes = Array.from({ length: 101 }, (_, i) => ({
      id: `cn-${i}`,
      total: -100,
      currency: 'SEK',
      journal_entry_id: `je-${i}`,
      credit_links: i === 100 ? [link({ journal_entry_id: 'je-100', amount: 100 })] : [],
    }))

    const used = creditNoteCreditUsed(notes)

    expect([...used]).toEqual([['cn-100', 100]])
  })
})

describe('outstandingWithCreditUsed', () => {
  it('returns a row that used no credit untouched', () => {
    expect(outstandingWithCreditUsed(1234.565, undefined)).toBe(1234.565)
    expect(outstandingWithCreditUsed(-40000, 0)).toBe(-40000)
  })

  it('settles a credit note used in full at zero', () => {
    expect(outstandingWithCreditUsed(-40000, 40000)).toBe(0)
  })

  it('keeps the unused rest open (a partial use the link does not write today)', () => {
    expect(outstandingWithCreditUsed(-40000, 15000)).toBe(-25000)
  })

  it('shows a credit used twice as a positive amount instead of hiding it at zero', () => {
    expect(outstandingWithCreditUsed(-40000, 80000)).toBe(40000)
  })
})
