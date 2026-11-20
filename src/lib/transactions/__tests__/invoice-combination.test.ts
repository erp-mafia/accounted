import { describe, expect, it } from 'vitest'
import {
  COMBINATION_MAX_CANDIDATES,
  findInvoiceCombination,
  inCombinationWindow,
  matchRowsToInvoiceCombinations,
  type CombinationInvoice,
} from '../invoice-combination'

function inv(
  id: string,
  counterpartyId: string | null,
  remaining: number,
  invoiceDate: string | null = '2026-10-01',
  dueDate: string | null = '2026-10-31',
  currency: string | null = 'SEK',
): CombinationInvoice {
  return { id, counterpartyId, remaining, invoiceDate, dueDate, currency }
}

const ids = (m: { invoices: CombinationInvoice[] } | null) => m?.invoices.map((i) => i.id) ?? null

describe('findInvoiceCombination', () => {
  it('finds the two invoices of one supplier that one payment settles (PH 192)', () => {
    const match = findInvoiceCombination({ id: 'tx', amount: -11028, date: '2026-10-12' }, [
      inv('later-due', 'sup-1', 9028, '2026-10-10', '2026-10-31'),
      inv('sooner-due', 'sup-1', 2000, '2026-10-10', '2026-10-17'),
      inv('other-supplier', 'sup-2', 4500, '2026-10-01', '2026-10-31'),
    ])
    expect(match).not.toBeNull()
    expect(match?.counterpartyId).toBe('sup-1')
    // Oldest due date first: the order the batch dialog lists them.
    expect(ids(match)).toEqual(['sooner-due', 'later-due'])
    expect(match?.total).toBe(11028)
  })

  it('adds remainders in öre, so decimals that do not sum exactly in floats still match', () => {
    const match = findInvoiceCombination({ id: 'tx', amount: 300.3, date: '2026-10-12' }, [
      inv('a', 'cus-1', 100.1),
      inv('b', 'cus-1', 200.2),
    ])
    expect(ids(match)).toEqual(['a', 'b'])
    expect(match?.total).toBe(300.3)
  })

  it('proposes nothing when one invoice alone has the amount: that is the 1:1 path', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, [
        inv('a', 'sup-1', 1000),
        inv('b', 'sup-1', 2000),
        inv('c', 'sup-2', 3000),
      ]),
    ).toBeNull()
  })

  it('proposes nothing when two different sets of one supplier fit', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -1000, date: '2026-10-12' }, [
        inv('a', 'sup-1', 500),
        inv('b', 'sup-1', 500),
        inv('c', 'sup-1', 500),
      ]),
    ).toBeNull()
  })

  it('proposes nothing when sets of two different counterparties fit', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, [
        inv('a', 'sup-1', 1000),
        inv('b', 'sup-1', 2000),
        inv('c', 'sup-2', 1500),
        inv('d', 'sup-2', 1500),
      ]),
    ).toBeNull()
  })

  it('proposes nothing when a larger second set also fits', () => {
    // {a, b} and {c, d, e} both make 3000.
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, [
        inv('a', 'sup-1', 1800),
        inv('b', 'sup-1', 1200),
        inv('c', 'sup-1', 1100),
        inv('d', 'sup-1', 1000),
        inv('e', 'sup-1', 900),
      ]),
    ).toBeNull()
  })

  it('never combines invoices of different counterparties', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -11028, date: '2026-10-12' }, [
        inv('a', 'sup-1', 9028),
        inv('b', 'sup-2', 2000),
      ]),
    ).toBeNull()
  })

  it('leaves out invoices without a counterparty', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, [
        inv('a', null, 1000),
        inv('b', null, 2000),
      ]),
    ).toBeNull()
  })

  it('leaves out invoices whose payment window the row is outside', () => {
    const pool = [
      inv('old', 'sup-1', 1000, '2026-06-01', '2026-07-01'),
      inv('new', 'sup-1', 2000, '2026-10-01', '2026-10-31'),
    ]
    // 2026-10-12 is more than 45 days past the old invoice's due date.
    expect(findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, pool)).toBeNull()
    // Within 45 days of it, the pair is the answer.
    expect(ids(findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-08-14' }, [
      inv('old', 'sup-1', 1000, '2026-06-01', '2026-07-01'),
      inv('new', 'sup-1', 2000, '2026-08-10', '2026-09-10'),
    ]))).toEqual(['old', 'new'])
  })

  it('leaves out an invoice dated more than five days after the payment', () => {
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-01' }, [
        inv('a', 'sup-1', 1000, '2026-09-20', '2026-10-20'),
        inv('future', 'sup-1', 2000, '2026-10-07', '2026-11-06'),
      ]),
    ).toBeNull()
  })

  it('caps the set size', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id, i) => inv(id, 'cus-1', 1000 + i * 100))
    const row = { id: 'tx', amount: 6000, date: '2026-10-12' }
    expect(findInvoiceCombination(row, pool)).toBeNull()
    expect(ids(findInvoiceCombination(row, pool, { maxSize: 5 }))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('proposes nothing when one counterparty has more eligible invoices than can be searched', () => {
    const pool = [
      inv('x', 'sup-1', 7000.11),
      inv('y', 'sup-1', 3000.22),
      ...Array.from({ length: COMBINATION_MAX_CANDIDATES - 1 }, (_, i) => inv(`filler-${i}`, 'sup-1', 1 + i * 0.01)),
    ]
    const row = { id: 'tx', amount: -10000.33, date: '2026-10-12' }
    expect(findInvoiceCombination(row, pool)).toBeNull()
    expect(ids(findInvoiceCombination(row, pool, { maxCandidates: COMBINATION_MAX_CANDIDATES + 1 }))).toEqual(['x', 'y'])
  })

  it('is not blocked by a counterparty with many small invoices that together owe less than the row', () => {
    const pool = [
      inv('x', 'sup-1', 9028),
      inv('y', 'sup-1', 2000),
      ...Array.from({ length: COMBINATION_MAX_CANDIDATES + 2 }, (_, i) => inv(`small-${i}`, 'sup-2', 50 + i)),
    ]
    expect(ids(findInvoiceCombination({ id: 'tx', amount: -11028, date: '2026-10-12' }, pool))).toEqual(['x', 'y'])
  })

  it('proposes nothing when the search runs past its budget', () => {
    const pool = [inv('a', 'sup-1', 1000), inv('b', 'sup-1', 2000), inv('c', 'sup-1', 400)]
    const row = { id: 'tx', amount: -3000, date: '2026-10-12' }
    expect(ids(findInvoiceCombination(row, pool))).toEqual(['a', 'b'])
    expect(findInvoiceCombination(row, pool, { nodeBudget: 1 })).toBeNull()
  })

  it('works in kronor only', () => {
    const pool = [inv('a', 'sup-1', 1000), inv('b', 'sup-1', 2000)]
    expect(findInvoiceCombination({ id: 'tx', amount: -3000, currency: 'EUR', date: '2026-10-12' }, pool)).toBeNull()
    expect(
      findInvoiceCombination({ id: 'tx', amount: -3000, date: '2026-10-12' }, [
        inv('a', 'sup-1', 1000),
        inv('b', 'sup-1', 2000, '2026-10-01', '2026-10-31', 'EUR'),
      ]),
    ).toBeNull()
    // A NULL currency on either side is kronor.
    expect(ids(findInvoiceCombination({ id: 'tx', amount: -3000, currency: null, date: '2026-10-12' }, [
      inv('a', 'sup-1', 1000, '2026-10-01', '2026-10-31', null),
      inv('b', 'sup-1', 2000),
    ]))).toEqual(['a', 'b'])
  })

  it('proposes nothing for a zero row', () => {
    expect(findInvoiceCombination({ id: 'tx', amount: 0, date: '2026-10-12' }, [inv('a', 'sup-1', 0)])).toBeNull()
  })
})

describe('inCombinationWindow', () => {
  it('spans five days before the invoice date to 45 days after the due date', () => {
    const invoice = { invoiceDate: '2026-10-10', dueDate: '2026-10-31' }
    expect(inCombinationWindow('2026-10-05', invoice)).toBe(true)
    expect(inCombinationWindow('2026-10-04', invoice)).toBe(false)
    expect(inCombinationWindow('2026-12-15', invoice)).toBe(true)
    expect(inCombinationWindow('2026-12-16', invoice)).toBe(false)
  })

  it('assumes 30-day terms when one date is missing, and excludes an invoice with neither', () => {
    expect(inCombinationWindow('2026-10-01', { invoiceDate: null, dueDate: '2026-10-31' })).toBe(true)
    expect(inCombinationWindow('2026-09-25', { invoiceDate: null, dueDate: '2026-10-31' })).toBe(false)
    expect(inCombinationWindow('2026-12-15', { invoiceDate: '2026-10-01', dueDate: null })).toBe(true)
    expect(inCombinationWindow('2026-12-16', { invoiceDate: '2026-10-01', dueDate: null })).toBe(false)
    expect(inCombinationWindow('2026-10-01', { invoiceDate: null, dueDate: null })).toBe(false)
  })
})

describe('matchRowsToInvoiceCombinations', () => {
  const customer = [inv('c1', 'cus-1', 400), inv('c2', 'cus-1', 600)]
  const supplier = [inv('s1', 'sup-1', 9028), inv('s2', 'sup-1', 2000)]

  it('matches a payment against supplier invoices and a receipt against customer invoices', () => {
    const out = matchRowsToInvoiceCombinations(
      [
        { id: 'pay', amount: -11028, date: '2026-10-12' },
        { id: 'receipt', amount: 1000, date: '2026-10-12' },
        // The same amounts with the directions swapped find nothing.
        { id: 'pay-1000', amount: -1000, date: '2026-10-12' },
        { id: 'zero', amount: 0, date: '2026-10-12' },
      ],
      { customer, supplier },
    )
    expect([...out.keys()].sort()).toEqual(['pay', 'receipt'])
    expect(ids(out.get('pay') ?? null)).toEqual(['s1', 's2'])
    expect(ids(out.get('receipt') ?? null)).toEqual(['c1', 'c2'])
  })

  it('proposes a set for neither row when two rows claim the same invoices (a duplicate import)', () => {
    const out = matchRowsToInvoiceCombinations(
      [
        { id: 'pay', amount: -11028, date: '2026-10-12' },
        { id: 'pay-duplicate', amount: -11028, date: '2026-10-12' },
        { id: 'receipt', amount: 1000, date: '2026-10-12' },
      ],
      { customer, supplier },
    )
    expect([...out.keys()]).toEqual(['receipt'])
  })
})
