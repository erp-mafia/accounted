import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  integerColumn,
  percentColumn,
  slugifyCompanyName,
  xlsxFilename,
  type SheetSpec,
} from '../xlsx-export'

/**
 * Helper: parse a workbook buffer back into a usable shape so we can assert on
 * cell values, number formats, and per-sheet content.
 *
 * `cellDates: true` so dates round-trip as Date objects rather than serial
 * numbers, matching how Excel/Numbers will read the file.
 */
function parseBuffer(buffer: Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: 'buffer', cellNF: true, cellDates: true })
}

describe('reportToWorkbook', () => {
  it('writes a single sheet with header row and body cells', () => {
    type Row = { account: string; amount: number }
    const spec: SheetSpec<Row> = {
      name: 'Test',
      columns: [textColumn('Konto'), currencyColumn('Belopp')],
      rows: [
        { account: '1930', amount: 1500.5 },
        { account: '2440', amount: -750.25 },
      ],
      mapRow: (r) => [r.account, r.amount],
    }

    const buffer = reportToWorkbook([spec])
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.byteLength).toBeGreaterThan(0)

    const wb = parseBuffer(buffer)
    expect(wb.SheetNames).toEqual(['Test'])
    const sheet = wb.Sheets['Test']
    expect(sheet['A1'].v).toBe('Konto')
    expect(sheet['B1'].v).toBe('Belopp')
    expect(sheet['A2'].v).toBe('1930')
    expect(sheet['B2'].v).toBe(1500.5)
    expect(sheet['A3'].v).toBe('2440')
    expect(sheet['B3'].v).toBe(-750.25)
  })

  it('applies currency format to currency columns', () => {
    type Row = { name: string; total: number }
    const buffer = reportToWorkbook<Row>([
      {
        name: 'Currency',
        columns: [textColumn('Name'), currencyColumn('Total')],
        rows: [{ name: 'Foo', total: 1234.56 }],
        mapRow: (r) => [r.name, r.total],
      },
    ])

    const wb = parseBuffer(buffer)
    const sheet = wb.Sheets['Currency']
    expect(sheet['B2'].z).toBe('#,##0.00 " kr"')
    // The text column does not get our custom format applied. xlsx may add
    // a default 'General' format on read, so we only assert it isn't ours.
    expect(sheet['A2'].z).not.toBe('#,##0.00 " kr"')
  })

  it('applies date format to date columns', () => {
    type Row = { date: Date }
    const buffer = reportToWorkbook<Row>([
      {
        name: 'Dates',
        columns: [dateColumn('Datum')],
        rows: [{ date: new Date('2026-03-15T00:00:00Z') }],
        mapRow: (r) => [r.date],
      },
    ])

    const wb = parseBuffer(buffer)
    const sheet = wb.Sheets['Dates']
    expect(sheet['A2'].z).toBe('yyyy-mm-dd')
    expect(sheet['A2'].t).toBe('d')
  })

  it('applies integer and percent formats', () => {
    const buffer = reportToWorkbook([
      {
        name: 'Numeric',
        columns: [integerColumn('Antal'), percentColumn('Andel')],
        rows: [{ count: 42, share: 0.255 }],
        mapRow: (r) => [r.count, r.share],
      },
    ])

    const wb = parseBuffer(buffer)
    const sheet = wb.Sheets['Numeric']
    expect(sheet['A2'].z).toBe('#,##0')
    expect(sheet['B2'].z).toBe('0.00%')
    expect(sheet['A2'].v).toBe(42)
    expect(sheet['B2'].v).toBe(0.255)
  })

  it('produces multiple sheets with independent column shapes', () => {
    const buffer = reportToWorkbook([
      {
        name: 'Saldo',
        columns: [textColumn('Konto'), currencyColumn('Belopp')],
        rows: [{ account: '1930', amount: 100 }],
        mapRow: (r) => [r.account, r.amount],
      },
      {
        name: 'Period',
        columns: [dateColumn('Datum'), integerColumn('Antal')],
        rows: [{ date: new Date('2026-01-15'), count: 5 }],
        mapRow: (r) => [r.date, r.count],
      },
    ])

    const wb = parseBuffer(buffer)
    expect(wb.SheetNames).toEqual(['Saldo', 'Period'])
    expect(wb.Sheets['Saldo']['B1'].v).toBe('Belopp')
    expect(wb.Sheets['Period']['A1'].v).toBe('Datum')
    expect(wb.Sheets['Period']['A2'].z).toBe('yyyy-mm-dd')
  })

  it('handles empty row arrays (header-only sheet)', () => {
    const buffer = reportToWorkbook([
      {
        name: 'Empty',
        columns: [textColumn('Konto'), currencyColumn('Belopp')],
        rows: [],
        mapRow: () => ['unused', 0],
      },
    ])

    expect(buffer).toBeInstanceOf(Buffer)
    const wb = parseBuffer(buffer)
    const sheet = wb.Sheets['Empty']
    expect(sheet['A1'].v).toBe('Konto')
    expect(sheet['B1'].v).toBe('Belopp')
    // No body cells emitted.
    expect(sheet['A2']).toBeUndefined()
    expect(sheet['B2']).toBeUndefined()
  })

  it('truncates sheet names to Excel 31-char limit', () => {
    const longName = 'A'.repeat(40)
    const buffer = reportToWorkbook([
      {
        name: longName,
        columns: [textColumn('x')],
        rows: [],
        mapRow: () => [''],
      },
    ])

    const wb = parseBuffer(buffer)
    expect(wb.SheetNames[0]).toHaveLength(31)
  })

  it('treats undefined cells as blank', () => {
    const buffer = reportToWorkbook([
      {
        name: 'Sparse',
        columns: [textColumn('A'), textColumn('B')],
        rows: [{ a: 'x', b: undefined }],
        mapRow: (r) => [r.a, r.b ?? null],
      },
    ])

    const wb = parseBuffer(buffer)
    const sheet = wb.Sheets['Sparse']
    expect(sheet['A2'].v).toBe('x')
    expect(sheet['B2']).toBeUndefined()
  })

  it('throws when row length does not match column count', () => {
    expect(() =>
      reportToWorkbook([
        {
          name: 'Bad',
          columns: [textColumn('A'), textColumn('B')],
          rows: [{ x: 1 }],
          mapRow: () => ['only one'],
        },
      ]),
    ).toThrow(/row length 1 does not match column count 2/)
  })

  it('throws when given zero sheets', () => {
    expect(() => reportToWorkbook([])).toThrow(/at least one sheet/)
  })
})

describe('slugifyCompanyName', () => {
  it('lowercases and dasherizes', () => {
    expect(slugifyCompanyName('Acme Bookkeeping AB')).toBe('acme-bookkeeping-ab')
  })

  it('replaces Swedish characters', () => {
    expect(slugifyCompanyName('Räksmörgås & Co')).toBe('raksmorgas-co')
  })

  it('falls back to "foretag" when empty', () => {
    expect(slugifyCompanyName('')).toBe('foretag')
    expect(slugifyCompanyName('!!!')).toBe('foretag')
  })

  it('collapses repeated separators', () => {
    expect(slugifyCompanyName('Foo   Bar___Baz')).toBe('foo-bar-baz')
  })
})

describe('xlsxFilename', () => {
  it('combines slug, company, and compact period', () => {
    expect(xlsxFilename('trial-balance', 'Acme AB', '2026-03-31')).toBe(
      'trial-balance-acme-ab-20260331.xlsx',
    )
  })

  it('handles missing period gracefully', () => {
    expect(xlsxFilename('kpi', 'Test', '')).toBe('kpi-test.xlsx')
  })

  it('slugifies Swedish company names', () => {
    expect(xlsxFilename('vat-declaration', 'Räk AB', '2026-12-31')).toBe(
      'vat-declaration-rak-ab-20261231.xlsx',
    )
  })
})
