import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseArticlesFile } from '../parser'

function buildXlsx(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Artiklar')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('parseArticlesFile', () => {
  it('parses a basic Swedish article register', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Artikelnummer', 'Pris', 'Moms', 'Enhet', 'Typ'],
      ['Konsulttimme', 'A-100', '950', '25', 'tim', 'tjänst'],
      ['Skruv', 'A-200', '2,50', '25', 'st', 'vara'],
    ])

    const result = parseArticlesFile(buffer, 'artiklar.xlsx')

    expect(result.total_rows).toBe(2)
    expect(result.rows[0].name).toBe('Konsulttimme')
    expect(result.rows[0].article_number).toBe('A-100')
    expect(result.rows[0].price_excl_vat).toBe(950)
    expect(result.rows[0].vat_rate).toBe(25)
    expect(result.rows[0].unit).toBe('tim')
    expect(result.rows[0].type).toBe('tjanst')
    expect(result.rows[1].type).toBe('vara')
    expect(result.rows[1].price_excl_vat).toBe(2.5)
    expect(result.rows[0].is_valid).toBe(true)
    // A clean, valid VAT rate is not flagged as adjusted.
    expect(result.rows[0].vat_rate_adjusted).toBe(false)
  })

  it('detects Fortnox-style export headers', () => {
    const buffer = buildXlsx([
      ['Artikelnummer', 'Benämning', 'Försäljningspris', 'Momskod', 'Försäljningskonto', 'Enhet'],
      ['100', 'Webdesign', '1 200', '25', '3001', 'st'],
    ])

    const result = parseArticlesFile(buffer, 'fortnox.xlsx')
    const r = result.rows[0]
    expect(r.article_number).toBe('100')
    expect(r.name).toBe('Webdesign')
    expect(r.price_excl_vat).toBe(1200) // "1 200" → 1200
    expect(r.vat_rate).toBe(25)
    expect(r.revenue_account).toBe('3001')
  })

  it('parses Swedish decimal prices', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Pris'],
      ['A', '1 234,56'],
      ['B', '1.234,50'],
      ['C', '500'],
    ])

    const result = parseArticlesFile(buffer, 'priser.xlsx')
    expect(result.rows[0].price_excl_vat).toBe(1234.56)
    expect(result.rows[1].price_excl_vat).toBe(1234.5)
    expect(result.rows[2].price_excl_vat).toBe(500)
  })

  it('snaps VAT to the nearest statutory rate and warns', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Moms'],
      ['A', '25%'],
      ['B', '7'],   // → 6
      ['C', ''],    // → 25 default
    ])

    const result = parseArticlesFile(buffer, 'moms.xlsx')
    expect(result.rows[0].vat_rate).toBe(25)
    expect(result.rows[1].vat_rate).toBe(6)
    expect(result.rows[2].vat_rate).toBe(25)
    // The "7" → 6 snap should surface a file-level warning.
    expect(result.warnings.some((w) => w.includes('momssats'))).toBe(true)
    // Per-row flag: only the snapped row (7 → 6) is marked adjusted.
    expect(result.rows[0].vat_rate_adjusted).toBe(false) // "25%" is already valid
    expect(result.rows[1].vat_rate_adjusted).toBe(true)  // 7 → 6
    expect(result.rows[2].vat_rate_adjusted).toBe(false) // empty → default 25
  })

  it('defaults an unparseable momskod to 25 with a warning', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Momskod'],
      ['A', 'MP1'],
    ])

    const result = parseArticlesFile(buffer, 'momskod.xlsx')
    expect(result.rows[0].vat_rate).toBe(25)
    expect(result.rows[0].vat_rate_adjusted).toBe(true)
    expect(result.warnings.some((w) => w.toLowerCase().includes('moms'))).toBe(true)
  })

  it('normalizes article type and falls back to tjanst', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Typ'],
      ['A', 'Produkt'],
      ['B', 'service'],
      ['C', ''],
    ])

    const result = parseArticlesFile(buffer, 'typ.xlsx')
    expect(result.rows[0].type).toBe('vara')
    expect(result.rows[1].type).toBe('tjanst')
    expect(result.rows[2].type).toBe('tjanst')
  })

  it('falls back to "st" when no unit is given', () => {
    const buffer = buildXlsx([
      ['Benämning'],
      ['A'],
    ])
    const result = parseArticlesFile(buffer, 'unit.xlsx')
    expect(result.rows[0].unit).toBe('st')
  })

  it('keeps a valid 3xxx revenue account and drops a non-3xxx one', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Försäljningskonto'],
      ['A', '3001'],
      ['B', '1930'],
    ])

    const result = parseArticlesFile(buffer, 'konto.xlsx')
    expect(result.rows[0].revenue_account).toBe('3001')
    expect(result.rows[1].revenue_account).toBeNull()
    expect(result.warnings.some((w) => w.toLowerCase().includes('försäljningskonto'))).toBe(true)
  })

  it('treats a blank cost price as null (not 0)', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Inköpspris'],
      ['A', ''],
      ['B', '100'],
    ])
    const result = parseArticlesFile(buffer, 'cost.xlsx')
    expect(result.rows[0].cost_price).toBeNull()
    expect(result.rows[1].cost_price).toBe(100)
  })

  it('warns when the price column looks incl-VAT', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Pris inkl moms'],
      ['A', '125'],
    ])
    const result = parseArticlesFile(buffer, 'brutto.xlsx')
    expect(result.warnings.some((w) => w.toLowerCase().includes('inkl'))).toBe(true)
  })

  it('skips rows with empty name and preserves row_index', () => {
    const buffer = buildXlsx([
      ['Benämning'],
      ['A'],
      [''],
      ['C'],
    ])
    const result = parseArticlesFile(buffer, 'sparse.xlsx')
    expect(result.total_rows).toBe(2)
    expect(result.rows.map((r) => r.name)).toEqual(['A', 'C'])
    expect(result.rows[0].row_index).toBe(2)
    expect(result.rows[1].row_index).toBe(4)
  })

  it('flags a negative price as invalid', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Pris'],
      ['A', '-50'],
    ])
    const result = parseArticlesFile(buffer, 'neg.xlsx')
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Priset kan inte vara negativt')
  })

  it('returns a warning when zero rows match', () => {
    const buffer = buildXlsx([['Benämning']])
    const result = parseArticlesFile(buffer, 'empty.xlsx')
    expect(result.total_rows).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('preserves Swedish characters when reading a UTF-8 CSV', () => {
    const csv = new TextEncoder().encode(
      'Benämning,Enhet\nMöbel,st\nKärra,st\n',
    ).buffer
    const result = parseArticlesFile(csv, 'artiklar.csv')
    expect(result.rows[0].name).toBe('Möbel')
    expect(result.rows[1].name).toBe('Kärra')
  })
})
