import { describe, it, expect } from 'vitest'
import {
  LEDGER_ROW_ORDER,
  arrangeLedgerRows,
  isLedgerRowOrder,
  ledgerBalanceRuns,
  ledgerRowSortToken,
  matchesLedgerRowSearch,
  parseLedgerRowSort,
  type LedgerRow,
} from '../general-ledger-rows'

interface Row extends LedgerRow {
  balance: number
}

// One account in ledger order (date, verifikat number), balances from 1 000.
function row(
  date: string,
  voucher: string,
  description: string,
  debit: number,
  credit: number,
  balance: number,
): Row {
  return {
    date,
    voucher_series: voucher[0],
    voucher_number: Number(voucher.slice(1)),
    description,
    debit,
    credit,
    balance,
  }
}

const ROWS: Row[] = [
  row('2026-01-05', 'A3', 'Kundbetalning', 12500, 0, 13500),
  row('2026-01-20', 'B1', 'Hyra januari', 0, 8000, 5500),
  row('2026-02-01', 'A7', 'Insättning', 300, 0, 5800),
  row('2026-02-01', 'A71', 'Bankavgift', 0, 45.5, 5754.5),
  row('2026-03-15', 'A72', 'Hyra mars', 0, 8000, -2245.5),
  row('2026-03-15', 'A80', 'Kundbetalning 12500', 20000, 0, 17754.5),
]

const labels = (rows: Row[]) => rows.map((r) => `${r.voucher_series}${r.voucher_number}`)

describe('parseLedgerRowSort', () => {
  it('reads a column and a direction, and writes them back', () => {
    for (const token of ['date_asc', 'date_desc', 'voucher_asc', 'voucher_desc', 'debit_asc', 'debit_desc', 'credit_asc', 'credit_desc']) {
      const sort = parseLedgerRowSort(token)
      expect(sort, token).not.toBeNull()
      expect(ledgerRowSortToken(sort!)).toBe(token)
    }
    expect(parseLedgerRowSort('date_desc')).toEqual({ column: 'date', ascending: false })
  })

  it('reads nothing else as a sort', () => {
    for (const token of [null, undefined, '', 'date', 'balance_asc', 'date_up', 'date_asc,voucher_asc', 'DATE_ASC']) {
      expect(parseLedgerRowSort(token), String(token)).toBeNull()
    }
  })
})

describe('isLedgerRowOrder', () => {
  it('is oldest first on the date, and nothing else', () => {
    expect(isLedgerRowOrder(LEDGER_ROW_ORDER)).toBe(true)
    expect(isLedgerRowOrder({ column: 'date', ascending: true })).toBe(true)
    expect(isLedgerRowOrder({ column: 'date', ascending: false })).toBe(false)
    expect(isLedgerRowOrder({ column: 'voucher', ascending: true })).toBe(false)
  })
})

describe('arrangeLedgerRows', () => {
  it('leaves the rows as they are in ledger order without a search', () => {
    const { rows, matched } = arrangeLedgerRows(ROWS, {})
    expect(rows).toEqual(ROWS)
    expect(matched).toBeNull()
    expect(arrangeLedgerRows(ROWS, { sort: LEDGER_ROW_ORDER, search: '  ' }).rows).toEqual(ROWS)
  })

  it('never changes a row: every arrangement holds the same rows with the same numbers', () => {
    for (const token of ['date_desc', 'voucher_asc', 'voucher_desc', 'debit_asc', 'debit_desc', 'credit_asc', 'credit_desc']) {
      const { rows } = arrangeLedgerRows(ROWS, { sort: parseLedgerRowSort(token) })
      expect(rows, token).toHaveLength(ROWS.length)
      for (const original of ROWS) expect(rows, token).toContain(original)
    }
  })

  it('shows newest first as ledger order backwards, so each row keeps the balance after it', () => {
    const { rows } = arrangeLedgerRows(ROWS, { sort: { column: 'date', ascending: false } })
    expect(labels(rows)).toEqual(['A80', 'A72', 'A71', 'A7', 'B1', 'A3'])
    expect(rows.map((r) => r.balance)).toEqual([17754.5, -2245.5, 5754.5, 5800, 5500, 13500])
  })

  it('sorts on the verifikat: series, then number as a number', () => {
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'voucher', ascending: true } }).rows)).toEqual([
      'A3', 'A7', 'A71', 'A72', 'A80', 'B1',
    ])
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'voucher', ascending: false } }).rows)).toEqual([
      'B1', 'A80', 'A72', 'A71', 'A7', 'A3',
    ])
  })

  it('sorts on one side, with the rows that have nothing on it last in both directions', () => {
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'debit', ascending: false } }).rows)).toEqual([
      'A80', 'A3', 'A7', 'B1', 'A71', 'A72',
    ])
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'debit', ascending: true } }).rows)).toEqual([
      'A7', 'A3', 'A80', 'B1', 'A71', 'A72',
    ])
    // Equal amounts keep their ledger order (B1 before A72).
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'credit', ascending: false } }).rows)).toEqual([
      'B1', 'A72', 'A71', 'A3', 'A7', 'A80',
    ])
    expect(labels(arrangeLedgerRows(ROWS, { sort: { column: 'credit', ascending: true } }).rows)).toEqual([
      'A71', 'B1', 'A72', 'A3', 'A7', 'A80',
    ])
  })

  it('narrows to a verifikat label, exactly', () => {
    expect(labels(arrangeLedgerRows(ROWS, { search: 'A71' }).rows)).toEqual(['A71'])
    expect(labels(arrangeLedgerRows(ROWS, { search: 'a 7' }).rows)).toEqual(['A7'])
    expect(labels(arrangeLedgerRows(ROWS, { search: 'B-1' }).rows)).toEqual(['B1'])
  })

  it('narrows to the rows whose text holds the needle, whatever its case', () => {
    expect(labels(arrangeLedgerRows(ROWS, { search: 'HYRA' }).rows)).toEqual(['B1', 'A72'])
  })

  it('narrows to an amount on either side, next to the text match', () => {
    // A3 has the amount, A80 mentions it.
    expect(labels(arrangeLedgerRows(ROWS, { search: '12500' }).rows)).toEqual(['A3', 'A80'])
    expect(labels(arrangeLedgerRows(ROWS, { search: '12 500 kr' }).rows)).toEqual(['A3'])
    expect(labels(arrangeLedgerRows(ROWS, { search: '8 000' }).rows)).toEqual(['B1', 'A72'])
    expect(labels(arrangeLedgerRows(ROWS, { search: '45,50' }).rows)).toEqual(['A71'])
    // The amount is exact: 800 is not 8 000, and a balance is not an amount.
    expect(arrangeLedgerRows(ROWS, { search: '800' }).rows).toEqual([])
    expect(arrangeLedgerRows(ROWS, { search: '5 500' }).rows).toEqual([])
  })

  it('narrows to a bokföringsdatum or a month', () => {
    expect(labels(arrangeLedgerRows(ROWS, { search: '2026-02-01' }).rows)).toEqual(['A7', 'A71'])
    expect(labels(arrangeLedgerRows(ROWS, { search: '2026-03' }).rows)).toEqual(['A72', 'A80'])
  })

  it('sums what the search found, and sorts it like any rows', () => {
    const { rows, matched } = arrangeLedgerRows(ROWS, { search: 'hyra', sort: { column: 'date', ascending: false } })
    expect(labels(rows)).toEqual(['A72', 'B1'])
    expect(matched).toEqual({ debit: 0, credit: 16000 })
    expect(arrangeLedgerRows(ROWS, { search: 'kundbetalning' }).matched).toEqual({ debit: 32500, credit: 0 })
  })

  it('answers no rows and zero sums when nothing matches', () => {
    expect(arrangeLedgerRows(ROWS, { search: 'finns inte' })).toEqual({ rows: [], matched: { debit: 0, credit: 0 } })
  })

  it('does not reorder the rows it was given', () => {
    const before = [...ROWS]
    arrangeLedgerRows(ROWS, { sort: { column: 'debit', ascending: false }, search: 'a' })
    expect(ROWS).toEqual(before)
  })
})

// Rows that tie: A12 books the account twice (a debit line, then a credit
// line) and A13 follows on the same day with the amount of A12's first line.
// In ledger order, balances from 1 000.
const TIES: Row[] = [
  row('2026-04-01', 'A11', 'Dagen före', 100, 0, 1100),
  row('2026-04-02', 'A12', 'Första raden', 500, 0, 1600),
  row('2026-04-02', 'A12', 'Andra raden', 0, 200, 1400),
  row('2026-04-02', 'A13', 'Samma belopp', 500, 0, 1900),
]

const texts = (rows: Row[]) => rows.map((r) => r.description)

describe('arrangeLedgerRows: rows that tie', () => {
  it('keeps the lines of one verifikat in ledger order whichever way the verifikat run', () => {
    expect(texts(arrangeLedgerRows(TIES, { sort: { column: 'voucher', ascending: true } }).rows)).toEqual([
      'Dagen före', 'Första raden', 'Andra raden', 'Samma belopp',
    ])
    expect(texts(arrangeLedgerRows(TIES, { sort: { column: 'voucher', ascending: false } }).rows)).toEqual([
      'Samma belopp', 'Första raden', 'Andra raden', 'Dagen före',
    ])
  })

  it('keeps equal amounts in ledger order whichever way the amounts run', () => {
    expect(texts(arrangeLedgerRows(TIES, { sort: { column: 'debit', ascending: false } }).rows)).toEqual([
      'Första raden', 'Samma belopp', 'Dagen före', 'Andra raden',
    ])
    expect(texts(arrangeLedgerRows(TIES, { sort: { column: 'debit', ascending: true } }).rows)).toEqual([
      'Dagen före', 'Första raden', 'Samma belopp', 'Andra raden',
    ])
  })

  it('turns ties around with everything else when the newest comes first, so the balance reads backwards without a break', () => {
    const { rows } = arrangeLedgerRows(TIES, { sort: { column: 'date', ascending: false } })
    expect(texts(rows)).toEqual(['Samma belopp', 'Andra raden', 'Första raden', 'Dagen före'])
    // A row's balance, less what the row itself moved, is the balance of the
    // row under it: only the exact reverse of ledger order reads that way.
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].balance - rows[i].debit + rows[i].credit, rows[i].description).toBe(rows[i + 1].balance)
    }
  })
})

describe('matchesLedgerRowSearch', () => {
  it('reads the needle as the verifikat list does', () => {
    const line = ROWS[3]
    expect(matchesLedgerRowSearch(line, 'A71')).toBe(true)
    expect(matchesLedgerRowSearch(line, '45,5')).toBe(true)
    expect(matchesLedgerRowSearch(line, '2026-02')).toBe(true)
    expect(matchesLedgerRowSearch(line, 'avgift')).toBe(true)
    expect(matchesLedgerRowSearch(line, 'A72')).toBe(false)
    expect(matchesLedgerRowSearch(line, '2026-03')).toBe(false)
  })
})

describe('ledgerBalanceRuns', () => {
  it('holds in date order, both directions, with every row present', () => {
    expect(ledgerBalanceRuns({ column: 'date', ascending: true }, '')).toBe(true)
    expect(ledgerBalanceRuns({ column: 'date', ascending: false }, null)).toBe(true)
    expect(ledgerBalanceRuns({ column: 'date', ascending: false }, '  ')).toBe(true)
  })

  it('does not hold on another order, or under a search', () => {
    expect(ledgerBalanceRuns({ column: 'voucher', ascending: true }, '')).toBe(false)
    expect(ledgerBalanceRuns({ column: 'debit', ascending: false }, '')).toBe(false)
    expect(ledgerBalanceRuns({ column: 'date', ascending: true }, 'hyra')).toBe(false)
  })
})
