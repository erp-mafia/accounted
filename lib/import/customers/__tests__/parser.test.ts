import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseCustomersFile } from '../parser'

function buildXlsx(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Kunder')
  // Returning a Node Buffer; ArrayBuffer view is interchangeable with XLSX.read
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return out
}

describe('parseCustomersFile', () => {
  it('parses a basic Swedish customer register', () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr', 'E-post', 'Telefon', 'Adress', 'Postnr', 'Ort'],
      ['Acme AB', '5560217780', 'kontakt@acme.se', '0701234567', 'Storgatan 1', '11122', 'Stockholm'],
      ['Beta AB', '5562345678', 'info@beta.se', '0709876543', 'Vasagatan 2', '11329', 'Stockholm'],
    ])

    const result = parseCustomersFile(buffer, 'kunder.xlsx')

    expect(result.total_rows).toBe(2)
    expect(result.rows[0].name).toBe('Acme AB')
    expect(result.rows[0].org_number).toBe('5560217780')
    expect(result.rows[0].email).toBe('kontakt@acme.se')
    expect(result.rows[0].postal_code).toBe('11122')
    expect(result.rows[0].city).toBe('Stockholm')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('auto-classifies customer_type by org_number length', () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr'],
      ['Acme AB', '5560217780'],          // 10-digit company
      ['Sven Svensson', '198001011234'],  // 12-digit personnummer
    ])

    const result = parseCustomersFile(buffer, 'mixed.xlsx')
    expect(result.rows[0].customer_type).toBe('swedish_business')
    expect(result.rows[1].customer_type).toBe('individual')
  })

  it('classifies eu_business from VAT number prefix', () => {
    const buffer = buildXlsx([
      ['Namn', 'VAT'],
      ['Müller GmbH', 'DE123456789'],
    ])

    const result = parseCustomersFile(buffer, 'eu.xlsx')
    expect(result.rows[0].customer_type).toBe('eu_business')
    expect(result.rows[0].vat_number).toBe('DE123456789')
  })

  it('skips rows with empty name', () => {
    const buffer = buildXlsx([
      ['Namn', 'E-post'],
      ['Acme AB', 'a@a.se'],
      ['', 'b@b.se'],
      ['Beta AB', 'c@c.se'],
    ])

    const result = parseCustomersFile(buffer, 'sparse.xlsx')
    expect(result.total_rows).toBe(2)
    expect(result.rows.map((r) => r.name)).toEqual(['Acme AB', 'Beta AB'])
  })

  it('flags invalid email format', () => {
    const buffer = buildXlsx([
      ['Namn', 'E-post'],
      ['Acme AB', 'not-an-email'],
    ])

    const result = parseCustomersFile(buffer, 'bad-email.xlsx')
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Ogiltig e-postadress')
  })

  it('parses payment terms with day suffix', () => {
    const buffer = buildXlsx([
      ['Namn', 'Betalningsvillkor'],
      ['Acme AB', '45 dagar'],
      ['Beta AB', ''],
    ])

    const result = parseCustomersFile(buffer, 'terms.xlsx')
    expect(result.rows[0].default_payment_terms).toBe(45)
    expect(result.rows[1].default_payment_terms).toBe(30) // default fallback
  })

  it('returns warning when zero rows match', () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr'],
    ])

    const result = parseCustomersFile(buffer, 'empty.xlsx')
    expect(result.total_rows).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('honors explicit customer_type column', () => {
    const buffer = buildXlsx([
      ['Namn', 'Kundtyp'],
      ['Acme AB', 'aktiebolag'],
      ['Sven', 'privatperson'],
    ])

    const result = parseCustomersFile(buffer, 'types.xlsx')
    expect(result.rows[0].customer_type).toBe('swedish_business')
    expect(result.rows[1].customer_type).toBe('individual')
  })

  it('preserves row_index pointing to spreadsheet row', () => {
    const buffer = buildXlsx([
      ['Namn'],
      ['Acme AB'],
      ['Beta AB'],
    ])

    const result = parseCustomersFile(buffer, 'rows.xlsx')
    expect(result.rows[0].row_index).toBe(2) // header is row 1
    expect(result.rows[1].row_index).toBe(3)
  })

  it('preserves Swedish characters when reading a UTF-8 CSV', () => {
    const csv = new TextEncoder().encode(
      'Namn,Ort\nAcme AB,GÖTEBORG\nBeta AB,HISINGS KÄRRA\n',
    ).buffer
    const result = parseCustomersFile(csv, 'kunder.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('HISINGS KÄRRA')
  })

  it('stores the country as an ISO code and flags a name it cannot map', () => {
    const buffer = buildXlsx([
      ['Namn', 'Orgnr', 'Land'],
      ['Acme AB', '5560217780', 'Sverige'],
      ['Muster GmbH', '', 'Tyskland'],
      ['Nowhere Ltd', '', 'Atlantis'],
      ['Blank AB', '5562345678', ''],
    ])

    const result = parseCustomersFile(buffer, 'kunder.xlsx')

    expect(result.rows[0].country).toBe('SE')
    expect(result.rows[1].country).toBe('DE')
    expect(result.rows[2].country).toBe('Atlantis')
    expect(result.rows[2].is_valid).toBe(false)
    expect(result.rows[2].validation_errors.join(' ')).toMatch(/Okänt land/)
    expect(result.rows[3].country).toBe('SE')
  })

  it('derives a missing country from the type and flags a contradictory row', () => {
    const buffer = buildXlsx([
      ['Namn', 'Kundtyp', 'Land', 'VAT-nummer'],
      ['Muster GmbH', 'eu_business', '', 'DE811234567'],
      ['Falsch GmbH', 'eu_business', 'Sverige', 'DE811234567'],
      ['Far Ltd', 'non_eu_business', '', ''],
      ['Acme AB', 'swedish_business', '', ''],
    ])

    const result = parseCustomersFile(buffer, 'kunder.xlsx')

    expect(result.rows[0].country).toBe('DE')
    expect(result.rows[0].is_valid).toBe(true)
    expect(result.rows[1].country).toBe('SE')
    expect(result.rows[1].is_valid).toBe(false)
    expect(result.rows[1].validation_errors.join(' ')).toMatch(/EU-företag/)
    expect(result.rows[2].is_valid).toBe(false)
    expect(result.rows[2].validation_errors.join(' ')).toMatch(/Land saknas/)
    expect(result.rows[3].country).toBe('SE')
    expect(result.rows[3].is_valid).toBe(true)
  })
})
