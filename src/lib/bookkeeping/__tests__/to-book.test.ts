import { describe, expect, it, vi } from 'vitest'
import {
  toBookAmountLabel,
  toBookIsMoneyIn,
  bookingWalk,
  buildToBookRows,
  inToBookFilter,
  opensInBookingScreen,
  readAllToBookBankRows,
  toBookScreenSubject,
  toBookReturnPath,
  toBookDoor,
  toBookCounts,
  toBookFilterFromSlug,
  toBookFilterOfBack,
  toBookListHref,
  TO_BOOK_FILTERS,
  type ToBookBankCursor,
  type ToBookBankPage,
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
  kind: null,
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
    expect(toBookCounts(rows)).toEqual({ all: 4, missing: 1, found: 1, no_bank: 1, skattekonto: 0 })
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

describe('a receipt found for a bank row', () => {
  const rows = buildToBookRows(
    [bank({ id: 'a', date: '2026-11-20' }), bank({ id: 'c', date: '2026-11-18' })],
    [doc({ id: 'kvitto', bankMatchTransactionId: 'a', kind: 'receipt' }), doc({ id: 'faktura', bankMatchTransactionId: 'c', kind: 'supplier_invoice' })],
  )
  const receiptRow = rows.find((r) => r.transactionId === 'a')!
  const invoiceRow = rows.find((r) => r.transactionId === 'c')!

  it('opens the bank row on the booking screen with the receipt held as its underlag', () => {
    expect(opensInBookingScreen(receiptRow)).toBe(true)
    expect(toBookScreenSubject(receiptRow)).toEqual({ kind: 'transaction', transactionId: 'a', account: null, foundItemId: 'kvitto' })
    expect(bookingWalk(rows, 'found')).toEqual(['a'])
  })

  it('leaves an invoice found for a row to Inkommande', () => {
    expect(invoiceRow.foundKind).toBe('supplier_invoice')
    expect(opensInBookingScreen(invoiceRow)).toBe(false)
  })

  it('opens a row without a found document with nothing held', () => {
    const [plain] = buildToBookRows([bank({ id: 'b' })], [])
    expect(toBookScreenSubject(plain)).toEqual({ kind: 'transaction', transactionId: 'b', account: null })
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

describe('readAllToBookBankRows', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

  /**
   * GET /api/transactions?unmatched=true as the route answers it: newest
   * first, then id; at most 500 rows; has_more and next when more follow,
   * and after_date/after_id continuing after the row they name.
   */
  const route = (open: ToBookBankRow[]) => {
    const ordered = [...open].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? 1 : -1))
    return vi.fn(async (after: ToBookBankCursor | null): Promise<ToBookBankPage> => {
      const rest = after
        ? ordered.filter((r) => r.date < after.after_date || (r.date === after.after_date && r.id > after.after_id))
        : ordered
      const data = rest.slice(0, 500)
      const hasMore = rest.length > 500
      const last = data[data.length - 1]
      return { data, has_more: hasMore, next: hasMore ? { after_date: last.date, after_id: last.id } : null }
    })
  }

  /** 509 open rows, the oldest 60 on one day, as the company that uses the list today holds them (crm#2163). */
  const realCase = (): ToBookBankRow[] =>
    Array.from({ length: 509 }, (_, i) =>
      bank({ id: uuid(i), date: i < 60 ? '2026-10-29' : `2026-11-${String(1 + (i % 23)).padStart(2, '0')}` }),
    )

  it('reads every open row past the 500 one answer holds, so the list and its counts hold all 509 (crm#2163)', async () => {
    const open = realCase()
    const readPage = route(open)

    const rows = await readAllToBookBankRows(readPage)

    expect(rows).toHaveLength(509)
    expect(new Set(rows.map((r) => r.id)).size).toBe(509)
    expect(toBookCounts(buildToBookRows(rows, []))).toMatchObject({ all: 509, missing: 509 })
    // The second page starts after the first page's last row, inside the oldest day.
    expect(readPage).toHaveBeenCalledTimes(2)
    expect(readPage.mock.calls[0][0]).toBeNull()
    expect(readPage.mock.calls[1][0]).toEqual({ after_date: '2026-10-29', after_id: rows[499].id })
  })

  it('keeps the route order across pages when every row has the same date', async () => {
    const open = Array.from({ length: 1203 }, (_, i) => bank({ id: uuid(1202 - i), date: '2026-11-02' }))
    const readPage = route(open)

    const rows = await readAllToBookBankRows(readPage)

    expect(readPage).toHaveBeenCalledTimes(3)
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 1203 }, (_, i) => uuid(i)))
  })

  it('asks once when one answer holds every row', async () => {
    const readPage = route([bank({ id: uuid(1) }), bank({ id: uuid(2) })])

    expect(await readAllToBookBankRows(readPage)).toHaveLength(2)
    expect(readPage).toHaveBeenCalledTimes(1)
  })

  it('fails, never loops or repeats rows, on an answer with more but no next, or a next that does not move', async () => {
    const noNext = vi.fn(async (): Promise<ToBookBankPage> => ({ data: [bank()], has_more: true, next: null }))
    await expect(readAllToBookBankRows(noNext)).rejects.toThrow('no next page')
    expect(noNext).toHaveBeenCalledTimes(1)

    // A route that ignores the cursor answers the first page again.
    const stuck = vi.fn(async (): Promise<ToBookBankPage> => ({
      data: [bank()],
      has_more: true,
      next: { after_date: '2026-11-18', after_id: 'tx-1' },
    }))
    await expect(readAllToBookBankRows(stuck)).rejects.toThrow('no next page')
    expect(stuck).toHaveBeenCalledTimes(2)
  })

  it('fails the whole read when a later page fails, so a partial list is never shown as the whole', async () => {
    const pages = route(realCase())
    const readPage = vi.fn(async (after: ToBookBankCursor | null) => {
      if (after) throw new Error('HTTP 500')
      return pages(after)
    })

    await expect(readAllToBookBankRows(readPage)).rejects.toThrow('HTTP 500')
  })
})

describe('toBookDoor', () => {
  it('leads every "book these" link to Att bokföra with the booking screen, else where it led', () => {
    expect(toBookDoor(true, '/transactions?view=inbox')).toBe('/att-bokfora')
    expect(toBookDoor(false, '/transactions?view=inbox')).toBe('/transactions?view=inbox')
  })
})

describe('skattekonto events', () => {
  const rows = buildToBookRows(
    [bank({ id: 'a', date: '2026-11-20' })],
    [],
    [
      { id: 'skv-1', date: '2026-11-12', text: 'Inbetalning bokförd 261112', amount: 25000 },
      { id: 'skv-2', date: '2026-11-21', text: 'Debiterad preliminärskatt', amount: -4521 },
    ],
  )
  const skv = rows.filter((r) => r.kind === 'skattekonto')

  it('are rows of the one list, newest first among the rest, with Skatteverket as underlag', () => {
    expect(rows.map((r) => r.key)).toEqual(['skv:skv-2', 'tx:a', 'skv:skv-1'])
    expect(skv[0]).toMatchObject({ skattekontoId: 'skv-2', transactionId: null, underlag: 'skatteverket', currency: 'SEK' })
  })

  it('have a filter of their own and never count as missing underlag', () => {
    expect(toBookCounts(rows)).toMatchObject({ all: 3, missing: 1, skattekonto: 2 })
    expect(toBookFilterFromSlug('skattekonto')).toBe('skattekonto')
    expect(toBookListHref('skattekonto')).toBe('/att-bokfora?visa=skattekonto')
  })

  it('open their own booking dialog, not the booking screen, and are not stepped through', () => {
    expect(skv.some(opensInBookingScreen)).toBe(false)
    expect(bookingWalk(rows, 'all')).toEqual(['a'])
  })

  it('write money into the skattekonto with a plus', () => {
    expect(toBookAmountLabel(skv[1])).toBe('+25\u00a0000')
    expect(toBookIsMoneyIn(skv[0])).toBe(false)
  })
})

describe('toBookReturnPath', () => {
  it('keeps a return address to the list, with its filter', () => {
    expect(toBookReturnPath('/att-bokfora')).toBe('/att-bokfora')
    expect(toBookReturnPath('/att-bokfora?visa=utan-bankrad')).toBe('/att-bokfora?visa=utan-bankrad')
  })

  it('refuses any other address', () => {
    expect(toBookReturnPath('/transactions')).toBeNull()
    expect(toBookReturnPath('https://evil.example/att-bokfora')).toBeNull()
    expect(toBookReturnPath('//evil.example')).toBeNull()
    expect(toBookReturnPath(null)).toBeNull()
  })
})
