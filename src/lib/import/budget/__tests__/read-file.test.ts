/**
 * Reading a budget file (accounted#134, part 2): SIE #PBUDGET rows and
 * spreadsheets in the long and the wide layout, as the file has them.
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { BudgetFileError, parseMonthCell, parseMonthText, readSieBudget, readSpreadsheetBudget } from '../read-file'
import { readBestSheetValues } from '@/lib/import/shared/workbook-reader'

describe('parseMonthText', () => {
  it.each([
    ['2027-01', '2027-01', '01'],
    ['202701', '2027-01', '01'],
    ['2027/3', '2027-03', '03'],
    ['2027-12-01', '2027-12', '12'],
    ['jan', null, '01'],
    ['Januari 2027', '2027-01', '01'],
    ['Mar-2027', '2027-03', '03'],
    ['okt', null, '10'],
    ['May', null, '05'],
  ])('%s', (text, month, calendarMonth) => {
    expect(parseMonthText(text)).toEqual({ month, calendarMonth })
  })

  it.each(['', 'Totalt', '2027', '20271', '2027-13', 'Konto'])('%s is not a month', (text) => {
    expect(parseMonthText(text)).toBeNull()
  })

  it('reads a date cell\'s serial, and a number outside the serial range as text', () => {
    // 46388 is 2027-01-01 in Excel's calendar.
    expect(parseMonthCell(46388)).toEqual({ month: '2027-01', calendarMonth: '01' })
    expect(parseMonthCell(202703)).toEqual({ month: '2027-03', calendarMonth: '03' })
  })
})

describe('readSieBudget', () => {
  it('reads the #PBUDGET rows, the account names and the years', () => {
    const read = readSieBudget(
      [
        '#SIETYP 4',
        '#RAR 0 20270101 20271231',
        '#KONTO 3010 "Försäljning"',
        '#PBUDGET 0 202701 3010 {6 "H1"} -1000',
        '#PBUDGET 0 202702 3010 {} -2000',
      ].join('\n'),
    )
    expect(read.format).toBe('sie')
    expect(read.rows).toEqual([
      { account: '3010', month: '2027-01', calendarMonth: '01', dimensions: { '6': 'H1' }, amount: -1000, line: 4 },
      { account: '3010', month: '2027-02', calendarMonth: '02', dimensions: {}, amount: -2000, line: 5 },
    ])
    expect(read.accountNames.get('3010')).toBe('Försäljning')
    expect(read.years).toEqual([{ yearIndex: 0, start: '2027-01-01', end: '2027-12-31' }])
  })

  it('refuses a SIE file without a budget', () => {
    expect(() => readSieBudget('#SIETYP 4\n#RAR 0 20270101 20271231\n')).toThrow(BudgetFileError)
  })
})

describe('readSpreadsheetBudget', () => {
  it('reads the long layout: konto, månad, belopp, dim and kod', () => {
    const read = readSpreadsheetBudget([
      ['Budget 2027'],
      ['Konto', 'Kontonamn', 'Månad', 'Belopp', 'Dim', 'Kod'],
      ['3010', 'Försäljning', '2027-01', '100 000,00', '6', 'H1'],
      ['5010', 'Lokalhyra', '202702', '-12 500', '', ''],
      ['', 'Summa', '', '87 500', '', ''],
      ['5010', 'Lokalhyra', 'feb', '1', '', ''],
      ['5010', 'Lokalhyra', '2027-03', 'tusen', '', ''],
      ['5010', 'Lokalhyra', '2027-04', '0', '', ''],
    ])
    expect(read.format).toBe('long')
    expect(read.rows).toEqual([
      { account: '3010', month: '2027-01', calendarMonth: '01', dimensions: { '6': 'H1' }, amount: 100000, line: 3 },
      { account: '5010', month: '2027-02', calendarMonth: '02', dimensions: {}, amount: -12500, line: 4 },
    ])
    // A month without a year and an amount that is not a number are named, never read as zero.
    expect(read.unreadable).toEqual([
      { line: 6, reason: 'month' },
      { line: 7, reason: 'amount' },
    ])
    expect(read.accountNames.get('5010')).toBe('Lokalhyra')
  })

  it('reads the wide layout: konto and one column per month, with a projekt column', () => {
    const read = readSpreadsheetBudget([
      ['Konto', 'Projekt', 'jan', 'feb', 'mar', 'Totalt'],
      ['3010 Försäljning', 'H2', '1000', '', '3000', '4000'],
      ['4010', '', '-500', '-500', '-500', '-1500'],
    ])
    expect(read.format).toBe('wide')
    expect(read.rows).toEqual([
      { account: '3010', month: null, calendarMonth: '01', dimensions: { '6': 'H2' }, amount: 1000, line: 2 },
      { account: '3010', month: null, calendarMonth: '03', dimensions: { '6': 'H2' }, amount: 3000, line: 2 },
      { account: '4010', month: null, calendarMonth: '01', dimensions: {}, amount: -500, line: 3 },
      { account: '4010', month: null, calendarMonth: '02', dimensions: {}, amount: -500, line: 3 },
      { account: '4010', month: null, calendarMonth: '03', dimensions: {}, amount: -500, line: 3 },
    ])
    expect(read.accountNames.get('3010')).toBe('Försäljning')
  })

  it('tags a row with both a projekt and a kostnadsställe column', () => {
    const read = readSpreadsheetBudget([
      ['Konto', 'Projekt', 'Kostnadsställe', 'Månad', 'Belopp'],
      ['5010', 'H1', 'K1', '2027-01', '500'],
    ])
    expect(read.rows[0]!.dimensions).toEqual({ '6': 'H1', '1': 'K1' })
  })

  it('reads year-month headers in the wide layout', () => {
    const read = readSpreadsheetBudget([
      ['Kontonummer', '2027-07', '2027-08'],
      ['6110', '200', '300'],
    ])
    expect(read.rows.map((r) => r.month)).toEqual(['2027-07', '2027-08'])
  })

  it('refuses a sheet without a konto column, and a long sheet without månad and belopp', () => {
    expect(() => readSpreadsheetBudget([['Datum', 'Text', 'Belopp']])).toThrow(BudgetFileError)
    expect(() => readSpreadsheetBudget([['Konto', 'Text']])).toThrow(BudgetFileError)
  })

  it('reads a real xlsx by cell value, not its formatted text, and a semicolon CSV as written', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Konto', 'Månad', 'Belopp'],
      ['3010', '2027-01', -1000],
      ['5010', '2027-01', 12000],
    ])
    // SheetJS formats "#,##0" as "12,000" in any locale: read as text that
    // is 12,00 kr.
    sheet['C3']!.z = '#,##0'
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Budget')
    const xlsx = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const fromXlsx = readSpreadsheetBudget((await readBestSheetValues(xlsx, 'budget.xlsx')).rows)
    expect(fromXlsx.rows.map((r) => [r.account, r.month, r.amount])).toEqual([
      ['3010', '2027-01', -1000],
      ['5010', '2027-01', 12000],
    ])

    const csv = new TextEncoder().encode('Konto;Månad;Belopp\n5010;2027-02;"1 500,50"\n').buffer as ArrayBuffer
    const fromCsv = readSpreadsheetBudget((await readBestSheetValues(csv, 'budget.csv')).rows)
    expect(fromCsv.rows).toEqual([{ account: '5010', month: '2027-02', calendarMonth: '02', dimensions: {}, amount: 1500.5, line: 2 }])
  })

  it('reads a wide xlsx whose month headers are date cells', async () => {
    const sheet = XLSX.utils.aoa_to_sheet(
      [
        ['Konto', new Date(Date.UTC(2027, 0, 1)), new Date(Date.UTC(2027, 1, 1))],
        ['6110', 200, 300],
      ],
      { cellDates: true },
    )
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Budget')
    const xlsx = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const read = readSpreadsheetBudget((await readBestSheetValues(xlsx, 'budget.xlsx')).rows)
    expect(read.format).toBe('wide')
    expect(read.rows.map((r) => [r.month, r.amount])).toEqual([
      ['2027-01', 200],
      ['2027-02', 300],
    ])
  })
})
