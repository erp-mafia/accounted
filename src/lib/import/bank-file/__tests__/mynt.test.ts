/**
 * Mynt's card export in the shapes Mynt hands out: the CSV of a report
 * downloaded under Bokföring & Export, the same report as an Excel file, and
 * the older export whose first column is Date. The columns are the ones Mynt
 * lists for its export. Synthetic rows only.
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { detectFileFormat, parseBankFile, unreadRows } from '../parser'
import { decodeBankFile } from '../workbook'
import { cardStatementPrintsPurchasesAsPlus } from '../card-statement'
import { myntFormat } from '../formats/mynt'
import { lansforsakringarFormat } from '../formats/lansforsakringar'
import { formatAmount } from '@/lib/utils'

const HEADER = [
  'Transaction date', 'Settlement date', 'Amount', 'Currency', 'Original amount', 'Original currency',
  'VAT amount', 'VAT rate', 'Reverse VAT', 'Description', 'Account', 'Category', 'Comment', 'Filename',
  'Settlement status', 'Person', 'Team', 'Card number', 'Card name', 'Accounting status', 'Cost center',
  'Project', 'Type', 'VAT code', 'Cost center ID', 'Export date override',
]

type Row = {
  date: string
  settled?: string
  amount: string
  currency?: string
  original?: string
  originalCurrency?: string
  description: string
  category?: string
  comment?: string
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(row: Row): string {
  const cells: Record<string, string> = {
    'Transaction date': row.date,
    'Settlement date': row.settled ?? row.date,
    Amount: row.amount,
    Currency: row.currency ?? 'SEK',
    'Original amount': row.original ?? '',
    'Original currency': row.originalCurrency ?? '',
    'VAT amount': '',
    'VAT rate': '25%',
    'Reverse VAT': 'No',
    Description: row.description,
    Account: '5410',
    Category: row.category ?? 'Förbrukningsinventarier',
    Comment: row.comment ?? '',
    Filename: '',
    'Settlement status': 'Settled',
    Person: 'Test Person',
    Team: '',
    'Card number': '**** 4190',
    'Card name': 'Testkort',
    'Accounting status': 'Ready',
  }
  return HEADER.map((name) => csvCell(cells[name] ?? '')).join(',')
}

const ROWS: Row[] = [
  { date: '2026-10-02', amount: '-436.65', description: 'Kafé Test, Stockholm', comment: 'Fika med kund' },
  { date: '2026-10-05', settled: '2026-10-07', amount: '-1129.04', original: '-99.00', originalCurrency: 'EUR', description: 'Testhotell Berlin' },
  { date: '2026-10-09', amount: '120.00', description: 'Kafé Test, Stockholm', comment: 'Återbetalning' },
  { date: '2026-10-10', amount: '5000', description: '', category: 'Top up' },
]

const CSV = [HEADER.join(','), ...ROWS.map(csvRow)].join('\r\n')

const rowsOf = (content: string, filename = 'mynt.csv') =>
  parseBankFile(content, filename).transactions.map((t) => [t.date, t.description, t.amount, t.currency])

describe('Mynt: the CSV of a Bokföring & Export report', () => {
  it('is recognized without a column mapping', () => {
    expect(detectFileFormat(CSV, 'rapport.csv')?.id).toBe('mynt')
  })

  it('is recognized ahead of Länsförsäkringar, whose header-less check would read Original amount as the amount', () => {
    // Two dates first and an amount in the fifth column: the foreign purchase
    // in the second row is what a header-less Länsförsäkringar row looks like.
    expect(lansforsakringarFormat.detect(CSV, 'rapport.csv')).toBe(true)
    const misread = lansforsakringarFormat.parse(CSV).transactions.map((t) => t.amount)
    expect(misread).toContain(-99)
    expect(detectFileFormat(CSV, 'rapport.csv')?.id).toBe('mynt')
  })

  it('reads each row on its purchase day, in the account currency, signed from the account', () => {
    const result = parseBankFile(CSV, 'rapport.csv')
    expect(result.format).toBe('mynt')
    expect(result.issues).toEqual([])
    expect(rowsOf(CSV)).toEqual([
      ['2026-10-02', 'Kafé Test, Stockholm - Fika med kund', -436.65, 'SEK'],
      ['2026-10-05', `Testhotell Berlin - ${formatAmount(99)} EUR`, -1129.04, 'SEK'],
      ['2026-10-09', 'Kafé Test, Stockholm - Återbetalning', 120, 'SEK'],
      ['2026-10-10', 'Top up', 5000, 'SEK'],
    ])
    expect(result.transactions.map((t) => t.counterparty)).toEqual([
      'Kafé Test, Stockholm',
      'Testhotell Berlin',
      'Kafé Test, Stockholm',
      null,
    ])
    expect(result.date_from).toBe('2026-10-02')
    expect(result.date_to).toBe('2026-10-10')
    expect(result.stats).toEqual({
      total_rows: 4,
      parsed_rows: 4,
      skipped_rows: 0,
      total_income: 5120,
      total_expenses: -1565.69,
    })
  })

  it('needs no sign flip on a company card: purchases already read as money out', () => {
    const { transactions } = parseBankFile(CSV, 'rapport.csv')
    expect(cardStatementPrintsPurchasesAsPlus(transactions)).toBe(false)
  })

  it('keeps a comment that runs over two lines inside its row', () => {
    const content = [
      HEADER.join(','),
      csvRow({ date: '2026-10-02', amount: '-89.00', description: 'Bokhandeln Test', comment: 'Pärmar\noch pennor' }),
      csvRow({ date: '2026-10-03', amount: '-45.50', description: 'Parkering Test' }),
    ].join('\n')
    const result = parseBankFile(content, 'rapport.csv')
    expect(result.issues).toEqual([])
    expect(rowsOf(content)).toEqual([
      ['2026-10-02', 'Bokhandeln Test - Pärmar och pennor', -89, 'SEK'],
      ['2026-10-03', 'Parkering Test', -45.5, 'SEK'],
    ])
  })

  it('reads a CSV saved again by a Swedish spreadsheet: semicolons and a decimal comma', () => {
    const swedish = [
      HEADER.join(';'),
      '2026-10-02;2026-10-02;-436,65;SEK;;;;25%;No;Kafé Test;5410;Fika;;;Settled;Test Person;;**** 4190;Testkort;Ready;;;;;;',
      '2026-10-09;2026-10-09;1 120,00;SEK;;;;25%;No;Kafé Test;5410;Fika;;;Settled;Test Person;;**** 4190;Testkort;Ready;;;;;;',
    ].join('\n')
    expect(detectFileFormat(swedish, 'rapport.csv')?.id).toBe('mynt')
    expect(rowsOf(swedish)).toEqual([
      ['2026-10-02', 'Kafé Test', -436.65, 'SEK'],
      ['2026-10-09', 'Kafé Test', 1120, 'SEK'],
    ])
  })

  it('reads the older export whose first column is Date', () => {
    const older = [
      'Date,Amount,Currency,Original amount,Original currency,VAT amount,VAT rate,Reverse VAT,Description,Account,Category,Comment,Filename,Settlement status,Person,Team,Card number,Card name,Accounting status',
      '2025-03-14,-249.00,SEK,,,49.80,25%,No,Kontorsvaror Test,6110,Kontor,,kvitto.pdf,Settled,Test Person,,**** 4190,Testkort,Exported',
    ].join('\r\n')
    expect(detectFileFormat(older, 'mynt.csv')?.id).toBe('mynt')
    expect(rowsOf(older)).toEqual([['2025-03-14', 'Kontorsvaror Test', -249, 'SEK']])
  })

  it('takes the settlement date only when the transaction date is empty', () => {
    const content = [HEADER.join(','), csvRow({ date: '', settled: '2026-10-08', amount: '-10.00', description: 'Avgift Test' })].join('\n')
    expect(rowsOf(content)).toEqual([['2026-10-08', 'Avgift Test', -10, 'SEK']])
  })

  it('keeps the account currency of a euro account', () => {
    const content = [HEADER.join(','), csvRow({ date: '2026-10-02', amount: '-12.50', currency: 'EUR', description: 'Café Test Paris' })].join('\n')
    expect(rowsOf(content)).toEqual([['2026-10-02', 'Café Test Paris', -12.5, 'EUR']])
  })
})

describe('Mynt: the same report downloaded as Excel', () => {
  function workbook(rows: (string | number)[][]): ArrayBuffer {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Report')
    return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  }

  it('is recognized and read with the amounts the sheet holds, a title row above the header', async () => {
    const bytes = workbook([
      ['Mynt rapport oktober 2026'],
      HEADER,
      ['2026-10-02', '2026-10-02', -436.65, 'SEK', '', '', 0, '25%', 'No', 'Kafé Test', '5410', 'Fika', '', '', 'Settled', 'Test Person', '', '**** 4190', 'Testkort', 'Ready'],
      ['2026-10-05', '2026-10-07', -1129.04, 'SEK', -99, 'EUR', 0, '', 'No', 'Testhotell Berlin', '5800', 'Resor', '', '', 'Settled', 'Test Person', '', '**** 4190', 'Testkort', 'Ready'],
    ])
    const { content } = await decodeBankFile(bytes, 'rapport.xlsx')
    expect(detectFileFormat(content, 'rapport.xlsx')?.id).toBe('mynt')
    expect(rowsOf(content, 'rapport.xlsx')).toEqual([
      ['2026-10-02', 'Kafé Test', -436.65, 'SEK'],
      ['2026-10-05', `Testhotell Berlin - ${formatAmount(99)} EUR`, -1129.04, 'SEK'],
    ])
  })
})

describe('Mynt: what is not imported', () => {
  it('refuses a file that stops inside a quoted field, so no row of a cut download lands', () => {
    const cut = `${HEADER.join(',')}\n${csvRow({ date: '2026-10-02', amount: '-10.00', description: 'Test' })}\n2026-10-03,2026-10-03,-20.00,SEK,,,,,No,"Butik Test`
    const result = parseBankFile(cut, 'rapport.csv')
    expect(result.format).toBe('mynt')
    expect(result.transactions).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ row: 0, severity: 'error' })
  })

  it('names a row it cannot read, and leaves a zero row out without calling it unread', () => {
    const content = [
      HEADER.join(','),
      csvRow({ date: '2026-13-40', amount: '-10.00', description: 'Fel datum' }),
      csvRow({ date: '2026-10-03', amount: 'abc', description: 'Fel belopp' }),
      csvRow({ date: '2026-10-04', amount: '0.00', description: 'Kortkontroll' }),
      csvRow({ date: '2026-10-05', amount: '-30.00', description: 'Butik Test' }),
    ].join('\n')
    const result = parseBankFile(content, 'rapport.csv')
    expect(rowsOf(content)).toEqual([['2026-10-05', 'Butik Test', -30, 'SEK']])
    expect(unreadRows(result).map((issue) => issue.row)).toEqual([2, 3])
    expect(result.issues.find((issue) => issue.row === 4)?.severity).toBe('info')
    expect(result.stats).toMatchObject({ total_rows: 4, parsed_rows: 1, skipped_rows: 3 })
  })

  it('answers a file chosen as Mynt that is not one with the columns it has', () => {
    const lunar = 'Date,Time,Title,Amount,Balance\n2026-10-02,10:00,Test,"-10,00","100,00"'
    const result = parseBankFile(lunar, 'fil.csv', 'mynt')
    expect(result.format).toBe('lunar')
    const other = 'Datum,Text,Summa\n2026-10-02,Test,-10'
    const refused = parseBankFile(other, 'fil.csv', 'mynt')
    expect(refused.transactions).toEqual([])
    expect(refused.unrecognized_columns?.found).toEqual(['Datum', 'Text', 'Summa'])
    expect(refused.unrecognized_columns?.expected.date).toEqual(['Transaction date', 'Date'])
  })

  it('does not claim another export that also has Date, Amount, Currency and Description', () => {
    const wise = 'TransferWise ID,Date,Amount,Currency,Description,Running Balance,Total fees\nTRANSFER-1,02-10-2026,-10.00,SEK,Test,90.00,0.00'
    const lunar = 'Date,Time,Title,Amount,Balance\n2026-10-02,10:00,Test,"-10,00","100,00"'
    expect(myntFormat.detect(wise, 'statement.csv')).toBe(false)
    expect(myntFormat.detect(lunar, 'lunar.csv')).toBe(false)
  })
})
