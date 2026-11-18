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
  it('parses Swedish supplier register with bankgiro/iban', async () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr', 'Bankgiro', 'Plusgiro', 'IBAN', 'BIC'],
      ['Acme AB', '5560217780', '123-4567', '12 34 56-7', 'SE3550000000054910000003', 'ESSESESS'],
    ])

    const result = await parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.rows[0].name).toBe('Acme AB')
    expect(result.rows[0].bankgiro).toBe('123-4567')
    expect(result.rows[0].plusgiro).toBe('123456-7')
    expect(result.rows[0].iban).toBe('SE3550000000054910000003')
    expect(result.rows[0].bic).toBe('ESSESESS')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('classifies eu_business by VAT prefix', async () => {
    const buffer = buildXlsx([
      ['Namn', 'VAT'],
      ['Müller GmbH', 'DE123456789'],
    ])
    const result = await parseSuppliersFile(buffer, 'eu.xlsx')
    expect(result.rows[0].supplier_type).toBe('eu_business')
  })

  it('flags invalid IBAN format', async () => {
    const buffer = buildXlsx([
      ['Namn', 'IBAN'],
      ['Acme AB', 'NOT-AN-IBAN'],
    ])
    const result = await parseSuppliersFile(buffer, 'bad-iban.xlsx')
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Ogiltigt IBAN "NOT-AN-IBAN" i kolumnen "IBAN"')
  })

  it('defaults currency to SEK when missing or invalid', async () => {
    const buffer = buildXlsx([
      ['Namn', 'Valuta'],
      ['Acme AB', ''],
      ['Beta AB', 'XYZ'],
      ['Gamma AB', 'EUR'],
    ])
    const result = await parseSuppliersFile(buffer, 'curr.xlsx')
    expect(result.rows[0].default_currency).toBe('SEK')
    expect(result.rows[1].default_currency).toBe('SEK')
    expect(result.rows[2].default_currency).toBe('EUR')
  })

  it('skips rows with empty name', async () => {
    const buffer = buildXlsx([
      ['Namn'],
      ['Acme AB'],
      [''],
      ['Beta AB'],
    ])
    const result = await parseSuppliersFile(buffer, 'sparse.xlsx')
    expect(result.total_rows).toBe(2)
  })

  it('cleans bankgiro number formatting', async () => {
    const buffer = buildXlsx([
      ['Namn', 'Bankgiro'],
      ['Acme AB', '5402 9685'],
    ])
    const result = await parseSuppliersFile(buffer, 'bg.xlsx')
    expect(result.rows[0].bankgiro).toBe('54029685')
  })

  it('preserves Swedish characters when reading a UTF-8 CSV', async () => {
    const csv = new TextEncoder().encode(
      'Namn,Ort\nExempel AB,GÖTEBORG\nKärra AB,HISINGS KÄRRA\n',
    ).buffer
    const result = await parseSuppliersFile(csv, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('HISINGS KÄRRA')
  })

  it('preserves Swedish characters when reading a Windows-1252 CSV', async () => {
    // Ö = 0xD6, Ä = 0xC4 in Windows-1252
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a, // "Namn,Ort\n"
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a, // "Acme,GÖTEBORG\n"
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a, // "Beta,KÄRRA\n"
    ]
    const result = await parseSuppliersFile(new Uint8Array(bytes).buffer, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('KÄRRA')
  })
  // Detection now reports -1 rather than claiming column 0 as the name (#2548),
  // so the preview must still parse: confidence is 0, so the UI shows the
  // mapping step with these rows and the user picks the real name column.
  it('still previews rows when no name column was detected', async () => {
    const buffer = buildXlsx([
      ['Leverantörsnummer', 'Bankgiro'],
      ['LEV-001', '123-4567'],
    ])

    const result = await parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.detected_columns.name_col).toBe(-1)
    expect(result.detected_columns.confidence).toBe(0)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('LEV-001')
  })

  // PH 204: a detected column whose every cell fails its field is the wrong
  // column; the mapping step opens with it empty instead of a review step of
  // rows that cannot be fixed.
  it('unmaps a detected e-mail column that holds no e-mail address', async () => {
    const buffer = buildXlsx([
      ['Namn', 'Epost-kod', 'IBAN'],
      ['Acme AB', '123 45', 'SE3550000000054910000003'],
      ['Beta AB', '411 01', ''],
    ])
    const result = await parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.detected_columns.email_col).toBeNull()
    expect(result.detected_columns.iban_col).toBe(2)
    expect(result.detected_columns.confidence).toBeLessThan(0.8)
    expect(result.warnings.join(' ')).toContain('Kolumnen "Epost-kod" läses inte in som E-post')
    expect(result.rows.every((r) => r.is_valid)).toBe(true)
  })
})
