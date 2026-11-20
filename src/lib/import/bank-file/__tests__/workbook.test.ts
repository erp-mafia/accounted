import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { decodeBankFile, isWorkbookFile, workbookToText } from '../workbook'
import { detectFileFormat, parseBankFile } from '../parser'

/** Excel's day number for a calendar date (the 1900 system). */
function excelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
}

type Cell = string | number | { date: string; format?: string } | null

/** A sheet built cell by cell: dates as Excel stores them, a day number plus a date format. */
function sheetFrom(rows: Cell[][]): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {}
  let maxCol = 0
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value === null || value === '') return
      const address = XLSX.utils.encode_cell({ r, c })
      if (typeof value === 'number') sheet[address] = { t: 'n', v: value }
      else if (typeof value === 'string') sheet[address] = { t: 's', v: value }
      else sheet[address] = { t: 'n', v: excelSerial(value.date), z: value.format ?? 'yyyy-mm-dd' }
      maxCol = Math.max(maxCol, c)
    }),
  )
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxCol } })
  return sheet
}

function workbookBytes(rows: Cell[][], bookType: XLSX.BookType): ArrayBuffer {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheetFrom(rows), 'Kontoutdrag')
  return XLSX.write(workbook, { bookType, type: 'array' }) as ArrayBuffer
}

function textBytes(text: string, encoding: 'utf-8' | 'windows-1252' = 'utf-8'): ArrayBuffer {
  if (encoding === 'utf-8') return new TextEncoder().encode(text).buffer as ArrayBuffer
  // Windows-1252 covers åäöÅÄÖé at their Latin-1 code points.
  return Uint8Array.from([...text].map((ch) => ch.charCodeAt(0))).buffer
}

// A month's kontoutdrag laid out the way the issue describes it (crm#1236):
// the month as a heading row above the column header. Synthetic rows only.
const MONTH_STATEMENT: Cell[][] = [
  ['Kontoutdrag oktober 2025'],
  [],
  ['Bokföringsdag', 'Transaktionsdag', 'Transaktionstyp', 'Meddelande', 'Belopp', 'Saldo'],
  [{ date: '2025-10-03' }, { date: '2025-10-01' }, 'Kortköp', 'ICA NÄRA TESTBY', -1234.5, 18765.5],
  [{ date: '2025-10-06' }, { date: '2025-10-06' }, 'Insättning', 'Kund AB faktura 1001', 25000, 43765.5],
  [{ date: '2025-10-15' }, { date: '2025-10-15' }, 'Bankgirobetalning', 'Leverantör AB', -500, 43265.5],
]

describe('isWorkbookFile', () => {
  it('reads binary Excel content as a workbook whatever its name', () => {
    expect(isWorkbookFile(workbookBytes(MONTH_STATEMENT, 'biff8'), 'export.xls')).toBe(true)
    expect(isWorkbookFile(workbookBytes(MONTH_STATEMENT, 'xlsx'), 'export.xlsx')).toBe(true)
    expect(isWorkbookFile(workbookBytes(MONTH_STATEMENT, 'xlsx'), 'export.csv')).toBe(true)
  })

  it('reads an HTML table named .xls as a workbook', () => {
    expect(isWorkbookFile(textBytes('<html><table><tr><td>a</td></tr></table></html>'), 'konto.xls')).toBe(true)
  })

  it('keeps text as text, even a text file named .xls', () => {
    expect(isWorkbookFile(textBytes('Datum;Text;Belopp\n'), 'konto.csv')).toBe(false)
    expect(isWorkbookFile(textBytes('Datum\tText\tBelopp\n'), 'konto.xls')).toBe(false)
  })
})

describe('workbookToText', () => {
  it.each(['biff8', 'xlsx'] as const)('writes a %s sheet as semicolon text with ISO dates and decimal commas', async (bookType) => {
    const text = await workbookToText(workbookBytes(MONTH_STATEMENT, bookType), `oktober.${bookType === 'biff8' ? 'xls' : 'xlsx'}`)
    const lines = text.split('\n')
    expect(lines[0]).toBe('Kontoutdrag oktober 2025')
    expect(lines[1]).toBe('Bokföringsdag;Transaktionsdag;Transaktionstyp;Meddelande;Belopp;Saldo')
    expect(lines[2]).toBe('2025-10-03;2025-10-01;Kortköp;ICA NÄRA TESTBY;-1234,5;18765,5')
    expect(lines).toHaveLength(5) // the empty spreadsheet row is dropped
  })

  it("reads a date in Excel's default short format as the date, not the US display text", async () => {
    const rows: Cell[][] = [
      ['Bokföringsdag', 'Transaktionsdag', 'Text', 'Belopp'],
      [{ date: '2025-10-03', format: 'm/d/yy' }, { date: '2025-10-02', format: 'm/d/yy' }, 'SPOTIFY', -99],
    ]
    const text = await workbookToText(workbookBytes(rows, 'xlsx'), 'kontoutdrag.xlsx')
    expect(text.split('\n')[1]).toBe('2025-10-03;2025-10-02;SPOTIFY;-99')
  })

  it('quotes a cell holding a semicolon and flattens line breaks', async () => {
    const rows: Cell[][] = [
      ['Bokföringsdag', 'Transaktionsdag', 'Text', 'Belopp'],
      [{ date: '2025-10-03' }, { date: '2025-10-03' }, 'Faktura 12; rad\nett', -10],
    ]
    const text = await workbookToText(workbookBytes(rows, 'xlsx'), 'k.xlsx')
    expect(text.split('\n')[1]).toBe('2025-10-03;2025-10-03;"Faktura 12; rad ett";-10')
  })

  it('reads a Windows-1252 HTML table saved as .xls, keeping its text as written', async () => {
    const html =
      '<html><head><meta charset="windows-1252"></head><body><table>' +
      '<tr><td>Kontoutdrag oktober 2025</td></tr>' +
      '<tr><td>Bokföringsdag</td><td>Transaktionsdag</td><td>Meddelande</td><td>Belopp</td></tr>' +
      '<tr><td>2025-10-03</td><td>2025-10-01</td><td>Café Åkerö</td><td>-1 234,50</td></tr>' +
      '</table></body></html>'
    const text = await workbookToText(textBytes(html, 'windows-1252'), 'oktober.xls')
    const lines = text.split('\n')
    expect(lines[1]).toBe('Bokföringsdag;Transaktionsdag;Meddelande;Belopp')
    expect(lines[2]).toBe('2025-10-03;2025-10-01;Café Åkerö;-1 234,50')
  })
})

describe('decodeBankFile into the Länsförsäkringar parser (crm#1236)', () => {
  it.each(['biff8', 'xlsx'] as const)('imports the monthly %s kontoutdrag with its month heading', async (bookType) => {
    const filename = bookType === 'biff8' ? 'Kontoutdrag 2025-10.xls' : 'Kontoutdrag 2025-10.xlsx'
    const { content, workbook } = await decodeBankFile(workbookBytes(MONTH_STATEMENT, bookType), filename)
    expect(workbook).toBe(true)
    expect(detectFileFormat(content, filename)?.id).toBe('lansforsakringar')

    const result = parseBankFile(content, filename)
    expect(result.format).toBe('lansforsakringar')
    expect(result.issues).toEqual([])
    expect(result.transactions.map((t) => [t.date, t.description, t.amount, t.balance])).toEqual([
      // The booking date (Bokföringsdag), not the card swipe date.
      ['2025-10-03', 'ICA NÄRA TESTBY', -1234.5, 18765.5],
      ['2025-10-06', 'Kund AB faktura 1001', 25000, 43765.5],
      ['2025-10-15', 'Leverantör AB', -500, 43265.5],
    ])
    expect(result.date_from).toBe('2025-10-03')
    expect(result.date_to).toBe('2025-10-15')
  })

  it('decodes a text file as before', async () => {
    const csv = '"Datum";"Bokföringsdag";"Typ";"Text";"Belopp"\n"2024-01-15";"2024-01-15";"Kortköp";"SPOTIFY";"-99,00"'
    const { content, workbook } = await decodeBankFile(textBytes(csv), 'lf.csv')
    expect(workbook).toBe(false)
    expect(parseBankFile(content, 'lf.csv').transactions).toHaveLength(1)
  })
})
