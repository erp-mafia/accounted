import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSuppliersFile } from '../parser'

function buildXlsx(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Leverantörer')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('parseSuppliersFile', () => {
  it('parses Swedish supplier register with bankgiro/iban', () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr', 'Bankgiro', 'Plusgiro', 'IBAN', 'BIC'],
      ['Acme AB', '5560217780', '123-4567', '12 34 56-7', 'SE3550000000054910000003', 'ESSESESS'],
    ])

    const result = parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.rows[0].name).toBe('Acme AB')
    expect(result.rows[0].bankgiro).toBe('123-4567')
    expect(result.rows[0].plusgiro).toBe('123456-7')
    expect(result.rows[0].iban).toBe('SE3550000000054910000003')
    expect(result.rows[0].bic).toBe('ESSESESS')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('classifies eu_business by VAT prefix', () => {
    const buffer = buildXlsx([
      ['Namn', 'VAT'],
      ['Müller GmbH', 'DE123456789'],
    ])
    const result = parseSuppliersFile(buffer, 'eu.xlsx')
    expect(result.rows[0].supplier_type).toBe('eu_business')
  })

  it('flags invalid IBAN format', () => {
    const buffer = buildXlsx([
      ['Namn', 'IBAN'],
      ['Acme AB', 'NOT-AN-IBAN'],
    ])
    const result = parseSuppliersFile(buffer, 'bad-iban.xlsx')
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Ogiltigt IBAN')
  })

  it('defaults currency to SEK when missing or invalid', () => {
    const buffer = buildXlsx([
      ['Namn', 'Valuta'],
      ['Acme AB', ''],
      ['Beta AB', 'XYZ'],
      ['Gamma AB', 'EUR'],
    ])
    const result = parseSuppliersFile(buffer, 'curr.xlsx')
    expect(result.rows[0].default_currency).toBe('SEK')
    expect(result.rows[1].default_currency).toBe('SEK')
    expect(result.rows[2].default_currency).toBe('EUR')
  })

  it('skips rows with empty name', () => {
    const buffer = buildXlsx([
      ['Namn'],
      ['Acme AB'],
      [''],
      ['Beta AB'],
    ])
    const result = parseSuppliersFile(buffer, 'sparse.xlsx')
    expect(result.total_rows).toBe(2)
  })

  it('cleans bankgiro number formatting', () => {
    const buffer = buildXlsx([
      ['Namn', 'Bankgiro'],
      ['Acme AB', '5402 9685'],
    ])
    const result = parseSuppliersFile(buffer, 'bg.xlsx')
    expect(result.rows[0].bankgiro).toBe('54029685')
  })

  it('preserves Swedish characters when reading a UTF-8 CSV', () => {
    const csv = new TextEncoder().encode(
      'Namn,Ort\nDinel AB,GÖTEBORG\nHisings AB,HISINGS KÄRRA\n',
    ).buffer
    const result = parseSuppliersFile(csv, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('HISINGS KÄRRA')
  })

  it('preserves Swedish characters when reading a Windows-1252 CSV', () => {
    // Ö = 0xD6, Ä = 0xC4 in Windows-1252
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a, // "Namn,Ort\n"
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a, // "Acme,GÖTEBORG\n"
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a, // "Beta,KÄRRA\n"
    ]
    const result = parseSuppliersFile(new Uint8Array(bytes).buffer, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('KÄRRA')
  })
  // Detection now reports -1 rather than claiming column 0 as the name (#2548),
  // so the preview must still parse: confidence is 0, so the UI shows the
  // mapping step with these rows and the user picks the real name column.
  it('still previews rows when no name column was detected', () => {
    const buffer = buildXlsx([
      ['Leverantörsnummer', 'Bankgiro'],
      ['LEV-001', '123-4567'],
    ])

    const result = parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.detected_columns.name_col).toBe(-1)
    expect(result.detected_columns.confidence).toBe(0)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('LEV-001')
  })
})
