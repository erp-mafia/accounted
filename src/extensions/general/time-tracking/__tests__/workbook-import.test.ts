import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseEntryDate, parseHours, parseTimeWorkbook, TimeWorkbookError } from '../lib/workbook-import'

/** Workbook shaped like the Numbers "Projektredovisning" export: filter row, empty column A. */
function makeWorkbook(transactions: unknown[][], extra: Record<string, unknown[][]> = {}): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [null, '2606-2607', null, null, 'GF'],
      [null, 'Datum', 'Dag', 'Medarb', 'Kund', 'Projekt', 'A-kod', 'Timmar', 'Kommentar', 'Skapat', 'Ändrat'],
      ...transactions,
    ]),
    'Transaktioner',
  )
  for (const [name, rows] of Object.entries(extra)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return wb
}

describe('parseTimeWorkbook', () => {
  it('reads rows and registers from a Numbers-style export', () => {
    const wb = makeWorkbook(
      [
        [null, '2026-06-15', 'mån', 'GK', 'GF', null, '1', 7.5, 'momsutredning'],
        [null, '2026-06-16', 'tis', 'gk', 'vc', 'P1', '1', '2,25', 'årsred, dekl'],
      ],
      {
        Medarbetare: [[null, null, 'Medarbetare'], [null, 'Medarbetarkod', 'Namn'], [null, 'GK', 'Göran Kalin']],
        Kunder: [[null, null, 'Kunder'], [null, 'Kundkod', 'Namn'], [null, 'GF', 'Galärbryggan'], [null, 'VC', 'Kök & Kök']],
        Arbetskoder: [[null, null, 'Arbetskoder'], [null, 'A-kod', 'Benämning'], [null, '1', 'Kod 1']],
      },
    )

    const result = parseTimeWorkbook(wb)

    expect(result.skipped).toEqual([])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[1]).toMatchObject({
      source_row: 4,
      entry_date: '2026-06-16',
      consultant: 'GK',
      customer_code: 'VC',
      project_code: 'P1',
      activity_code: '1',
      hours: 2.25,
      comment: 'årsred, dekl',
    })
    expect(result.consultants).toEqual([{ code: 'GK', name: 'Göran Kalin' }])
    expect(result.customers).toEqual([
      { code: 'GF', name: 'Galärbryggan' },
      { code: 'VC', name: 'Kök & Kök' },
    ])
    expect(result.activity_codes).toEqual([{ code: '1', name: 'Kod 1', hourly_rate: null }])
  })

  it('skips rows with unusable hours or dates and says which cell failed', () => {
    const wb = makeWorkbook([
      [null, '2026-03-01', 'sön', 'GK', 'SPIS', null, '1', ' disk', 'ugn'],
      [null, '2020-01-01', 'ons', 'GK', 'GF', null, '1', 0, ''],
      [null, 'igår', 'ons', 'GK', 'GF', null, '1', 1, ''],
      [null, '2026-03-02', 'mån', 'GK', null, null, '1', 1, ''],
      [null, '2026-03-03', 'tis', 'GK', 'GF', null, '1', 1, 'ok'],
    ])

    const result = parseTimeWorkbook(wb)

    expect(result.rows.map((r) => r.comment)).toEqual(['ok'])
    expect(result.skipped).toEqual([
      { source_row: 3, reason: 'invalid_hours', value: 'disk' },
      { source_row: 4, reason: 'invalid_hours', value: '0' },
      { source_row: 5, reason: 'invalid_date', value: 'igår' },
      { source_row: 6, reason: 'missing_customer', value: '' },
    ])
  })

  it('gives identical rows distinct, stable import keys', () => {
    const row = [null, '2009-04-28', 'tis', 'GK', 'BAS', null, '1', 7.5, 'fisk, eurocard']
    const first = parseTimeWorkbook(makeWorkbook([row, row]))
    const second = parseTimeWorkbook(makeWorkbook([row, row]))

    expect(first.rows).toHaveLength(2)
    expect(first.rows[0].import_key).not.toBe(first.rows[1].import_key)
    expect(second.rows.map((r) => r.import_key)).toEqual(first.rows.map((r) => r.import_key))
  })

  it('keeps the keys of earlier rows when the file grows', () => {
    const a = [null, '2026-08-16', 'sön', 'GK', 'GF', null, '1', 1, 'momsdekl']
    const b = [null, '2026-08-17', 'mån', 'GK', 'AK', null, '1', 0.5, 'moms']
    const before = parseTimeWorkbook(makeWorkbook([a]))
    const after = parseTimeWorkbook(makeWorkbook([a, b]))
    expect(after.rows[0].import_key).toBe(before.rows[0].import_key)
  })

  it('throws when no sheet has the transaction headers', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Konto', 'Belopp']]), 'Sheet1')
    expect(() => parseTimeWorkbook(wb)).toThrow(TimeWorkbookError)
  })
})

describe('parseEntryDate', () => {
  it('accepts ISO text, Date and Excel serials and rejects impossible dates', () => {
    expect(parseEntryDate('2026-02-28')).toBe('2026-02-28')
    expect(parseEntryDate('2026-02-30')).toBeNull()
    expect(parseEntryDate(new Date(Date.UTC(2026, 5, 14)))).toBe('2026-06-14')
    expect(parseEntryDate(46187)).toBe('2026-06-14')
    expect(parseEntryDate(null)).toBeNull()
  })
})

describe('parseHours', () => {
  it('accepts decimal commas and rounds to two decimals', () => {
    expect(parseHours('1,5')).toBe(1.5)
    expect(parseHours(0.333)).toBe(0.33)
    expect(parseHours(25)).toBeNull()
    expect(parseHours('-1')).toBeNull()
  })
})
