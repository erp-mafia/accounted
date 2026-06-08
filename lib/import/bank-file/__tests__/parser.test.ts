/**
 * Comprehensive tests for the bank file parser library.
 *
 * Covers auto-detection, parsing for all Swedish bank formats (Nordea, SEB,
 * Swedbank, Handelsbanken), ISO 20022 camt.053 XML, external ID generation,
 * file hashing, stats calculation, date range extraction, and edge cases.
 */

import { detectFileFormat, parseBankFile, generateExternalId, generateFileHash, getFormat, getAllFormats } from '../parser'
import type { ParsedBankTransaction, BankFileFormatId } from '../types'
import { parseGenericCSV, normalizeMinusSign } from '../formats/generic-csv'
import { parseCSVLine } from '../formats/nordea'

// ---------------------------------------------------------------------------
// Test data — realistic CSV/XML content for each Swedish bank format
// ---------------------------------------------------------------------------

const NORDEA_CSV = [
  'Datum,Transaktion,Kategori,Belopp,Saldo',
  '2024-01-15,SPOTIFY AB,,"-99,00","12 345,67"',
  '2024-01-14,ICA MAXI LINDHAGEN,,"-432,50","12 444,67"',
  '2024-01-13,LÖNEUTBETALNING,,"25 000,00","12 877,17"',
].join('\n')

const NORDEA_CSV_WITH_RESERVED = [
  'Datum,Transaktion,Kategori,Belopp,Saldo',
  '2024-01-15,SPOTIFY AB,,"-99,00","12 345,67"',
  '2024-01-14,Reserverat köp CLAS OHLSON,,"-199,00","12 444,67"',
  '2024-01-13,LÖNEUTBETALNING,,"25 000,00","12 643,67"',
].join('\n')

const NORDEA_CSV_SWEDISH_CHARS = [
  'Datum,Transaktion,Kategori,Belopp,Saldo',
  '2024-03-01,GÖTEBORGS HAMNCAFÉ,,"-85,00","5 000,00"',
  '2024-03-02,ÅHLENS CITY,,"-249,00","4 751,00"',
  '2024-03-03,ÄRLA GÅRD AB,,"1 200,00","5 951,00"',
].join('\n')

const SEB_CSV = [
  'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;12346;HEMKÖP FRIDHEMSPLAN;-432,50;12444,67',
  '2024-01-13;2024-01-13;12347;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

// SEB privatbanken web export: "Bokföringsdatum" (with ö AND -datum suffix)
const SEB_PRIVAT_CSV = [
  'Bokföringsdatum;Valutadatum;Verifikationsnummer;Text;Belopp;Saldo',
  '2025-12-30;2025-12-31;0;RÄNTA;7,84;1241,16',
  '2025-09-15;2025-09-14;5490990004;53290171515;-1000,00;1233,32',
  '2024-10-31;2024-10-31;5841990687;H31520956893;433,16;5147,56',
].join('\n')

const SWEDBANK_CSV = [
  'Kontouppgifter',
  'Clearingnummer,Kontonummer,Datum,Text,Belopp,Saldo',
  '8123,12345678,2024-01-15,SPOTIFY AB,-99.00,12345.67',
  '8123,12345678,2024-01-14,ICA MAXI,-432.50,12444.67',
  '8123,12345678,2024-01-13,LÖNEUTBETALNING,25000.00,12877.17',
].join('\n')

const SWEDBANK_CSV_NO_METADATA = [
  'Clearingnummer,Kontonummer,Datum,Text,Belopp,Saldo',
  '8123,12345678,2024-02-01,TELIA SVERIGE,-299.00,10000.00',
  '8123,12345678,2024-02-02,SKATTEVERKET INBETALNING,5000.00,15000.00',
].join('\n')

const HANDELSBANKEN_CSV = [
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;HEMKÖP;-432,50;12444,67',
  '2024-01-13;2024-01-13;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

const HANDELSBANKEN_CSV_WITH_PREL = [
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;Prel kortköp CLAS OHLSON;-199,00;12444,67',
  '2024-01-13;2024-01-13;LÖNEUTBETALNING;25000,00;12643,67',
].join('\n')

// Real Handelsbanken web exports can prepend account/period metadata rows
// (and a blank line) before the actual column header.
const HANDELSBANKEN_CSV_WITH_PREAMBLE = [
  'Kontonummer;6789 123 456 789',
  'Kontohavare;Wiklund, Cristel',
  'Period;2024-01-01 - 2024-01-31',
  '',
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;2024-01-14;HEMKÖP;-432,50;12444,67',
  '2024-01-13;2024-01-13;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

// Negative amounts exported with a Unicode minus (U+2212) instead of ASCII '-'.
const HANDELSBANKEN_CSV_UNICODE_MINUS = [
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;−139,00;12345,67',
  '2024-01-14;2024-01-14;HEMKÖP;−1 432,50;12444,67',
  '2024-01-13;2024-01-13;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

// A quoted Text field that itself contains the semicolon delimiter.
const HANDELSBANKEN_CSV_QUOTED_SEMICOLON = [
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;"BETALNING; FAKTURA 100";-99,00;12345,67',
  '2024-01-14;2024-01-14;HEMKÖP;-432,50;12444,67',
].join('\n')

const CAMT053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
<BkToCstmrStmt>
<Stmt>
<Acct><Ccy>SEK</Ccy></Acct>
<Ntry>
  <BookgDt><Dt>2024-01-15</Dt></BookgDt>
  <Amt Ccy="SEK">99.00</Amt>
  <CdtDbtInd>DBIT</CdtDbtInd>
  <NtryRef>REF001</NtryRef>
  <NtryDtls><TxDtls>
    <RmtInf><Ustrd>SPOTIFY AB</Ustrd></RmtInf>
  </TxDtls></NtryDtls>
</Ntry>
<Ntry>
  <BookgDt><Dt>2024-01-14</Dt></BookgDt>
  <Amt Ccy="SEK">25000.00</Amt>
  <CdtDbtInd>CRDT</CdtDbtInd>
  <NtryRef>REF002</NtryRef>
  <NtryDtls><TxDtls>
    <RmtInf><Ustrd>LÖNEUTBETALNING</Ustrd></RmtInf>
  </TxDtls></NtryDtls>
</Ntry>
</Stmt>
</BkToCstmrStmt>
</Document>`

const CAMT053_XML_WITH_STRUCTURED_REF = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
<BkToCstmrStmt>
<Stmt>
<Ntry>
  <BookgDt><Dt>2024-02-01</Dt></BookgDt>
  <Amt Ccy="SEK">1500.00</Amt>
  <CdtDbtInd>CRDT</CdtDbtInd>
  <NtryRef>REF100</NtryRef>
  <NtryDtls><TxDtls>
    <RmtInf>
      <Strd><CdtrRefInf><Ref>OCR123456789</Ref></CdtrRefInf></Strd>
      <Ustrd>Betalning faktura 1001</Ustrd>
    </RmtInf>
  </TxDtls></NtryDtls>
</Ntry>
</Stmt>
</BkToCstmrStmt>
</Document>`

const LANSFORSAKRINGAR_CSV = [
  '"Datum";"Bokföringsdag";"Typ";"Text";"Belopp";"Saldo"',
  '"2024-01-15";"2024-01-15";"Kortköp";"SPOTIFY AB";"-99,00";"12 345,67"',
  '"2024-01-14";"2024-01-14";"Kortköp";"ICA MAXI";"-432,50";"12 444,67"',
  '"2024-01-13";"2024-01-13";"Insättning";"LÖNEUTBETALNING";"25 000,00";"12 877,17"',
].join('\n')

const LANSFORSAKRINGAR_CSV_NO_HEADER = [
  '"2024-01-15";"2024-01-15";"Kortköp";"SPOTIFY AB";"-99,00";"12 345,67"',
  '"2024-01-14";"2024-01-14";"Kortköp";"ICA MAXI";"-432,50";"12 444,67"',
].join('\n')

const ICA_BANKEN_CSV = [
  'Kontonamn: Lönekonto',
  'Kontonummer: 1234 567 890',
  'Saldo: 12 877,17',
  'Tillgängligt belopp: 12 877,17',
  'Period: 2024-01-01 - 2024-01-31',
  'Exporterad: 2024-02-01',
  'Datum;Text;Belopp;Saldo',
  '2024-01-15;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;ICA MAXI LINDHAGEN;-432,50;12444,67',
  '2024-01-13;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

const SKANDIA_CSV = [
  'Datum;Beskrivning;Belopp;Saldo',
  '2024-01-15;SPOTIFY AB;-99,00;12345,67',
  '2024-01-14;HEMKÖP FRIDHEMSPLAN;-432,50;12444,67',
  '2024-01-13;LÖNEUTBETALNING;25000,00;12877,17',
].join('\n')

const SKANDIA_CSV_WITH_BANKKATEGORI = [
  'Datum;Beskrivning;Belopp;Saldo;Bankkategori',
  '2024-01-15;SPOTIFY AB;-99,00;12345,67;Underhållning',
  '2024-01-14;ICA MAXI;-432,50;12444,67;Livsmedel',
].join('\n')

const LUNAR_CSV = [
  'Date,Text,Amount,Balance',
  '2024-01-15,SPOTIFY AB,"-99,00","12.345,67"',
  '2024-01-14,ICA MAXI LINDHAGEN,"-432,50","12.444,67"',
  '2024-01-13,LÖNEUTBETALNING,"25.000,00","12.877,17"',
].join('\n')

// Northmill exports include a 5-line metadata preamble (Kontonummer, Saldo,
// Kontohavare, Org. Nr, Period) plus blank lines before the actual transaction
// header. Negative amounts use Unicode minus (U+2212), not ASCII hyphen.
const NORTHMILL_CSV = [
  'Kontonummer,9750-8770139',
  'Saldo,"251495,41",SEK',
  'Kontohavare,Arcim Technology AB',
  'Org. Nr,559538-6219',
  'Period,2025-10-01,2026-04-07',
  '',
  '',
  '',
  'Bokföringsdag,Beskrivning,Belopp,Saldo,Valuta',
  '2026-04-01,Månadsavgift företagspaket april,"\u2212139,00","251495,41",SEK',
  '2026-01-22,200176580348155,"\u22121000,00","251912,41",SEK',
  '2025-10-16,092221155575,"400000,00","422005,00",SEK',
  '2025-10-01,Inbetalning av aktiekapital,"25000,00","25000,00",SEK',
].join('\n')

const UNKNOWN_CSV = [
  'id,name,value,timestamp',
  '1,Widget A,100,2024-01-15T10:00:00',
  '2,Widget B,200,2024-01-16T11:00:00',
].join('\n')

const EMPTY_FILE = ''

const HEADER_ONLY_NORDEA = 'Datum,Transaktion,Kategori,Belopp,Saldo\n'

const NORDEA_BUSINESS_CSV = [
  'Bokföringsdag;Belopp;Avsändare;Mottagare;Namn;Rubrik;Saldo;Valuta',
  '2024-01-15;-99,00;;SPOTIFY AB;SPOTIFY AB;Kortköp;12 345,67;SEK',
  '2024-01-14;-432,50;;ICA MAXI;ICA MAXI LINDHAGEN;Kortköp;12 444,67;SEK',
  '2024-01-13;25 000,00;ARBETSGIVAREN AB;;ARBETSGIVAREN AB;Löneutbetalning;12 877,17;SEK',
].join('\n')

const NORDEA_BUSINESS_CSV_SWEDISH_CHARS = [
  'Bokföringsdag;Belopp;Avsändare;Mottagare;Namn;Rubrik;Saldo;Valuta',
  '2024-03-01;-85,00;;GÖTEBORGS HAMNCAFÉ;GÖTEBORGS HAMNCAFÉ;Kortköp;5 000,00;SEK',
  '2024-03-02;-249,00;;ÅHLENS CITY;ÅHLENS CITY;Kortköp;4 751,00;SEK',
  '2024-03-03;1 200,00;ÄRLA GÅRD AB;;ÄRLA GÅRD AB;Betalning;5 951,00;SEK',
].join('\n')

const HEADER_ONLY_NORDEA_BUSINESS = 'Bokföringsdag;Belopp;Avsändare;Mottagare;Namn;Rubrik;Saldo;Valuta\n'

const NORDEA_BUSINESS_CSV_VARIANT_A = [
  'Bokföringsdag;Värdedag;Betalningstyp;Betalare/Mottagare;Meddelande/Referens;Belopp;Saldo',
  '2024-01-15;2024-01-15;Kortbetalning;SPOTIFY AB;Spotify Premium;-99,00;12 345,67',
  '2024-01-14;2024-01-14;Kortbetalning;ICA MAXI;Dagligvaror;-432,50;12 444,67',
  '2024-01-13;2024-01-13;Inbetalning;ARBETSGIVAREN AB;Lön jan;25 000,00;12 877,17',
].join('\n')

const NORDEA_BUSINESS_CSV_VARIANT_B = [
  'Bokföringsdatum;Valutadatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12 345,67',
  '2024-01-14;2024-01-14;ICA MAXI LINDHAGEN;-432,50;12 444,67',
  '2024-01-13;2024-01-13;LÖNEUTBETALNING;25 000,00;12 877,17',
].join('\n')

const NORDEA_BUSINESS_CSV_VARIANT_C = [
  'Datum;Belopp;Avsändare;Mottagare;Namn;Ytterligare detaljer;Meddelande;Egna anteckningar;Saldo;Valuta;',
  '2026/03/02;-18,84;;;;Kortköp 260301 Google Workspace_elv;Google Workspac 7028;;10686,66;SEK;',
  '2026/02/04;-1,85;;;;AVGIFTER NORDEA;;;10705,50;SEK;',
  '2026/02/02;-87,14;;;;Kortköp 260201 Google Workspace_elv;Google Workspac 7028;;10707,35;SEK;',
  '2026/01/15;15000,00;KUNDFÖRETAG AB;;;;Inbetalning;;25707,35;SEK;',
].join('\n')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectFileFormat', () => {
  it('detects Nordea CSV from header keywords', () => {
    const format = detectFileFormat(NORDEA_CSV, 'transaktioner.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea')
  })

  it('detects Nordea Business CSV from semicolon-delimited header with bokföringsdag and rubrik', () => {
    const format = detectFileFormat(NORDEA_BUSINESS_CSV, 'PLUSGIROKONTO FTG 212 68 87-5.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea_business')
  })

  it('does not confuse Nordea Business with SEB (SEB has valutadag)', () => {
    const format = detectFileFormat(NORDEA_BUSINESS_CSV, 'export.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea_business')
  })

  it('detects Nordea Business CSV variant with Betalare/Mottagare combined column', () => {
    const format = detectFileFormat(NORDEA_BUSINESS_CSV_VARIANT_A, 'nordea_ftg.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea_business')
  })

  it('detects Nordea Business CSV variant with Bokföringsdatum header', () => {
    const format = detectFileFormat(NORDEA_BUSINESS_CSV_VARIANT_B, 'nordea_ftg.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea_business')
  })

  it('detects Nordea Business CSV variant with standalone Datum header and YYYY/MM/DD dates', () => {
    const format = detectFileFormat(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea_business')
  })

  it('does not confuse Nordea Datum variant with Länsförsäkringar (which has Datum + Typ)', () => {
    // Nordea Format D has Datum without Typ — must not be mistaken for LF
    const format = detectFileFormat(NORDEA_BUSINESS_CSV_VARIANT_C, 'export.csv')
    expect(format!.id).toBe('nordea_business')
  })

  it('does not misidentify SEB as Nordea Business when valutadag is present', () => {
    const sebLike = 'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo\n2024-01-15;2024-01-15;123;SPOTIFY;-99,00;12345,67'
    const format = detectFileFormat(sebLike, 'export.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('seb')
  })

  it('detects SEB CSV from semicolon-delimited header with bokföringsdag', () => {
    const format = detectFileFormat(SEB_CSV, 'kontoutdrag.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('seb')
  })

  it('detects Swedbank CSV from clearingnummer header', () => {
    const format = detectFileFormat(SWEDBANK_CSV, 'export.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('swedbank')
  })

  it('detects Swedbank CSV when header is on the first line (no metadata)', () => {
    const format = detectFileFormat(SWEDBANK_CSV_NO_METADATA, 'export.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('swedbank')
  })

  it('detects Handelsbanken CSV from reskontradatum/transaktionsdatum header', () => {
    const format = detectFileFormat(HANDELSBANKEN_CSV, 'handelsbanken.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('handelsbanken')
  })

  it('detects camt.053 XML from namespace and .xml extension', () => {
    const format = detectFileFormat(CAMT053_XML, 'statement.xml')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('camt053')
  })

  it('detects camt.053 XML when content includes BkToCstmrStmt tag', () => {
    const xmlContent = '<?xml version="1.0"?><Document><BkToCstmrStmt></BkToCstmrStmt></Document>'
    const format = detectFileFormat(xmlContent, 'data.xml')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('camt053')
  })

  it('does not detect camt.053 without .xml extension', () => {
    // camt053 detection requires .xml extension
    const format = detectFileFormat(CAMT053_XML, 'statement.csv')
    // It should not match camt053 since extension is .csv
    // But it could match something else if the content resembles a CSV header
    // The important check is that it does NOT return camt053
    if (format) {
      expect(format.id).not.toBe('camt053')
    }
  })

  it('detects Länsförsäkringar CSV from header with "typ" keyword', () => {
    const format = detectFileFormat(LANSFORSAKRINGAR_CSV, 'lansforsakringar.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('lansforsakringar')
  })

  it('detects Länsförsäkringar CSV from two adjacent date fields (no header)', () => {
    const format = detectFileFormat(LANSFORSAKRINGAR_CSV_NO_HEADER, 'export.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('lansforsakringar')
  })

  it('detects ICA Banken CSV from metadata rows before header', () => {
    const format = detectFileFormat(ICA_BANKEN_CSV, 'ica.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('ica_banken')
  })

  it('detects Skandia CSV from "beskrivning" header keyword', () => {
    const format = detectFileFormat(SKANDIA_CSV, 'skandia.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('skandia')
  })

  it('detects Skandia CSV from "bankkategori" header keyword', () => {
    const format = detectFileFormat(SKANDIA_CSV_WITH_BANKKATEGORI, 'skandia.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('skandia')
  })

  it('detects Lunar CSV from English headers (date, text, amount, balance)', () => {
    const format = detectFileFormat(LUNAR_CSV, 'lunar.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('lunar')
  })

  it('detects Northmill CSV from Kontonummer preamble + transaction header', () => {
    const format = detectFileFormat(NORTHMILL_CSV, 'Northmill-Account-Statement.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('northmill')
  })

  it('does not detect Northmill on a file that just happens to mention Kontonummer in transactions', () => {
    const fake = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-01-15,Överföring kontonummer 1234,Inkomst,"100,00","1000,00"',
    ].join('\n')
    const format = detectFileFormat(fake, 'test.csv')
    // Should detect as Nordea, not Northmill — Northmill needs Kontonummer at start of first line
    expect(format!.id).toBe('nordea')
  })

  it('returns null for unrecognized CSV content', () => {
    const format = detectFileFormat(UNKNOWN_CSV, 'data.csv')
    expect(format).toBeNull()
  })

  it('returns null for empty content', () => {
    const format = detectFileFormat(EMPTY_FILE, 'empty.csv')
    expect(format).toBeNull()
  })

  it('generic_csv format never auto-detects', () => {
    // Even with simple CSV content, generic should not be picked
    const simpleCSV = 'date,description,amount\n2024-01-15,Test,-100'
    const format = detectFileFormat(simpleCSV, 'test.csv')
    if (format) {
      expect(format.id).not.toBe('generic_csv')
    }
  })

  it('is case-insensitive on header detection', () => {
    const upperNordea = 'DATUM,TRANSAKTION,KATEGORI,BELOPP,SALDO\n2024-01-15,Test,,"-100,00","5000,00"'
    const format = detectFileFormat(upperNordea, 'test.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('nordea')
  })
})

describe('parseBankFile — Nordea format', () => {
  it('parses comma-delimited CSV with comma decimal separator', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    expect(result.format).toBe('nordea')
    expect(result.format_name).toBe('Nordea')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses negative amounts with comma decimal and space thousands', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    const spotify = result.transactions[0]
    expect(spotify.amount).toBe(-99)
    expect(spotify.description).toBe('SPOTIFY AB')
    expect(spotify.date).toBe('2024-01-15')
    expect(spotify.currency).toBe('SEK')

    const ica = result.transactions[1]
    expect(ica.amount).toBe(-432.5)
  })

  it('correctly parses positive amounts with space thousands separator', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    const salary = result.transactions[2]
    expect(salary.amount).toBe(25000)
    expect(salary.description).toBe('LÖNEUTBETALNING')
  })

  it('parses balance field with space thousands separator', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    const spotify = result.transactions[0]
    expect(spotify.balance).toBe(12345.67)
  })

  it('filters out "Reserverat" (pending) transactions', () => {
    const result = parseBankFile(NORDEA_CSV_WITH_RESERVED, 'nordea.csv')

    expect(result.transactions).toHaveLength(2)
    expect(result.stats.skipped_rows).toBe(1)

    const descriptions = result.transactions.map((t) => t.description)
    expect(descriptions).not.toContain(expect.stringContaining('Reserverat'))
  })

  it('handles Swedish characters (a-ring, a-diaeresis, o-diaeresis)', () => {
    const result = parseBankFile(NORDEA_CSV_SWEDISH_CHARS, 'nordea.csv')

    expect(result.transactions).toHaveLength(3)
    expect(result.transactions[0].description).toBe('GÖTEBORGS HAMNCAFÉ')
    expect(result.transactions[1].description).toBe('ÅHLENS CITY')
    expect(result.transactions[2].description).toBe('ÄRLA GÅRD AB')
  })

  it('stores raw_line for each transaction', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    result.transactions.forEach((tx) => {
      expect(tx.raw_line).toBeDefined()
      expect(tx.raw_line!.length).toBeGreaterThan(0)
    })
  })

  it('handles header-only file with no data rows', () => {
    const result = parseBankFile(HEADER_ONLY_NORDEA, 'nordea.csv')

    expect(result.format).toBe('nordea')
    expect(result.transactions).toHaveLength(0)
    expect(result.date_from).toBeNull()
    expect(result.date_to).toBeNull()
    expect(result.stats.parsed_rows).toBe(0)
  })
})

describe('parseBankFile — Nordea Business format', () => {
  it('parses semicolon-delimited CSV with correct columns', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    expect(result.format).toBe('nordea_business')
    expect(result.format_name).toBe('Nordea Företag')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses negative amounts', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    const spotify = result.transactions[0]
    expect(spotify.amount).toBe(-99)
    expect(spotify.date).toBe('2024-01-15')
    expect(spotify.currency).toBe('SEK')
  })

  it('correctly parses positive amounts with space thousands separator', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    const salary = result.transactions[2]
    expect(salary.amount).toBe(25000)
    expect(salary.date).toBe('2024-01-13')
  })

  it('builds description from Namn and Rubrik columns', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    const spotify = result.transactions[0]
    expect(spotify.description).toBe('SPOTIFY AB — Kortköp')

    const salary = result.transactions[2]
    expect(salary.description).toBe('ARBETSGIVAREN AB — Löneutbetalning')
  })

  it('extracts counterparty from Mottagare (expense) or Avsändare (income)', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    // Expense: counterparty from Mottagare
    expect(result.transactions[0].counterparty).toBe('SPOTIFY AB')
    // Income: counterparty from Avsändare
    expect(result.transactions[2].counterparty).toBe('ARBETSGIVAREN AB')
  })

  it('parses balance field', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    expect(result.transactions[0].balance).toBe(12345.67)
    expect(result.transactions[2].balance).toBe(12877.17)
  })

  it('handles Swedish characters', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_SWEDISH_CHARS, 'nordea_ftg.csv')

    expect(result.transactions).toHaveLength(3)
    expect(result.transactions[0].description).toContain('GÖTEBORGS HAMNCAFÉ')
    expect(result.transactions[1].description).toContain('ÅHLENS CITY')
    expect(result.transactions[2].description).toContain('ÄRLA GÅRD AB')
  })

  it('stores raw_line for each transaction', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    result.transactions.forEach((tx) => {
      expect(tx.raw_line).toBeDefined()
      expect(tx.raw_line!.length).toBeGreaterThan(0)
    })
  })

  it('handles header-only file with no data rows', () => {
    const result = parseBankFile(HEADER_ONLY_NORDEA_BUSINESS, 'nordea_ftg.csv')

    expect(result.format).toBe('nordea_business')
    expect(result.transactions).toHaveLength(0)
    expect(result.date_from).toBeNull()
    expect(result.date_to).toBeNull()
    expect(result.stats.parsed_rows).toBe(0)
  })

  it('calculates correct date range', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    expect(result.date_from).toBe('2024-01-13')
    expect(result.date_to).toBe('2024-01-15')
  })

  it('calculates correct income and expense stats', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV, 'nordea_ftg.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
    expect(result.stats.skipped_rows).toBe(0)
  })
})

describe('parseBankFile — Nordea Business variant A (Betalare/Mottagare)', () => {
  it('parses the alternate Nordea Business format with combined party column', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_A, 'nordea_ftg.csv')

    expect(result.format).toBe('nordea_business')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('builds description from Betalningstyp and Meddelande/Referens', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_A, 'nordea_ftg.csv')

    expect(result.transactions[0].description).toBe('Kortbetalning — Spotify Premium')
    expect(result.transactions[2].description).toBe('Inbetalning — Lön jan')
  })

  it('extracts counterparty from combined Betalare/Mottagare column', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_A, 'nordea_ftg.csv')

    expect(result.transactions[0].counterparty).toBe('SPOTIFY AB')
    expect(result.transactions[2].counterparty).toBe('ARBETSGIVAREN AB')
  })

  it('parses amounts and dates correctly', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_A, 'nordea_ftg.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].date).toBe('2024-01-15')
    expect(result.transactions[2].amount).toBe(25000)
  })
})

describe('parseBankFile — Nordea Business variant B (Bokföringsdatum)', () => {
  it('parses the simple Nordea Business format with Bokföringsdatum', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_B, 'nordea_ftg.csv')

    expect(result.format).toBe('nordea_business')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('builds description from Text column', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_B, 'nordea_ftg.csv')

    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[2].description).toBe('LÖNEUTBETALNING')
  })

  it('parses amounts correctly', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_B, 'nordea_ftg.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(-432.5)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('calculates correct stats', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_B, 'nordea_ftg.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })
})

describe('parseBankFile — Nordea Business variant C (Datum + YYYY/MM/DD)', () => {
  it('parses the Nordea format with Datum header and slash dates', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.format).toBe('nordea_business')
    expect(result.transactions).toHaveLength(4)
    expect(result.issues).toHaveLength(0)
    expect(result.stats.skipped_rows).toBe(0)
  })

  it('normalizes YYYY/MM/DD dates to YYYY-MM-DD', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.transactions[0].date).toBe('2026-03-02')
    expect(result.transactions[1].date).toBe('2026-02-04')
    expect(result.transactions[3].date).toBe('2026-01-15')
  })

  it('builds description from Ytterligare detaljer column', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.transactions[0].description).toBe('Kortköp 260301 Google Workspace_elv')
    expect(result.transactions[1].description).toBe('AVGIFTER NORDEA')
  })

  it('extracts counterparty from Avsändare for income', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.transactions[3].counterparty).toBe('KUNDFÖRETAG AB')
    expect(result.transactions[3].amount).toBe(15000)
  })

  it('parses amounts and balance correctly with comma decimals', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.transactions[0].amount).toBe(-18.84)
    expect(result.transactions[0].balance).toBe(10686.66)
    expect(result.transactions[0].currency).toBe('SEK')
  })

  it('handles trailing semicolons in header and data rows', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.stats.parsed_rows).toBe(4)
    expect(result.stats.total_income).toBe(15000)
    expect(result.stats.total_expenses).toBe(-107.83)
  })

  it('calculates correct date range', () => {
    const result = parseBankFile(NORDEA_BUSINESS_CSV_VARIANT_C, 'nordea_ftg.csv')

    expect(result.date_from).toBe('2026-01-15')
    expect(result.date_to).toBe('2026-03-02')
  })
})

describe('parseBankFile — SEB format', () => {
  it('parses semicolon-delimited CSV with comma decimal separator', () => {
    const result = parseBankFile(SEB_CSV, 'seb.csv')

    expect(result.format).toBe('seb')
    expect(result.format_name).toBe('SEB')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly extracts columns using dynamic header mapping', () => {
    const result = parseBankFile(SEB_CSV, 'seb.csv')

    const spotify = result.transactions[0]
    expect(spotify.date).toBe('2024-01-15')
    expect(spotify.description).toBe('SPOTIFY AB')
    expect(spotify.amount).toBe(-99)
    expect(spotify.balance).toBe(12345.67)
  })

  it('parses positive income amounts correctly', () => {
    const result = parseBankFile(SEB_CSV, 'seb.csv')

    const salary = result.transactions[2]
    expect(salary.amount).toBe(25000)
    expect(salary.description).toBe('LÖNEUTBETALNING')
  })

  it('handles alternative SEB header names', () => {
    const altSEB = [
      'Bokforingsdatum;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
      '2024-01-15;2024-01-15;12345;TEST;-50,00;1000,00',
    ].join('\n')

    const result = parseBankFile(altSEB, 'seb_alt.csv')
    expect(result.format).toBe('seb')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].amount).toBe(-50)
  })

  it('auto-detects SEB privatbanken variant with Bokföringsdatum + Valutadatum headers', () => {
    const format = detectFileFormat(SEB_PRIVAT_CSV, 'kontoutdrag.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('seb')
  })

  it('parses SEB privatbanken CSV (Bokföringsdatum / Valutadatum / RÄNTA / negative amounts)', () => {
    const result = parseBankFile(SEB_PRIVAT_CSV, 'kontoutdrag.csv')

    expect(result.format).toBe('seb')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)

    const ranta = result.transactions[0]
    expect(ranta.date).toBe('2025-12-30')
    expect(ranta.description).toBe('RÄNTA')
    expect(ranta.amount).toBe(7.84)
    expect(ranta.balance).toBe(1241.16)

    const withdrawal = result.transactions[1]
    expect(withdrawal.date).toBe('2025-09-15')
    expect(withdrawal.amount).toBe(-1000)

    const deposit = result.transactions[2]
    expect(deposit.amount).toBe(433.16)
  })
})

describe('parseBankFile — Swedbank format', () => {
  it('parses comma-delimited CSV with PERIOD decimal separator', () => {
    const result = parseBankFile(SWEDBANK_CSV, 'swedbank.csv')

    expect(result.format).toBe('swedbank')
    expect(result.format_name).toBe('Swedbank')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly handles period decimal separator (the Swedish exception)', () => {
    const result = parseBankFile(SWEDBANK_CSV, 'swedbank.csv')

    const spotify = result.transactions[0]
    expect(spotify.amount).toBe(-99)
    expect(spotify.balance).toBe(12345.67)

    const ica = result.transactions[1]
    expect(ica.amount).toBe(-432.5)
  })

  it('skips metadata line when present (first line is account info)', () => {
    const result = parseBankFile(SWEDBANK_CSV, 'swedbank.csv')

    // With metadata line, there are 3 data rows after headerLineIdx=1
    expect(result.transactions).toHaveLength(3)
    // No transaction should have "Kontouppgifter" as description
    const descriptions = result.transactions.map((t) => t.description)
    expect(descriptions).not.toContain('Kontouppgifter')
  })

  it('works when header is on the first line (no metadata)', () => {
    const result = parseBankFile(SWEDBANK_CSV_NO_METADATA, 'swedbank.csv')

    expect(result.format).toBe('swedbank')
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].amount).toBe(-299)
    expect(result.transactions[1].amount).toBe(5000)
  })

  it('extracts dates correctly', () => {
    const result = parseBankFile(SWEDBANK_CSV, 'swedbank.csv')

    expect(result.transactions[0].date).toBe('2024-01-15')
    expect(result.transactions[2].date).toBe('2024-01-13')
  })
})

describe('parseBankFile — Handelsbanken format', () => {
  it('parses semicolon-delimited CSV with comma decimal separator', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV, 'handelsbanken.csv')

    expect(result.format).toBe('handelsbanken')
    expect(result.format_name).toBe('Handelsbanken')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses amounts and balances', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV, 'handelsbanken.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].balance).toBe(12345.67)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('filters out "Prel" (preliminary) transactions', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV_WITH_PREL, 'handelsbanken.csv')

    expect(result.transactions).toHaveLength(2)
    expect(result.stats.skipped_rows).toBe(1)

    const descriptions = result.transactions.map((t) => t.description)
    expect(descriptions).not.toContain(expect.stringContaining('Prel'))
  })

  it('prefers transaktionsdatum over reskontradatum when both are present', () => {
    // Handelsbanken has both columns; transaktionsdatum should be used
    const result = parseBankFile(HANDELSBANKEN_CSV, 'handelsbanken.csv')

    // In our test data both dates are the same, but verify it selects dates properly
    expect(result.transactions[0].date).toBe('2024-01-15')
  })

  it('uses transaktionsdatum as the primary date field', () => {
    // Create data where reskontradatum differs from transaktionsdatum
    const diffDates = [
      'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
      '2024-01-16;2024-01-15;PURCHASE;-100,00;5000,00',
    ].join('\n')

    const result = parseBankFile(diffDates, 'shb.csv')
    expect(result.transactions[0].date).toBe('2024-01-15')
  })

  it('detects Handelsbanken CSV when a metadata preamble precedes the header', () => {
    const format = detectFileFormat(HANDELSBANKEN_CSV_WITH_PREAMBLE, 'kontoutdrag.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('handelsbanken')
  })

  it('skips the metadata preamble rows and parses the transactions', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV_WITH_PREAMBLE, 'kontoutdrag.csv')

    expect(result.format).toBe('handelsbanken')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
    expect(result.stats.skipped_rows).toBe(0)

    const descriptions = result.transactions.map((t) => t.description)
    expect(descriptions).not.toContain('Kontonummer')
    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('parses negative amounts that use a Unicode minus (U+2212) instead of dropping them', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV_UNICODE_MINUS, 'shb.csv')

    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
    expect(result.stats.skipped_rows).toBe(0)
    expect(result.transactions[0].amount).toBe(-139)
    expect(result.transactions[1].amount).toBe(-1432.5)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('handles a quoted Text field that contains the semicolon delimiter', () => {
    const result = parseBankFile(HANDELSBANKEN_CSV_QUOTED_SEMICOLON, 'shb.csv')

    expect(result.transactions).toHaveLength(2)
    expect(result.issues).toHaveLength(0)
    expect(result.transactions[0].description).toBe('BETALNING; FAKTURA 100')
    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(-432.5)
  })
})

describe('parseBankFile — Länsförsäkringar format', () => {
  it('parses semicolon-delimited CSV with quoted fields and comma decimal separator', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV, 'lf.csv')

    expect(result.format).toBe('lansforsakringar')
    expect(result.format_name).toBe('Länsförsäkringar')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses amounts with comma decimal and space thousands', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV, 'lf.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[0].date).toBe('2024-01-15')

    expect(result.transactions[1].amount).toBe(-432.5)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('parses balance field', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV, 'lf.csv')

    expect(result.transactions[0].balance).toBe(12345.67)
  })

  it('handles files without a header row (data-only)', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV_NO_HEADER, 'lf.csv')

    expect(result.format).toBe('lansforsakringar')
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(-432.5)
  })

  it('calculates stats correctly', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV, 'lf.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })

  it('extracts correct date range', () => {
    const result = parseBankFile(LANSFORSAKRINGAR_CSV, 'lf.csv')

    expect(result.date_from).toBe('2024-01-13')
    expect(result.date_to).toBe('2024-01-15')
  })
})

describe('parseBankFile — ICA Banken format', () => {
  it('parses semicolon-delimited CSV with metadata rows before header', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    expect(result.format).toBe('ica_banken')
    expect(result.format_name).toBe('ICA Banken')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('skips metadata rows and finds the correct header', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    // No transaction should contain metadata text
    const descriptions = result.transactions.map((t) => t.description)
    expect(descriptions).not.toContain(expect.stringContaining('Kontonamn'))
    expect(descriptions).not.toContain(expect.stringContaining('Exporterad'))
  })

  it('correctly parses amounts with comma decimal separator', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[0].date).toBe('2024-01-15')

    expect(result.transactions[1].amount).toBe(-432.5)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('parses balance field', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    expect(result.transactions[0].balance).toBe(12345.67)
  })

  it('calculates stats correctly', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })

  it('extracts correct date range', () => {
    const result = parseBankFile(ICA_BANKEN_CSV, 'ica.csv')

    expect(result.date_from).toBe('2024-01-13')
    expect(result.date_to).toBe('2024-01-15')
  })
})

describe('parseBankFile — Skandia format', () => {
  it('parses semicolon-delimited CSV with comma decimal separator', () => {
    const result = parseBankFile(SKANDIA_CSV, 'skandia.csv')

    expect(result.format).toBe('skandia')
    expect(result.format_name).toBe('Skandia')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses amounts and descriptions', () => {
    const result = parseBankFile(SKANDIA_CSV, 'skandia.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[0].date).toBe('2024-01-15')

    expect(result.transactions[1].amount).toBe(-432.5)
    expect(result.transactions[1].description).toBe('HEMKÖP FRIDHEMSPLAN')
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('parses balance field', () => {
    const result = parseBankFile(SKANDIA_CSV, 'skandia.csv')

    expect(result.transactions[0].balance).toBe(12345.67)
  })

  it('handles files with bankkategori column', () => {
    const result = parseBankFile(SKANDIA_CSV_WITH_BANKKATEGORI, 'skandia.csv')

    expect(result.format).toBe('skandia')
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(-432.5)
  })

  it('calculates stats correctly', () => {
    const result = parseBankFile(SKANDIA_CSV, 'skandia.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })

  it('extracts correct date range', () => {
    const result = parseBankFile(SKANDIA_CSV, 'skandia.csv')

    expect(result.date_from).toBe('2024-01-13')
    expect(result.date_to).toBe('2024-01-15')
  })
})

describe('parseBankFile — Lunar format', () => {
  it('parses comma-delimited CSV with English headers', () => {
    const result = parseBankFile(LUNAR_CSV, 'lunar.csv')

    expect(result.format).toBe('lunar')
    expect(result.format_name).toBe('Lunar')
    expect(result.transactions).toHaveLength(3)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses amounts with comma decimal and period thousand separator', () => {
    const result = parseBankFile(LUNAR_CSV, 'lunar.csv')

    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[0].description).toBe('SPOTIFY AB')
    expect(result.transactions[0].date).toBe('2024-01-15')

    expect(result.transactions[1].amount).toBe(-432.5)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('parses balance field with period thousand separator', () => {
    const result = parseBankFile(LUNAR_CSV, 'lunar.csv')

    expect(result.transactions[0].balance).toBe(12345.67)
    expect(result.transactions[2].balance).toBe(12877.17)
  })

  it('calculates stats correctly', () => {
    const result = parseBankFile(LUNAR_CSV, 'lunar.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })

  it('extracts correct date range', () => {
    const result = parseBankFile(LUNAR_CSV, 'lunar.csv')

    expect(result.date_from).toBe('2024-01-13')
    expect(result.date_to).toBe('2024-01-15')
  })

  it('does not confuse Lunar (English) with Nordea (Swedish) headers', () => {
    // Nordea has Swedish headers, Lunar has English
    const nordeaResult = detectFileFormat(NORDEA_CSV, 'test.csv')
    const lunarResult = detectFileFormat(LUNAR_CSV, 'test.csv')

    expect(nordeaResult!.id).toBe('nordea')
    expect(lunarResult!.id).toBe('lunar')
  })
})

describe('parseBankFile — Northmill format', () => {
  it('skips the 5-line metadata preamble and blank lines, parses transaction rows', () => {
    const result = parseBankFile(NORTHMILL_CSV, 'Northmill.csv')

    expect(result.format).toBe('northmill')
    expect(result.format_name).toBe('Northmill')
    expect(result.transactions).toHaveLength(4)
    expect(result.issues).toHaveLength(0)
  })

  it('correctly parses negative amounts that use Unicode minus (U+2212)', () => {
    const result = parseBankFile(NORTHMILL_CSV, 'Northmill.csv')

    // First transaction is "−139,00" with U+2212 — must become -139, not NaN
    expect(result.transactions[0].amount).toBe(-139)
    expect(result.transactions[0].description).toBe('Månadsavgift företagspaket april')
    expect(result.transactions[0].date).toBe('2026-04-01')

    expect(result.transactions[1].amount).toBe(-1000)
    expect(result.transactions[2].amount).toBe(400000)
    expect(result.transactions[3].amount).toBe(25000)
  })

  it('extracts the saldo (running balance) column', () => {
    const result = parseBankFile(NORTHMILL_CSV, 'Northmill.csv')

    expect(result.transactions[0].balance).toBe(251495.41)
    expect(result.transactions[3].balance).toBe(25000)
  })

  it('calculates income vs expenses correctly with Unicode minus amounts', () => {
    const result = parseBankFile(NORTHMILL_CSV, 'Northmill.csv')

    expect(result.stats.total_income).toBe(425000)
    expect(result.stats.total_expenses).toBe(-1139)
    expect(result.stats.parsed_rows).toBe(4)
    expect(result.stats.skipped_rows).toBe(0)
  })

  it('extracts the correct date range from the transactions, not the Period metadata row', () => {
    const result = parseBankFile(NORTHMILL_CSV, 'Northmill.csv')

    expect(result.date_from).toBe('2025-10-01')
    expect(result.date_to).toBe('2026-04-01')
  })
})

describe('parseBankFile — camt.053 XML format', () => {
  it('parses XML with credit and debit entries', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    expect(result.format).toBe('camt053')
    expect(result.format_name).toBe('ISO 20022 camt.053')
    expect(result.transactions).toHaveLength(2)
  })

  it('applies DBIT indicator as negative amount', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    const debit = result.transactions.find((t) => t.description === 'SPOTIFY AB')
    expect(debit).toBeDefined()
    expect(debit!.amount).toBe(-99)
  })

  it('applies CRDT indicator as positive amount', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    const credit = result.transactions.find((t) => t.description === 'LÖNEUTBETALNING')
    expect(credit).toBeDefined()
    expect(credit!.amount).toBe(25000)
  })

  it('extracts entry reference into raw_line for external ID generation', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    const debit = result.transactions[0]
    expect(debit.raw_line).toBe('REF001')
  })

  it('extracts OCR reference from structured remittance info', () => {
    const result = parseBankFile(CAMT053_XML_WITH_STRUCTURED_REF, 'statement.xml')

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].reference).toBe('OCR123456789')
  })

  it('uses unstructured remittance info as description', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    expect(result.transactions[0].description).toBe('SPOTIFY AB')
  })

  it('extracts currency from Amount element', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    result.transactions.forEach((tx) => {
      expect(tx.currency).toBe('SEK')
    })
  })

  it('handles XML with no Ntry elements', () => {
    const emptyXml = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
<BkToCstmrStmt><Stmt></Stmt></BkToCstmrStmt></Document>`

    const result = parseBankFile(emptyXml, 'empty.xml')

    expect(result.format).toBe('camt053')
    expect(result.transactions).toHaveLength(0)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0].message).toContain('No <Ntry> elements')
  })
})

describe('parseBankFile — explicit format override', () => {
  it('uses the specified format instead of auto-detection', () => {
    // Force parsing Nordea content as SEB (will produce issues but should use SEB format)
    const result = parseBankFile(
      'Datum,Transaktion,Kategori,Belopp,Saldo\n2024-01-15,Test,,"-100,00","5000,00"',
      'nordea.csv',
      'seb'
    )

    expect(result.format).toBe('seb')
  })

  it('returns error for unknown formatId', () => {
    const result = parseBankFile(NORDEA_CSV, 'test.csv', 'unknown_format' as BankFileFormatId)

    expect(result.format).toBe('unknown_format')
    expect(result.format_name).toBe('Unknown')
    expect(result.transactions).toHaveLength(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].message).toContain('Unknown format')
  })

  it('returns format detection error when no format matches and no override given', () => {
    const result = parseBankFile(UNKNOWN_CSV, 'unknown.csv')

    expect(result.format).toBe('generic_csv')
    expect(result.format_name).toBe('Unknown')
    expect(result.transactions).toHaveLength(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].message).toContain('Kunde inte identifiera bankformat')
  })

  it('can force generic_csv format by explicit ID', () => {
    const csvContent = '2024-01-15,Some purchase,-50.00\n2024-01-16,Income,1000.00'
    const result = parseBankFile(csvContent, 'test.csv', 'generic_csv')

    // generic_csv uses a default mapping (date=0, description=1, amount=2)
    // But the first line is treated as header (skip_rows=1), so only second row is data
    expect(result.format).toBe('generic_csv')
  })
})

describe('generateExternalId', () => {
  const baseTx: ParsedBankTransaction = {
    date: '2024-01-15',
    description: 'SPOTIFY AB',
    amount: -99,
    currency: 'SEK',
    balance: 12345.67,
    reference: null,
    counterparty: null,
    raw_line: '2024-01-15,SPOTIFY AB,,"-99,00","12 345,67"',
  }

  it('generates SHA-256 composite key for CSV formats', () => {
    const id = generateExternalId(baseTx, 'nordea', 0)

    expect(id).toMatch(/^nordea_[0-9a-f]{16}$/)
  })

  it('generates different IDs for different row indices (same transaction data)', () => {
    const id1 = generateExternalId(baseTx, 'nordea', 0)
    const id2 = generateExternalId(baseTx, 'nordea', 1)

    expect(id1).not.toBe(id2)
  })

  it('generates different IDs for different formats (same data, same row index)', () => {
    const nordeaId = generateExternalId(baseTx, 'nordea', 0)
    const sebId = generateExternalId(baseTx, 'seb', 0)

    expect(nordeaId).not.toBe(sebId)
  })

  it('generates deterministic IDs for the same inputs', () => {
    const id1 = generateExternalId(baseTx, 'nordea', 0)
    const id2 = generateExternalId(baseTx, 'nordea', 0)

    expect(id1).toBe(id2)
  })

  it('uses entry reference for camt.053 transactions with NtryRef', () => {
    const camtTx: ParsedBankTransaction = {
      date: '2024-01-15',
      description: 'SPOTIFY AB',
      amount: -99,
      currency: 'SEK',
      raw_line: 'REF001', // NtryRef stored in raw_line
    }

    const id = generateExternalId(camtTx, 'camt053', 0)

    expect(id).toBe('camt053_REF001')
  })

  it('falls back to hash for camt.053 when raw_line starts with camt053_entry_', () => {
    const camtTx: ParsedBankTransaction = {
      date: '2024-01-15',
      description: 'SPOTIFY AB',
      amount: -99,
      currency: 'SEK',
      raw_line: 'camt053_entry_0', // Auto-generated fallback reference
    }

    const id = generateExternalId(camtTx, 'camt053', 0)

    // Should fall through to hash-based ID since raw_line starts with 'camt053_entry_'
    expect(id).toMatch(/^camt053_[0-9a-f]{16}$/)
  })

  it('falls back to hash for camt.053 when raw_line is undefined', () => {
    const camtTx: ParsedBankTransaction = {
      date: '2024-01-15',
      description: 'SPOTIFY AB',
      amount: -99,
      currency: 'SEK',
    }

    const id = generateExternalId(camtTx, 'camt053', 0)

    expect(id).toMatch(/^camt053_[0-9a-f]{16}$/)
  })

  it('includes amount in hash so different amounts produce different IDs', () => {
    const tx1 = { ...baseTx, amount: -99 }
    const tx2 = { ...baseTx, amount: -100 }

    const id1 = generateExternalId(tx1, 'nordea', 0)
    const id2 = generateExternalId(tx2, 'nordea', 0)

    expect(id1).not.toBe(id2)
  })

  it('includes description in hash so different descriptions produce different IDs', () => {
    const tx1 = { ...baseTx, description: 'SPOTIFY AB' }
    const tx2 = { ...baseTx, description: 'NETFLIX' }

    const id1 = generateExternalId(tx1, 'nordea', 0)
    const id2 = generateExternalId(tx2, 'nordea', 0)

    expect(id1).not.toBe(id2)
  })
})

describe('generateFileHash', () => {
  it('returns a SHA-256 hex string', () => {
    const hash = generateFileHash(NORDEA_CSV)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces deterministic output for the same input', () => {
    const hash1 = generateFileHash(NORDEA_CSV)
    const hash2 = generateFileHash(NORDEA_CSV)

    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different content', () => {
    const hash1 = generateFileHash(NORDEA_CSV)
    const hash2 = generateFileHash(SEB_CSV)

    expect(hash1).not.toBe(hash2)
  })

  it('produces different hash even for tiny content differences', () => {
    const hash1 = generateFileHash('abc')
    const hash2 = generateFileHash('abd')

    expect(hash1).not.toBe(hash2)
  })

  it('handles empty string', () => {
    const hash = generateFileHash('')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('stats calculation', () => {
  it('calculates total_income as sum of positive amounts (Nordea)', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    expect(result.stats.total_income).toBe(25000)
  })

  it('calculates total_expenses as sum of negative amounts (Nordea)', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    // -99 + -432.5 = -531.5
    expect(result.stats.total_expenses).toBe(-531.5)
  })

  it('calculates parsed_rows correctly', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    expect(result.stats.parsed_rows).toBe(3)
  })

  it('calculates total_rows (excluding header)', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    // 4 lines total - 1 header = 3 data rows
    expect(result.stats.total_rows).toBe(3)
  })

  it('tracks skipped_rows for reserved/preliminary transactions', () => {
    const result = parseBankFile(NORDEA_CSV_WITH_RESERVED, 'nordea.csv')

    expect(result.stats.skipped_rows).toBe(1)
    expect(result.stats.parsed_rows).toBe(2)
  })

  it('calculates stats correctly for SEB format', () => {
    const result = parseBankFile(SEB_CSV, 'seb.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
    expect(result.stats.skipped_rows).toBe(0)
  })

  it('calculates stats correctly for Swedbank format', () => {
    const result = parseBankFile(SWEDBANK_CSV, 'swedbank.csv')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-531.5)
    expect(result.stats.parsed_rows).toBe(3)
  })

  it('calculates stats correctly for camt.053 XML', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    expect(result.stats.total_income).toBe(25000)
    expect(result.stats.total_expenses).toBe(-99)
    expect(result.stats.parsed_rows).toBe(2)
    expect(result.stats.total_rows).toBe(2)
  })

  it('uses Math.round(x * 100) / 100 for monetary precision', () => {
    // Create a file that would produce floating point imprecision
    const precisionCSV = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-01-01,TX1,,"-0,10","100,00"',
      '2024-01-02,TX2,,"-0,20","99,90"',
      '2024-01-03,TX3,,"-0,30","99,70"',
    ].join('\n')

    const result = parseBankFile(precisionCSV, 'precision.csv')

    // 0.1 + 0.2 + 0.3 = 0.6000000000000001 without rounding
    // With Math.round(x * 100) / 100, it should be -0.6
    expect(result.stats.total_expenses).toBe(-0.6)
  })
})

describe('date range extraction', () => {
  it('sets date_from to the earliest date', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    expect(result.date_from).toBe('2024-01-13')
  })

  it('sets date_to to the latest date', () => {
    const result = parseBankFile(NORDEA_CSV, 'nordea.csv')

    expect(result.date_to).toBe('2024-01-15')
  })

  it('returns null dates for empty transaction set', () => {
    const result = parseBankFile(HEADER_ONLY_NORDEA, 'nordea.csv')

    expect(result.date_from).toBeNull()
    expect(result.date_to).toBeNull()
  })

  it('handles single-transaction file (date_from equals date_to)', () => {
    const singleRow = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-06-15,ENSKILD BETALNING,,"-500,00","10 000,00"',
    ].join('\n')

    const result = parseBankFile(singleRow, 'single.csv')

    expect(result.date_from).toBe('2024-06-15')
    expect(result.date_to).toBe('2024-06-15')
  })

  it('calculates correct date range for camt.053', () => {
    const result = parseBankFile(CAMT053_XML, 'statement.xml')

    expect(result.date_from).toBe('2024-01-14')
    expect(result.date_to).toBe('2024-01-15')
  })

  it('sorts dates lexicographically (YYYY-MM-DD is naturally sortable)', () => {
    const multiMonth = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-12-31,DEC TX,,"-10,00","1000,00"',
      '2024-01-01,JAN TX,,"-20,00","990,00"',
      '2024-06-15,JUN TX,,"-30,00","960,00"',
    ].join('\n')

    const result = parseBankFile(multiMonth, 'multimonth.csv')

    expect(result.date_from).toBe('2024-01-01')
    expect(result.date_to).toBe('2024-12-31')
  })
})

describe('empty file handling', () => {
  it('returns error result for completely empty file (no auto-detect match)', () => {
    const result = parseBankFile(EMPTY_FILE, 'empty.csv')

    expect(result.transactions).toHaveLength(0)
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.date_from).toBeNull()
    expect(result.date_to).toBeNull()
    expect(result.stats.parsed_rows).toBe(0)
  })

  it('returns zero transactions for file with only whitespace', () => {
    const whitespace = '   \n  \n   '
    const result = parseBankFile(whitespace, 'blank.csv')

    expect(result.transactions).toHaveLength(0)
  })

  it('returns zero transactions for Nordea header-only file', () => {
    const result = parseBankFile(HEADER_ONLY_NORDEA, 'nordea.csv')

    expect(result.format).toBe('nordea')
    expect(result.transactions).toHaveLength(0)
    expect(result.stats.total_rows).toBe(0)
  })
})

describe('getFormat and getAllFormats', () => {
  it('getFormat returns the correct format by ID', () => {
    const nordea = getFormat('nordea')
    expect(nordea).toBeDefined()
    expect(nordea!.id).toBe('nordea')
    expect(nordea!.name).toBe('Nordea')

    const seb = getFormat('seb')
    expect(seb).toBeDefined()
    expect(seb!.id).toBe('seb')
  })

  it('getFormat returns undefined for unknown ID', () => {
    const unknown = getFormat('nonexistent' as BankFileFormatId)
    expect(unknown).toBeUndefined()
  })

  it('getAllFormats returns all registered formats', () => {
    const formats = getAllFormats()

    expect(formats.length).toBeGreaterThanOrEqual(10)

    const ids = formats.map((f) => f.id)
    expect(ids).toContain('nordea')
    expect(ids).toContain('seb')
    expect(ids).toContain('swedbank')
    expect(ids).toContain('handelsbanken')
    expect(ids).toContain('lansforsakringar')
    expect(ids).toContain('ica_banken')
    expect(ids).toContain('skandia')
    expect(ids).toContain('lunar')
    expect(ids).toContain('camt053')
    expect(ids).toContain('generic_csv')
  })

  it('camt053 is listed before bank-specific CSV formats (detection priority)', () => {
    const formats = getAllFormats()
    const camtIdx = formats.findIndex((f) => f.id === 'camt053')
    const nordeaIdx = formats.findIndex((f) => f.id === 'nordea')

    expect(camtIdx).toBeLessThan(nordeaIdx)
  })

  it('generic_csv is listed last (manual fallback only)', () => {
    const formats = getAllFormats()
    const genericIdx = formats.findIndex((f) => f.id === 'generic_csv')

    expect(genericIdx).toBe(formats.length - 1)
  })
})

describe('edge cases and robustness', () => {
  it('handles Windows-style line endings (CRLF)', () => {
    const crlfContent = 'Datum,Transaktion,Kategori,Belopp,Saldo\r\n2024-01-15,SPOTIFY AB,,"-99,00","12 345,67"\r\n'

    const result = parseBankFile(crlfContent, 'nordea.csv')

    expect(result.format).toBe('nordea')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].amount).toBe(-99)
  })

  it('handles BOM (Byte Order Mark) prefix', () => {
    const bomContent = '\uFEFF' + NORDEA_CSV

    const result = parseBankFile(bomContent, 'nordea.csv')

    expect(result.format).toBe('nordea')
    expect(result.transactions).toHaveLength(3)
  })

  it('handles rows with invalid dates gracefully', () => {
    const invalidDate = [
      'Bokföringsdag;Valutadag;Verifikationsnummer;Text;Belopp;Saldo',
      'not-a-date;2024-01-15;12345;SPOTIFY AB;-99,00;12345,67',
      '2024-01-14;2024-01-14;12346;VALID TX;-50,00;12395,67',
    ].join('\n')

    const result = parseBankFile(invalidDate, 'seb.csv')

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].description).toBe('VALID TX')
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.stats.skipped_rows).toBe(1)
  })

  it('handles rows with invalid amounts gracefully', () => {
    const invalidAmount = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-01-15,SPOTIFY AB,,"abc","12 345,67"',
      '2024-01-14,VALID TX,,"-50,00","12 395,67"',
    ].join('\n')

    const result = parseBankFile(invalidAmount, 'nordea.csv')

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].description).toBe('VALID TX')
    expect(result.stats.skipped_rows).toBe(1)
  })

  it('handles trailing blank lines', () => {
    const trailing = NORDEA_CSV + '\n\n\n'

    const result = parseBankFile(trailing, 'nordea.csv')

    expect(result.transactions).toHaveLength(3)
  })

  it('handles Handelsbanken CSV with only reskontradatum (no transaktionsdatum)', () => {
    const onlyReskontra = [
      'Reskontradatum;Text;Belopp;Saldo',
      '2024-01-15;SPOTIFY AB;-99,00;12345,67',
    ].join('\n')

    const format = detectFileFormat(onlyReskontra, 'shb.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('handelsbanken')
  })

  it('handles large amounts without overflow', () => {
    const largeAmounts = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-01-15,BIG TRANSFER,,"1 500 000,00","2 000 000,00"',
    ].join('\n')

    const result = parseBankFile(largeAmounts, 'nordea.csv')

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].amount).toBe(1500000)
    expect(result.transactions[0].balance).toBe(2000000)
  })

  it('handles zero amounts', () => {
    const zeroAmount = [
      'Datum,Transaktion,Kategori,Belopp,Saldo',
      '2024-01-15,FEE REVERSAL,,"0,00","5 000,00"',
    ].join('\n')

    const result = parseBankFile(zeroAmount, 'nordea.csv')

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].amount).toBe(0)
  })
})

// --- Fix 5: SEB duplicate condition removal ---

describe('SEB detection — no duplicate conditions', () => {
  it('detects SEB with bokföringsdag header', () => {
    const content = 'Bokföringsdag;Valutadag;Text;Belopp;Saldo\n2024-01-15;2024-01-15;Test;-100,00;5000,00'
    const format = detectFileFormat(content, 'seb.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('seb')
  })

  it('detects SEB with bokforingsdatum header (no diacritics)', () => {
    const content = 'Bokforingsdatum;Valutadag;Text;Belopp;Saldo\n2024-01-15;2024-01-15;Test;-100,00;5000,00'
    const format = detectFileFormat(content, 'seb.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('seb')
  })
})

// --- Fix 6: Länsförsäkringar false positive prevention ---

describe('Länsförsäkringar detection — false positive prevention', () => {
  it('detects valid LF data rows with comma-decimal amounts', () => {
    const format = detectFileFormat(LANSFORSAKRINGAR_CSV, 'lf.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('lansforsakringar')
  })

  it('detects LF header-less data with two dates and comma-decimal amount', () => {
    const format = detectFileFormat(LANSFORSAKRINGAR_CSV_NO_HEADER, 'lf.csv')
    expect(format).not.toBeNull()
    expect(format!.id).toBe('lansforsakringar')
  })

  it('does not false-positive on generic semicolon CSV with two date columns but non-numeric 5th field', () => {
    // This CSV has two date columns + 5 fields but the 5th field is not a number
    const falsePositive = [
      '"2024-01-15";"2024-01-15";"Typ";"Text";"not-a-number"',
    ].join('\n')

    const format = detectFileFormat(falsePositive, 'generic.csv')
    // Should NOT detect as Länsförsäkringar
    expect(format?.id).not.toBe('lansforsakringar')
  })
})

// --- Fix 7: Generic CSV column bounds checking ---

describe('parseGenericCSV — column bounds checking', () => {
  it('skips rows with too few columns and adds warning', () => {
    const content = [
      'Date,Description,Amount',
      '2024-01-15,Test,-100.00',
      '2024-01-16,Short',         // Only 2 columns, mapping needs column 2 (amount)
    ].join('\n')

    const result = parseGenericCSV(content, {
      date: 0,
      description: 1,
      amount: 2,
      delimiter: ',',
      decimal_separator: '.',
      skip_rows: 1,
      date_format: 'YYYY-MM-DD',
    })

    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].description).toBe('Test')
    expect(result.stats.skipped_rows).toBe(1)
    expect(result.issues.some((i) => i.message.includes('columns but mapping requires'))).toBe(true)
  })

  it('skips rows when mapping index exceeds field count', () => {
    const content = [
      'A,B',
      'val1,val2',
    ].join('\n')

    const result = parseGenericCSV(content, {
      date: 0,
      description: 1,
      amount: 5,  // Column 5 does not exist (only 2 columns)
      delimiter: ',',
      decimal_separator: '.',
      skip_rows: 1,
      date_format: 'YYYY-MM-DD',
    })

    expect(result.transactions).toHaveLength(0)
    expect(result.stats.skipped_rows).toBe(1)
    expect(result.issues).toHaveLength(1)
  })

  it('parses normally when all columns are within bounds', () => {
    const content = [
      'Date,Description,Amount',
      '2024-01-15,SPOTIFY,-99.00',
      '2024-01-16,SALARY,25000.00',
    ].join('\n')

    const result = parseGenericCSV(content, {
      date: 0,
      description: 1,
      amount: 2,
      delimiter: ',',
      decimal_separator: '.',
      skip_rows: 1,
      date_format: 'YYYY-MM-DD',
    })

    expect(result.transactions).toHaveLength(2)
    expect(result.stats.skipped_rows).toBe(0)
    expect(result.issues).toHaveLength(0)
  })

  it('parses amounts that use Unicode minus (U+2212) — was NaN before normalization', () => {
    const content = [
      'Date,Description,Amount',
      '2024-01-15,SPOTIFY,"\u221299,00"',
      '2024-01-16,REFUND,"\u201350,00"',
      '2024-01-17,SALARY,"25000,00"',
    ].join('\n')

    const result = parseGenericCSV(content, {
      date: 0,
      description: 1,
      amount: 2,
      delimiter: ',',
      decimal_separator: ',',
      skip_rows: 1,
      date_format: 'YYYY-MM-DD',
    })

    expect(result.transactions).toHaveLength(3)
    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(-50)
    expect(result.transactions[2].amount).toBe(25000)
  })

  it('skips metadata rows when skip_rows is set higher than 1 (multi-row preamble)', () => {
    // Mimics a file with 5 metadata rows + header + 2 transactions.
    const content = [
      'Account,12345',
      'Owner,Acme AB',
      'Period,2024-01,2024-12',
      'Currency,SEK',
      'Type,Statement',
      'Date,Description,Amount',
      '2024-01-15,SPOTIFY,-99.00',
      '2024-01-16,SALARY,25000.00',
    ].join('\n')

    const result = parseGenericCSV(content, {
      date: 0,
      description: 1,
      amount: 2,
      delimiter: ',',
      decimal_separator: '.',
      skip_rows: 6,
      date_format: 'YYYY-MM-DD',
    })

    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].amount).toBe(-99)
    expect(result.transactions[1].amount).toBe(25000)
    expect(result.issues).toHaveLength(0)
  })
})

describe('normalizeMinusSign', () => {
  it('replaces U+2212 (minus sign) with ASCII hyphen', () => {
    expect(normalizeMinusSign('\u2212139,00')).toBe('-139,00')
  })

  it('replaces U+2013 (en dash) and U+2014 (em dash) with ASCII hyphen', () => {
    expect(normalizeMinusSign('\u2013100')).toBe('-100')
    expect(normalizeMinusSign('\u2014250')).toBe('-250')
  })

  it('leaves ASCII hyphen and digits untouched', () => {
    expect(normalizeMinusSign('-139.00')).toBe('-139.00')
    expect(normalizeMinusSign('139.00')).toBe('139.00')
  })

  it('makes parseFloat work on Unicode-minus strings (regression for Northmill)', () => {
    expect(parseFloat('\u2212139.00')).toBeNaN()
    expect(parseFloat(normalizeMinusSign('\u2212139.00'))).toBe(-139)
  })
})

// --- Fix 8: parseCSVLine unclosed quote handling ---

describe('parseCSVLine — unclosed quote handling', () => {
  it('handles normal quoted fields correctly', () => {
    const fields = parseCSVLine('"hello","world"', ',')
    expect(fields).toEqual(['hello', 'world'])
  })

  it('handles escaped quotes (doubled) inside fields', () => {
    const fields = parseCSVLine('"he said ""hi""",other', ',')
    expect(fields).toEqual(['he said "hi"', 'other'])
  })

  it('produces a result even with unclosed quotes instead of hanging', () => {
    // Unclosed quote: the parser should not hang or crash
    const fields = parseCSVLine('"unclosed,field2,field3', ',')
    // With unclosed quote, everything after the opening quote is one field
    // The important thing is it doesn't crash and returns something
    expect(fields.length).toBeGreaterThan(0)
  })

  it('preserves data with unclosed quote rather than losing it', () => {
    const fields = parseCSVLine('normal,"unclosed value', ',')
    // Should have at least the first field and whatever was accumulated
    expect(fields.length).toBe(2)
    expect(fields[0]).toBe('normal')
    // The unclosed quoted field should still contain the text
    expect(fields[1]).toContain('unclosed value')
  })

  it('handles semicolon delimiter with quotes', () => {
    const fields = parseCSVLine('"2024-01-15";"SPOTIFY AB";"-99,00"', ';')
    expect(fields).toEqual(['2024-01-15', 'SPOTIFY AB', '-99,00'])
  })
})
