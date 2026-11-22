import { describe, expect, it } from 'vitest'
import { buildToBookRows, inToBookFilter, toBookCounts, type ToBookBankRow, type ToBookDocument } from '../to-book'

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
