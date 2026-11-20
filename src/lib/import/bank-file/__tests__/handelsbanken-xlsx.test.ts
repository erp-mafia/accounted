/**
 * Handelsbanken's Excel export of account transactions
 * (Handelsbanken_Account_Transactions_<date>.xlsx) answered 500
 * BANK_FILE_PARSE_FAILED for two companies on 2026-11-16 and 2026-11-17. The
 * files were not kept; the log showed a plain Error whose message the
 * redaction had removed whole, which a SheetJS "Bad compressed size: 693 !=
 * 1702240364" is (ten digits read like a personnummer). That is what SheetJS
 * throws for a zip written by a streaming writer: stored entries whose sizes
 * follow the data. The fixture is such a zip, holding the layout the bank's
 * CSV download and an open-source reader of the Excel export agree on.
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  HANDELSBANKEN_XLSX_ROWS,
  streamedXlsx,
  type XlsxCell,
} from '@/tests/fixtures/streamed-xlsx'
import { UnreadableWorkbookError } from '../../shared/workbook-reader'
import { decodeBankFile } from '../workbook'
import { detectFileFormat, parseBankFile } from '../parser'

const FILENAME = 'Handelsbanken_Account_Transactions_2026-11-16.xlsx'

/** The statement's rows as [date, text, amount, balance]. */
const EXPECTED_ROWS = [
  // Reskontradatum (the booking date), not the card swipe on the 14th.
  ['2026-11-16', 'KORTKÖP CLAS OHLSON', -199.5, 10234.75],
  // The Prel (preliminary) row is left out: the booked one comes later.
  ['2026-11-12', 'INSÄTTNING KUND AB', 12500, 10434.25],
  ['2026-11-03', 'BG LEVERANTÖR AB', -2065.75, -2065.75],
]

async function parseWorkbook(bytes: ArrayBuffer, filename = FILENAME) {
  const { content, workbook } = await decodeBankFile(bytes, filename)
  expect(workbook).toBe(true)
  return { content, result: parseBankFile(content, filename) }
}

function rowsOf(result: ReturnType<typeof parseBankFile>) {
  return result.transactions.map((t) => [t.date, t.description, t.amount, t.balance])
}

describe('a streamed zip (stored entries, sizes after the data)', () => {
  it('is what the xlsx reader cannot open on its own', () => {
    // The production failure, pinned: if an xlsx upgrade reads these files,
    // withCentralDirectorySizes may be removed.
    expect(() => XLSX.read(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }), { type: 'array' })).toThrow(
      /Bad compressed size/,
    )
  })

  it.each([
    { descriptorSignature: true },
    { descriptorSignature: false },
    // The common streamed shape, which the reader opened before: still opens.
    { deflate: true },
  ])('reads once the local headers carry the sizes (%o)', async (shape) => {
    const { content } = await parseWorkbook(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }, shape))
    expect(content.split('\n')).toEqual([
      'Kontotransaktioner',
      'Kontonummer;6789 123 456 789',
      'Period;2026-11-01 - 2026-11-16',
      'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
      '2026-11-16;2026-11-14;KORTKÖP CLAS OHLSON;-199,5;10234,75',
      '2026-11-13;2026-11-13;Prel KORTKÖP ICA NÄRA;-89;10434,25',
      '2026-11-12;2026-11-12;INSÄTTNING KUND AB;12500;10434,25',
      '2026-11-03;2026-11-02;BG LEVERANTÖR AB;-2065,75;-2065,75',
    ])
  })

  it('throws UnreadableWorkbookError for a workbook it cannot open', async () => {
    const whole = new Uint8Array(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }))
    const cut = whole.slice(0, Math.floor(whole.length / 2)).buffer
    await expect(decodeBankFile(cut, FILENAME)).rejects.toBeInstanceOf(UnreadableWorkbookError)
  })
})

describe("Handelsbanken's Excel export into the Handelsbanken parser", () => {
  it('detects and parses the export: booking dates, signed amounts, text and balance', async () => {
    const { content, result } = await parseWorkbook(streamedXlsx({ rows: HANDELSBANKEN_XLSX_ROWS }))
    expect(detectFileFormat(content, FILENAME)?.id).toBe('handelsbanken')
    expect(result.format).toBe('handelsbanken')
    expect(result.issues).toEqual([])
    expect(rowsOf(result)).toEqual(EXPECTED_ROWS)
    expect(result.stats.skipped_rows).toBe(1)
    expect(result.date_from).toBe('2026-11-03')
    expect(result.date_to).toBe('2026-11-16')
    expect(result.account).toEqual(expect.objectContaining({ account_number: '6789 123 456 789' }))
  })

  it('parses the export with English headers', async () => {
    const english: XlsxCell[][] = [
      ['Account transactions'],
      [],
      ['Ledger date', 'Transaction date', 'Text', 'Amount', 'Balance'],
      ...HANDELSBANKEN_XLSX_ROWS.slice(5),
    ]
    const { content, result } = await parseWorkbook(streamedXlsx({ rows: english }))
    expect(detectFileFormat(content, FILENAME)?.id).toBe('handelsbanken')
    expect(result.issues).toEqual([])
    expect(rowsOf(result)).toEqual(EXPECTED_ROWS)
  })

  it("parses a card account's export: no Saldo, the table one column in", async () => {
    const card: XlsxCell[][] = [
      [null, 'Kortkonto'],
      [],
      [null, 'Reskontradatum', 'Transaktionsdatum', 'Text', 'Belopp'],
      [null, { date: '2026-11-16' }, { date: '2026-11-14' }, 'CLAS OHLSON', { amount: -199.5 }],
      [null, { date: '2026-11-10' }, { date: '2026-11-09' }, 'INBETALNING', { amount: 5000 }],
    ]
    const { result } = await parseWorkbook(streamedXlsx({ rows: card }))
    expect(result.format).toBe('handelsbanken')
    expect(rowsOf(result)).toEqual([
      ['2026-11-16', 'CLAS OHLSON', -199.5, null],
      ['2026-11-10', 'INBETALNING', 5000, null],
    ])
  })

  it('reads the same rows whatever the cell types: text dates and amounts, plain numbers, short dates', async () => {
    const variants: XlsxCell[][] = [
      ['Kontotransaktioner'],
      ['Reskontradatum', 'Transaktionsdatum', 'Text', 'Belopp', 'Saldo'],
      // Dates and amounts as text, a Unicode minus and space grouping.
      ['2026-11-16', '2026-11-14', 'KORTKÖP CLAS OHLSON', '−199,50', '10 234,75'],
      // Numbers with no number format, dates in Excel's short date format.
      [{ date: '2026-11-12', format: 'short' }, { date: '2026-11-12', format: 'short' }, 'INSÄTTNING KUND AB', 12500, 10434.25],
      [{ date: '2026-11-03' }, '2026-11-02', 'BG LEVERANTÖR AB', -2065.75, { amount: -2065.75 }],
    ]
    const { result } = await parseWorkbook(streamedXlsx({ rows: variants }))
    expect(result.issues).toEqual([])
    expect(rowsOf(result)).toEqual(EXPECTED_ROWS)
  })

  it('reads past merged title and header cells and styled empty rows below the table', async () => {
    const rows: XlsxCell[][] = [
      ['Kontotransaktioner'],
      [],
      ['Reskontradatum', 'Transaktionsdatum', 'Text', null, 'Belopp', 'Saldo'],
      [{ date: '2026-11-16' }, { date: '2026-11-14' }, 'KORTKÖP CLAS OHLSON', null, { amount: -199.5 }, { amount: 10234.75 }],
    ]
    const { content, result } = await parseWorkbook(
      streamedXlsx({ rows, merges: ['A1:F1', 'C3:D3', 'C4:D4'], trailingEmptyRows: 40 }),
    )
    expect(content.split('\n')).toHaveLength(3)
    expect(result.issues).toEqual([])
    expect(rowsOf(result)).toEqual([EXPECTED_ROWS[0]])
  })

  it('names the columns of a workbook the chosen Handelsbanken format cannot read', async () => {
    const unknown: XlsxCell[][] = [['Dag', 'Vad', 'Summa kronor'], ['3 nov', 'ICA', -500]]
    const { content } = await parseWorkbook(streamedXlsx({ rows: unknown }))

    // Detected: nothing, so the wizard opens the column mapping.
    expect(parseBankFile(content, FILENAME).format).toBe('generic_csv')

    // Chosen: the refusal that names what the file has and what it needs.
    const chosen = parseBankFile(content, FILENAME, 'handelsbanken')
    expect(chosen.transactions).toEqual([])
    expect(chosen.unrecognized_columns).toEqual({
      found: ['Dag', 'Vad', 'Summa kronor'],
      expected: expect.objectContaining({ date: ['Reskontradatum', 'Transaktionsdatum', 'Ledger date'] }),
    })
  })
})
