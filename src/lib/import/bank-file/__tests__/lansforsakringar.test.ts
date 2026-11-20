/**
 * Länsförsäkringar files in the shapes a customer actually uploads
 * (crm#1236): the bank's own CSV, its monthly Excel kontoutdrag (read as
 * semicolon text by ../workbook.ts, see workbook.test.ts), and that Excel file
 * saved again as CSV by a spreadsheet. Synthetic rows only.
 */
import { describe, it, expect } from 'vitest'
import { detectFileFormat, parseBankFile } from '../parser'
import { lansforsakringarFormat, parseLansforsakringarAmount } from '../formats/lansforsakringar'

const rowsOf = (content: string, filename = 'lf.csv') =>
  parseBankFile(content, filename).transactions.map((t) => [t.date, t.description, t.amount])

describe('Länsförsäkringar: the converted CSV the customer could not import', () => {
  // What Excel in Swedish writes for "Spara som CSV (semikolonavgränsad)":
  // no quotes, whole amounts without decimals, the month heading row
  // removed. The old parser looked for the word "datum" in the first line
  // (absent here) and otherwise for a decimal-comma amount in the fifth field
  // of the first three lines, so "-500" and "25000" left the file
  // unrecognized and the wizard fell through to manual column mapping.
  const SWEDISH_EXCEL_CSV = [
    'Bokföringsdag;Transaktionsdag;Transaktionstyp;Meddelande;Belopp;Saldo',
    '2025-10-03;2025-10-01;Kortköp;ICA NÄRA TESTBY;-500;19500',
    '2025-10-06;2025-10-06;Insättning;Kund AB faktura 1001;25000;44500',
    '2025-10-15;2025-10-15;Bankgirobetalning;Leverantör AB;-1234,5;43265,5',
  ].join('\r\n')

  it('detects and reads it, heading row removed', () => {
    expect(detectFileFormat(SWEDISH_EXCEL_CSV, 'oktober.csv')?.id).toBe('lansforsakringar')
    expect(rowsOf(SWEDISH_EXCEL_CSV)).toEqual([
      ['2025-10-03', 'ICA NÄRA TESTBY', -500],
      ['2025-10-06', 'Kund AB faktura 1001', 25000],
      ['2025-10-15', 'Leverantör AB', -1234.5],
    ])
  })

  it('reads it with the heading row still there, and with the empty row Excel leaves behind', () => {
    const withHeading = `Kontoutdrag oktober 2025;;;;;\r\n;;;;;\r\n${SWEDISH_EXCEL_CSV}`
    expect(detectFileFormat(withHeading, 'oktober.csv')?.id).toBe('lansforsakringar')
    const result = parseBankFile(withHeading, 'oktober.csv')
    expect(result.issues).toEqual([])
    expect(result.transactions).toHaveLength(3)
  })

  it('reads it saved as "CSV UTF-8" (with a BOM)', () => {
    expect(rowsOf(`﻿${SWEDISH_EXCEL_CSV}`)).toHaveLength(3)
  })

  it('reads the comma-separated CSV an English-language spreadsheet writes', () => {
    const englishCsv = [
      'Bokföringsdag,Transaktionsdag,Transaktionstyp,Meddelande,Belopp,Saldo',
      '10/3/2025,10/1/2025,Kortköp,"ICA NÄRA, TESTBY",-1234.5,18765.5',
      '10/16/2025,10/16/2025,Insättning,Kund AB,25000,43765.5',
    ].join('\n')
    expect(detectFileFormat(englishCsv, 'october.csv')?.id).toBe('lansforsakringar')
    // 10/16/2025 shows the month comes first in this file.
    expect(rowsOf(englishCsv)).toEqual([
      ['2025-10-03', 'ICA NÄRA, TESTBY', -1234.5],
      ['2025-10-16', 'Kund AB', 25000],
    ])
  })

  it('reads DD/MM/YYYY dates as day first', () => {
    const csv = [
      'Bokföringsdag;Transaktionsdag;Text;Belopp',
      '03/10/2025;01/10/2025;ICA;-10,00',
      '16/10/2025;16/10/2025;Kund AB;100,00',
    ].join('\n')
    expect(rowsOf(csv).map(([date]) => date)).toEqual(['2025-10-03', '2025-10-16'])
  })

  it('reads amounts with non-breaking spaces, parentheses and a trailing minus', () => {
    const csv = [
      'Bokföringsdag;Transaktionsdag;Text;Belopp',
      '2025-10-03;2025-10-03;A;-1 234,56',
      '2025-10-04;2025-10-04;B;(2 000,00)',
      '2025-10-05;2025-10-05;C;300,00-',
      '2025-10-06;2025-10-06;D;−5,5',
      '2025-10-07;2025-10-07;E;12 500 kr',
    ].join('\n')
    expect(rowsOf(csv).map(([, , amount]) => amount)).toEqual([-1234.56, -2000, -300, -5.5, 12500])
  })
})

describe("Länsförsäkringar: the bank's own CSV export", () => {
  // The account block, a blank line, then the header: Bokföringsdatum first.
  const ACCOUNT_BLOCK_CSV = [
    '"Kontonummer";"Kontonamn";"";"Saldo";"Tillgängligt belopp"',
    '"90230000000";"Företagskonto";"";"54 000,00";"54 000,00"',
    '',
    '"Bokföringsdatum";"Transaktionsdatum";"Transaktionstyp";"Meddelande";"Belopp"',
    '"2025-04-28";"2025-04-26";"Kortköp";"SPOTIFY";"-99,00"',
    '"2025-04-25";"2025-04-25";"Överföring";"Kund AB";"3 000,00"',
  ].join('\n')

  it('is Länsförsäkringar, not Handelsbanken, despite its Transaktionsdatum column', () => {
    expect(detectFileFormat(ACCOUNT_BLOCK_CSV, 'Konto.csv')?.id).toBe('lansforsakringar')
  })

  it('reads the booking date and the Meddelande text, skipping the account block', () => {
    const result = parseBankFile(ACCOUNT_BLOCK_CSV, 'Konto.csv')
    expect(result.issues).toEqual([])
    expect(result.transactions.map((t) => [t.date, t.description, t.amount])).toEqual([
      ['2025-04-28', 'SPOTIFY', -99],
      ['2025-04-25', 'Kund AB', 3000],
    ])
  })

  it('falls back to the type when a row has no message', () => {
    const csv = [
      '"Bokföringsdag";"Transaktionsdag";"Transaktionstyp";"Meddelande";"Belopp";"Saldo"',
      '"2025-04-28";"2025-04-28";"Swishbetalning";"";"-150,00";"1 000,00"',
    ].join('\n')
    expect(rowsOf(csv)).toEqual([['2025-04-28', 'Swishbetalning', -150]])
  })

  it('keeps the original Datum;Bokföringsdag layout on the booking date', () => {
    const csv = [
      '"Datum";"Bokföringsdag";"Typ";"Text";"Belopp";"Saldo"',
      '"2026-03-14";"2026-03-16";"Kortköp";"CLAS OHLSON";"-100,00";"5 000,00"',
    ].join('\n')
    expect(rowsOf(csv)).toEqual([['2026-03-16', 'CLAS OHLSON', -100]])
  })

  it('takes an amount split into Insättning and Uttag', () => {
    const csv = [
      'Bokföringsdag;Transaktionsdag;Text;Insättning;Uttag;Saldo',
      '2025-10-03;2025-10-03;Kund AB;1 000,00;;11 000,00',
      '2025-10-04;2025-10-04;Hyra;;5 000,00;6 000,00',
    ].join('\n')
    expect(detectFileFormat(csv, 'k.csv')?.id).toBe('lansforsakringar')
    expect(rowsOf(csv).map(([, , amount]) => amount)).toEqual([1000, -5000])
  })

  it('skips heading, repeated header and balance rows without warnings; warns on a broken row', () => {
    const csv = [
      'Bokföringsdag;Transaktionsdag;Text;Belopp;Saldo',
      '2025-09-30;2025-09-30;Kund AB;100,00;1 100,00',
      'Oktober 2025',
      'Bokföringsdag;Transaktionsdag;Text;Belopp;Saldo',
      ';;Ingående saldo;;1 100,00',
      '2025-10-02;2025-10-02;ICA;-50,00;1 050,00',
      ';;Summa;50,00;',
      '2025-13-40;2025-10-03;Trasig rad;-1,00;1 049,00',
    ].join('\n')
    const result = parseBankFile(csv, 'k.csv')
    expect(result.transactions.map((t) => t.description)).toEqual(['Kund AB', 'ICA'])
    expect(result.issues).toEqual([{ row: 8, message: 'Ogiltigt datum: 2025-13-40', severity: 'warning' }])
    expect(result.stats.skipped_rows).toBe(1)
  })
})

describe('Länsförsäkringar: header-less rows', () => {
  it('takes the later of the two leading dates as the booking date, whichever column it is', () => {
    const bookingFirst = [
      '"2025-04-28";"2025-04-26";"Kortköp";"SPOTIFY";"-99,00"',
      '"2025-04-25";"2025-04-25";"Överföring";"Kund AB";"3 000,00"',
    ].join('\n')
    const bookingSecond = [
      '"2025-04-26";"2025-04-28";"Kortköp";"SPOTIFY";"-99,00"',
      '"2025-04-25";"2025-04-25";"Överföring";"Kund AB";"3 000,00"',
    ].join('\n')
    expect(rowsOf(bookingFirst)[0][0]).toBe('2025-04-28')
    expect(rowsOf(bookingSecond)[0][0]).toBe('2025-04-28')
  })

  it('detects rows whose negative amounts carry a Unicode minus or a plus sign', () => {
    // The old detector accepted only an ASCII hyphen and a decimal comma in
    // the fifth field, so a file opening with such rows fell through to
    // manual column mapping.
    const csv = '"2025-04-28";"2025-04-28";"Kortköp";"SPOTIFY";"−99,00"\n"2025-04-25";"2025-04-25";"Insättning";"Kund AB";"+3 000,00"'
    expect(detectFileFormat(csv, 'k.csv')?.id).toBe('lansforsakringar')
    expect(rowsOf(csv).map(([, , amount]) => amount)).toEqual([-99, 3000])
  })

  it('detects unquoted comma-separated rows with whole amounts', () => {
    const csv = '2025-04-28,2025-04-28,Kortköp,SPOTIFY,-99\n2025-04-25,2025-04-25,Överföring,Kund AB,3000'
    expect(detectFileFormat(csv, 'k.csv')?.id).toBe('lansforsakringar')
    expect(rowsOf(csv)).toEqual([
      ['2025-04-28', 'SPOTIFY', -99],
      ['2025-04-25', 'Kund AB', 3000],
    ])
  })
})

describe('Länsförsäkringar: when the columns are not recognized', () => {
  const UNRELATED = ['Kontoutdrag oktober 2025', 'Dag;Vad;Summa kronor', '3 okt;ICA;-500'].join('\n')

  it('says which columns the file has and which it needs', () => {
    const result = lansforsakringarFormat.parse(UNRELATED)
    expect(result.transactions).toEqual([])
    expect(result.unrecognized_columns).toEqual({
      found: ['Dag', 'Vad', 'Summa kronor'],
      expected: {
        date: ['Bokföringsdag', 'Bokföringsdatum', 'Transaktionsdatum', 'Datum'],
        amount: ['Belopp', 'Insättning + Uttag'],
        optional: ['Text', 'Meddelande', 'Saldo'],
      },
    })
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].message).toBe(
      'Filens kolumner kändes inte igen som en export från Länsförsäkringar. ' +
        'Kolumner i filen: Dag, Vad, Summa kronor. ' +
        'Filen behöver en datumkolumn (Bokföringsdag, Bokföringsdatum, Transaktionsdatum eller Datum) ' +
        'och en beloppskolumn (Belopp eller Insättning + Uttag). Text, Meddelande och Saldo läses om de finns.',
    )
  })

  it('carries the column report through an explicit Länsförsäkringar choice', () => {
    const result = parseBankFile(UNRELATED, 'k.csv', 'lansforsakringar')
    expect(result.format).toBe('lansforsakringar')
    expect(result.unrecognized_columns?.found).toEqual(['Dag', 'Vad', 'Summa kronor'])
  })

  it('names the columns past a heading row when no format matches at all', () => {
    const { message } = parseBankFile(UNRELATED, 'k.csv').issues[0]
    expect(message).toContain('Kolumner i filen: Dag, Vad, Summa kronor.')
    expect(message).toContain('En bankfil behöver minst en datumkolumn och en beloppskolumn.')
  })

  it('does not detect a file of another layout', () => {
    expect(lansforsakringarFormat.detect(UNRELATED, 'k.csv')).toBe(false)
  })
})

describe('Länsförsäkringar detection leaves other banks alone', () => {
  it.each([
    ['handelsbanken', 'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo\n2024-01-15;2024-01-15;SPOTIFY;-99,00;100,00'],
    ['seb', 'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo\n2024-01-15;2024-01-15;1;SPOTIFY;-99,00;100,00'],
    ['nordea_business', 'Bokföringsdatum;Valutadatum;Text;Belopp;Saldo\n2024-01-15;2024-01-15;SPOTIFY;-99,00;100,00'],
    [
      'ica_banken',
      'Kontonamn: Lönekonto\nKontonummer: 1234 567 890\nSaldo: 1,00\nDatum;Text;Typ;Budgetgrupp;Belopp;Saldo\n2024-01-15;SPOTIFY;Korttransaktion;Övrigt;-99,00;100,00',
    ],
  ])('%s', (formatId, content) => {
    expect(detectFileFormat(content, 'export.csv')?.id).toBe(formatId)
  })

  it('takes a Länsförsäkringar header with a Text column from Nordea Företag', () => {
    const csv = 'Bokföringsdag;Transaktionsdag;Typ;Text;Belopp;Saldo\n2025-10-03;2025-10-01;Kortköp;ICA;-1,00;1,00'
    expect(detectFileFormat(csv, 'k.csv')?.id).toBe('lansforsakringar')
  })
})

describe('parseLansforsakringarAmount', () => {
  it.each([
    ['-1 234,56', -1234.56],
    ['1234.5', 1234.5],
    ['-500', -500],
    ['(99,00)', -99],
    ['99,00-', -99],
    ['− 1 000,00 kr', -1000],
    ['', null],
    ['Belopp', null],
  ])('%s', (raw, expected) => {
    expect(parseLansforsakringarAmount(raw)).toBe(expected)
  })
})
