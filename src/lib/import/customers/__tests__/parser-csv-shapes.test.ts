import { describe, it, expect } from 'vitest'
import { parseCustomersFile } from '../parser'
import { needsColumnMapping } from '@/lib/import/register-import-flow'

/**
 * The customer CSV shapes people actually upload (PH 204), as small synthetic
 * fixtures: Excel on Windows (ANSI and "CSV UTF-8", semicolons, CRLF), the
 * Spiris register export (comma, PascalCase headers), a Fortnox-style
 * register and a plain comma file. All names and numbers are made up.
 */

const CP1252: Record<string, number> = {
  'å': 0xe5, 'ä': 0xe4, 'ö': 0xf6, 'Å': 0xc5, 'Ä': 0xc4, 'Ö': 0xd6, 'é': 0xe9, 'ü': 0xfc,
}

/** Windows-1252 bytes: what Excel's "CSV (semikolonavgränsad)" writes. */
function ansi(text: string): ArrayBuffer {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = CP1252[text[i]] ?? text.charCodeAt(i)
    if (code > 0x7f && CP1252[text[i]] === undefined) throw new Error(`no cp1252 byte for ${text[i]}`)
    out[i] = code
  }
  return out.buffer
}

/** UTF-8 bytes, with Excel's "CSV UTF-8" byte order mark when asked. */
function utf8(text: string, bom = false): ArrayBuffer {
  const body = new TextEncoder().encode(text)
  if (!bom) return body.buffer as ArrayBuffer
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out.buffer
}

function csv(rows: string[][], sep: string): string {
  const quote = (cell: string) =>
    cell.includes(sep) || cell.includes('"') ? `"${cell.replace(/"/g, '""')}"` : cell
  return rows.map((r) => r.map(quote).join(sep)).join('\r\n') + '\r\n'
}

const SWEDISH_EXCEL = [
  ['Kundnummer', 'Namn', 'Organisationsnummer', 'Adress', 'Postnummer', 'Ort', 'Land', 'Telefon', 'E-post'],
  ['1', 'Åkesson Bygg AB', '556677-8899', 'Storgatan 1', '123 45', 'Göteborg', 'Sverige', '0701234567', 'info@akesson.example'],
  ['2', 'Öberg; Lars', '19800101-1234', 'Box 12', '411 01', 'Malmö', 'Sverige', '031-123456', 'lars@oberg.example'],
]

describe('parseCustomersFile: CSV shapes', () => {
  it('reads an Excel ANSI semicolon file with Swedish characters', async () => {
    const result = await parseCustomersFile(ansi(csv(SWEDISH_EXCEL, ';')), 'kunder.csv')

    expect(result.headers[0]).toBe('Kundnummer')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].name).toBe('Åkesson Bygg AB')
    expect(result.rows[0].city).toBe('Göteborg')
    expect(result.rows[0].phone).toBe('0701234567')
    expect(result.rows[1].name).toBe('Öberg; Lars')
    expect(result.rows[1].customer_type).toBe('individual')
    expect(result.rows.every((r) => r.is_valid)).toBe(true)
    expect(needsColumnMapping(result.detected_columns)).toBe(false)
  })

  it('reads an Excel "CSV UTF-8" file whose byte order mark precedes the first header', async () => {
    const result = await parseCustomersFile(utf8(csv(SWEDISH_EXCEL, ';'), true), 'kunder.csv')

    expect(result.headers[0]).toBe('Kundnummer')
    expect(result.detected_columns.customer_number_col).toBe(0)
    expect(result.rows[0].customer_number).toBe('1')
    expect(result.rows[1].city).toBe('Malmö')
    expect(result.rows.every((r) => r.is_valid)).toBe(true)
  })

  it('reads a plain comma UTF-8 file with a quoted field', async () => {
    const rows = [
      ['Namn', 'Orgnr', 'Adress', 'Postnr', 'Ort', 'E-post'],
      ['Acme AB', '5560217780', 'Gatan 4, lgh 1101', '11122', 'Stockholm', 'a@acme.example'],
    ]
    const result = await parseCustomersFile(utf8(csv(rows, ',')), 'kunder.csv')

    expect(result.rows[0].address_line1).toBe('Gatan 4, lgh 1101')
    expect(result.rows[0].city).toBe('Stockholm')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('reads a Fortnox-style register with invoice and delivery addresses', async () => {
    const rows = [
      ['Kundnr', 'Namn', 'Org-/personnummer', 'Fakturaadress', 'Fakturaadress 2', 'Postnr', 'Ort', 'Land',
        'Telefon 1', 'E-post', 'Momsreg.nr', 'Typ', 'Leveransadress', 'Leverans ort'],
      ['10', 'Kund Ett AB', '556677-8899', 'Fakturagatan 1', 'c/o Ekonomi', '123 45', 'Lund', 'Sverige',
        '046-123456', 'faktura@ett.example', 'SE556677889901', 'Företag', 'Lagervägen 9', 'Eslöv'],
      ['11', 'Anna Andersson', '19800101-1234', 'Hemvägen 2', '', '222 22', 'Lund', 'Sverige',
        '', 'anna@example.se', '', 'Privat', '', ''],
    ]
    const result = await parseCustomersFile(ansi(csv(rows, ';')), 'kundregister.csv')

    const [ett, anna] = result.rows
    expect(ett.customer_number).toBe('10')
    expect(ett.address_line1).toBe('Fakturagatan 1')
    expect(ett.address_line2).toBe('c/o Ekonomi')
    expect(ett.city).toBe('Lund')
    expect(ett.vat_number).toBe('SE556677889901')
    expect(ett.customer_type).toBe('swedish_business')
    expect(anna.customer_type).toBe('individual')
    expect(result.rows.every((r) => r.is_valid)).toBe(true)
  })

  // PH 204: the Spiris export, as Spiris writes it (comma, UTF-8). Its
  // "InvoicePostalCode" was read as the e-mail column, every row failed the
  // e-mail check and the review step could only delete rows.
  describe('Spiris customer register export', () => {
    const HEADERS = [
      'IsActive', 'CustomerNumber', 'Namn', 'IsPrivatePerson', 'CorporateIdentityNumber',
      'Postadress 1', 'Postadress 2', 'InvoicePostalCode', 'InvoiceCity', 'InvoiceCountryCode',
      'VatNumber', 'Telephone', 'MobilePhone', 'EmailAddress', 'WwwAddress', 'Note',
      'DeliveryAddress1', 'DeliveryPostalCode', 'DeliveryCity', 'TermsofPaymentCode', 'CurrencyCode',
    ]
    const row = (cells: Record<string, string>) => HEADERS.map((h) => cells[h] ?? '')
    const ROWS = [
      HEADERS,
      row({
        IsActive: 'True', CustomerNumber: '1', Namn: 'Kommunen, Kulturförvaltningen', IsPrivatePerson: 'False',
        CorporateIdentityNumber: '212000-0001', 'Postadress 1': 'Box 1, plan 2', InvoicePostalCode: '123 45',
        InvoiceCity: 'Göteborg', InvoiceCountryCode: 'SE', VatNumber: 'SE212000000101',
        Telephone: '031-100000', EmailAddress: 'kultur@kommun.example', WwwAddress: 'www.kommun.example',
        Note: 'Fakturera via e-post, alltid', DeliveryAddress1: 'Lagerplan 3', DeliveryCity: 'Mölndal',
        TermsofPaymentCode: '30', CurrencyCode: 'SEK',
      }),
      row({
        IsActive: 'True', CustomerNumber: '2', Namn: 'Lars Öberg', IsPrivatePerson: 'True',
        'Postadress 1': 'Hemgatan 2', InvoicePostalCode: '411 01', InvoiceCity: 'Malmö',
        InvoiceCountryCode: 'SE', EmailAddress: 'lars@example.se', CurrencyCode: 'SEK',
      }),
      row({
        IsActive: 'True', CustomerNumber: '3', Namn: 'Muster Reisen GmbH', IsPrivatePerson: 'False',
        'Postadress 1': 'Hauptstr. 3', InvoicePostalCode: '10115', InvoiceCity: 'Berlin',
        InvoiceCountryCode: 'DE', VatNumber: 'DE811234567', EmailAddress: 'info@muster.example', CurrencyCode: 'EUR',
      }),
      row({
        IsActive: 'True', CustomerNumber: '4', Namn: 'Ekfirman', IsPrivatePerson: 'False',
        CorporateIdentityNumber: '800101-1234', 'Postadress 1': 'Ekvägen 4', InvoicePostalCode: '222 22',
        InvoiceCity: 'Lund', InvoiceCountryCode: 'SE', EmailAddress: 'ek@firman.example', CurrencyCode: 'SEK',
      }),
    ]

    it('reads every row as valid, with the invoice address and every number', async () => {
      const result = await parseCustomersFile(utf8(csv(ROWS, ',')), 'customers.csv')

      expect(result.rows).toHaveLength(4)
      expect(result.rows.filter((r) => !r.is_valid).map((r) => r.validation_errors)).toEqual([])
      expect(needsColumnMapping(result.detected_columns)).toBe(false)

      const [kommun, lars, muster, ek] = result.rows
      expect(kommun.name).toBe('Kommunen, Kulturförvaltningen')
      expect(kommun.customer_number).toBe('1')
      expect(kommun.org_number).toBe('212000-0001')
      expect(kommun.vat_number).toBe('SE212000000101')
      expect(kommun.email).toBe('kultur@kommun.example')
      expect(kommun.address_line1).toBe('Box 1, plan 2')
      expect(kommun.postal_code).toBe('123 45')
      expect(kommun.city).toBe('Göteborg')
      expect(kommun.phone).toBe('031-100000')
      expect(kommun.notes).toBe('Fakturera via e-post, alltid')
      expect(kommun.customer_type).toBe('swedish_business')

      expect(lars.customer_type).toBe('individual')
      expect(muster.customer_type).toBe('eu_business')
      expect(muster.country).toBe('DE')
      // Not a private person: a personnummer-shaped number is a sole trader's org number.
      expect(ek.customer_type).toBe('swedish_business')
    })

    it('reads the same export re-saved by Swedish Excel (semicolons, ANSI, SANT/FALSKT)', async () => {
      const resaved = ROWS.map((r, i) => (i === 0 ? r : r.map((c) => (c === 'True' ? 'SANT' : c === 'False' ? 'FALSKT' : c))))
      const result = await parseCustomersFile(ansi(csv(resaved, ';')), 'customers.csv')

      expect(result.rows.every((r) => r.is_valid)).toBe(true)
      expect(result.rows.map((r) => r.customer_type)).toEqual([
        'swedish_business', 'individual', 'eu_business', 'swedish_business',
      ])
      expect(result.rows[1].city).toBe('Malmö')
    })
  })
})

describe('parseCustomersFile: a detected column the data contradicts', () => {
  // A header that looks like e-mail over a column of postal codes: the
  // failure PH 204 hit, kept as a safety net for headers detection misreads.
  const ROWS = [
    ['Namn', 'Epost-kod', 'Ort'],
    ['Acme AB', '123 45', 'Lund'],
    ['Beta AB', '411 01', 'Malmö'],
  ]

  it('unmaps it, says which column and sends the user to the mapping step', async () => {
    const result = await parseCustomersFile(utf8(csv(ROWS, ';')), 'kunder.csv')

    expect(result.detected_columns.email_col).toBeNull()
    expect(needsColumnMapping(result.detected_columns)).toBe(true)
    expect(result.warnings.join(' ')).toContain('Kolumnen "Epost-kod" läses inte in som E-post')
    expect(result.rows.every((r) => r.is_valid && r.email === null)).toBe(true)
  })

  it('keeps a mapping the user chose and names the column and value in each row error', async () => {
    const detected = (await parseCustomersFile(utf8(csv(ROWS, ';')), 'kunder.csv')).detected_columns
    const result = await parseCustomersFile(utf8(csv(ROWS, ';')), 'kunder.csv', { ...detected, email_col: 1 })

    expect(result.warnings).toEqual([])
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toEqual(['Ogiltig e-postadress "123 45" i kolumnen "Epost-kod"'])
  })

  it('leaves a column alone when only one cell is wrong', async () => {
    const rows = [
      ['Namn', 'E-post'],
      ['Acme AB', 'info@acme.example'],
      ['Beta AB', 'inte-en-adress'],
    ]
    const result = await parseCustomersFile(utf8(csv(rows, ';')), 'kunder.csv')

    expect(result.detected_columns.email_col).toBe(1)
    expect(result.warnings).toEqual([])
    expect(result.rows[1].is_valid).toBe(false)
  })
})
