import { describe, expect, it } from 'vitest'
import {
  toBookAmountLabel,
  toBookIsMoneyIn,
  bookingWalk,
  buildToBookRows,
  inToBookFilter,
  opensInBookingScreen,
  toBookCounts,
  toBookFilterFromSlug,
  toBookFilterOfBack,
  toBookListHref,
  TO_BOOK_FILTERS,
  type ToBookBankRow,
  type ToBookDocument,
} from '../to-book'

const bank = (over: Partial<ToBookBankRow> = {}): ToBookBankRow => ({
  id: 'tx-1',
  date: '2026-11-18',
  description: 'CLAS OHLSON 123',
  amount: -1249,
  currency: 'SEK',
  cash_account_id: 'ca-1',
  document_id: null,
  ...over,
})

const doc = (over: Partial<ToBookDocument> = {}): ToBookDocument => ({
  id: 'doc-1',
  name: 'Clas Ohlson',
  date: '2026-11-18',
  amount: 1249,
  currency: 'SEK',
  bankMatchTransactionId: null,
  ...over,
})

describe('buildToBookRows', () => {
  it('shows a document that looks paid by an open bank row on that row, not as its own row', () => {
    const rows = buildToBookRows([bank()], [doc({ bankMatchTransactionId: 'tx-1' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'bank', transactionId: 'tx-1', inboxItemId: 'doc-1', underlag: 'found' })
  })

  it('keeps the document a row holds; a document matched to it elsewhere stays its own row', () => {
    const rows = buildToBookRows([bank({ document_id: 'pinned' })], [doc({ bankMatchTransactionId: 'tx-1' })])
    expect(rows.map((r) => [r.kind, r.underlag])).toEqual([
      ['bank', 'attached'],
      ['document', 'document'],
    ])
  })

  it('gives a bank row one found document: the second one stays its own row', () => {
    const rows = buildToBookRows([bank()], [doc({ bankMatchTransactionId: 'tx-1' }), doc({ id: 'doc-2', bankMatchTransactionId: 'tx-1' })])
    expect(rows.filter((r) => r.kind === 'bank')[0].inboxItemId).toBe('doc-1')
    expect(rows.filter((r) => r.kind === 'document').map((r) => r.inboxItemId)).toEqual(['doc-2'])
  })

  it('lists a document whose bank row is not open as its own row, and a bank row with nothing as missing', () => {
    const rows = buildToBookRows([bank({ id: 'tx-2' })], [doc({ bankMatchTransactionId: 'tx-booked' })])
    expect(rows.map((r) => [r.kind, r.underlag])).toEqual([
      ['bank', 'missing'],
      ['document', 'document'],
    ])
  })

  it('orders newest first, rows without a date last', () => {
    const rows = buildToBookRows(
      [bank({ id: 'old', date: '2026-10-01' }), bank({ id: 'new', date: '2026-11-20' })],
      [doc({ id: 'undated', date: null }), doc({ id: 'mid', date: '2026-11-01' })],
    )
    expect(rows.map((r) => r.transactionId ?? r.inboxItemId)).toEqual(['new', 'mid', 'old', 'undated'])
  })
})

describe('filters and counts', () => {
  const rows = buildToBookRows(
    [bank({ id: 'a' }), bank({ id: 'b', document_id: 'd' }), bank({ id: 'c' })],
    [doc({ id: 'x', bankMatchTransactionId: 'c' }), doc({ id: 'y' })],
  )

  it('counts every filter from the same rows', () => {
    expect(toBookCounts(rows)).toEqual({ all: 4, missing: 1, found: 1, no_bank: 1 })
  })

  it('places each row under the filters it belongs to', () => {
    const found = rows.find((r) => r.transactionId === 'c')!
    expect(inToBookFilter(found, 'found')).toBe(true)
    expect(inToBookFilter(found, 'missing')).toBe(false)
    expect(inToBookFilter(found, 'all')).toBe(true)
  })
})

describe('the walk on the booking screen', () => {
  const rows = buildToBookRows(
    [bank({ id: 'a', date: '2026-11-20' }), bank({ id: 'b', date: '2026-11-19', document_id: 'd' }), bank({ id: 'c', date: '2026-11-18' })],
    [doc({ id: 'x', bankMatchTransactionId: 'c' }), doc({ id: 'y', date: '2026-11-21' })],
  )

  it('steps through the bank rows the screen opens, in the list order, skipping found pairs and documents', () => {
    expect(rows.filter(opensInBookingScreen).map((r) => r.transactionId)).toEqual(['a', 'b'])
    expect(bookingWalk(rows, 'all')).toEqual(['a', 'b'])
  })

  it('keeps the list filter', () => {
    expect(bookingWalk(rows, 'missing')).toEqual(['a'])
    expect(bookingWalk(rows, 'no_bank')).toEqual([])
  })
})

describe('the filter in the address', () => {
  it('round-trips every filter, Alla without a query', () => {
    for (const f of TO_BOOK_FILTERS) expect(toBookFilterOfBack(toBookListHref(f))).toBe(f)
    expect(toBookListHref('all')).toBe('/att-bokfora')
    expect(toBookListHref('missing')).toBe('/att-bokfora?visa=saknar-underlag')
  })

  it('reads an unknown filter as Alla, and another page as no list at all', () => {
    expect(toBookFilterFromSlug('nonsense')).toBe('all')
    expect(toBookFilterOfBack('/att-bokfora?visa=nonsense')).toBe('all')
    expect(toBookFilterOfBack('/transactions?visa=saknar-underlag')).toBeNull()
    expect(toBookFilterOfBack('/att-bokforax')).toBeNull()
    expect(toBookFilterOfBack(null)).toBeNull()
  })
})

describe('the amount a row shows', () => {
  it('writes money in on a bank row with a plus, money out with its minus', () => {
    expect(toBookAmountLabel({ kind: 'bank', amount: 2985, currency: 'SEK' })).toBe('+2\u00a0985')
    expect(toBookAmountLabel({ kind: 'bank', amount: -414.77, currency: 'SEK' })).toBe('\u2212414,77')
    expect(toBookIsMoneyIn({ kind: 'bank', amount: 2985 })).toBe(true)
    expect(toBookIsMoneyIn({ kind: 'bank', amount: -1 })).toBe(false)
  })

  it('gives a document no sign, and no amount no text', () => {
    expect(toBookAmountLabel({ kind: 'document', amount: 100, currency: 'SEK' })).toBe('100')
    expect(toBookIsMoneyIn({ kind: 'document', amount: 100 })).toBe(false)
    expect(toBookAmountLabel({ kind: 'document', amount: null, currency: null })).toBe('')
  })

  it('keeps the currency of a foreign amount', () => {
    expect(toBookAmountLabel({ kind: 'bank', amount: 12.5, currency: 'EUR' })).toMatch(/^\+12,50\s€$/)
  })
})
