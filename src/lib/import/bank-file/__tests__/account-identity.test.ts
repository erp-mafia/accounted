/**
 * The statement's own account, read from the file (crm#1204): the helpers,
 * and what each format that prints one returns through parseBankFile.
 */
import { describe, it, expect } from 'vitest'
import { accountIdentity, preambleAccountIdentity, sharedAccountIdentity } from '../account-identity'
import { parseBankFile } from '../parser'
import { CAMT053_PRETTY_WITH_REFS, CAMT053_V08_PREFIXED_MULTI_STMT } from '@/tests/fixtures/camt053'

describe('accountIdentity', () => {
  it('normalizes an IBAN and drops one that is not an IBAN', () => {
    expect(accountIdentity({ iban: 'se35 5000 0000 0549 1000 0003' })).toEqual({
      iban: 'SE3550000000054910000003',
      clearing: null,
      account_number: null,
    })
    expect(accountIdentity({ iban: 'not an iban' })).toBeNull()
  })

  it('keeps a printed clearing and account number as printed', () => {
    expect(accountIdentity({ clearing: ' 8327-9 ', account_number: '123 456 789-0' })).toEqual({
      iban: null,
      clearing: '8327-9',
      account_number: '123 456 789-0',
    })
  })

  it('reads a printed value shaped like an IBAN as the IBAN', () => {
    expect(accountIdentity({ account_number: 'SE35 5000 0000 0549 1000 0003' })?.iban).toBe('SE3550000000054910000003')
  })

  it('names nothing with too few digits or nothing at all', () => {
    expect(accountIdentity({ clearing: '8327', account_number: '12' })).toBeNull()
    expect(accountIdentity({ account_number: '' })).toBeNull()
    expect(accountIdentity({})).toBeNull()
  })
})

describe('sharedAccountIdentity', () => {
  const a = { iban: null, clearing: '8327-9', account_number: '123 456 789-0' }

  it('returns the account every part names, compared by digits', () => {
    expect(sharedAccountIdentity([a, { ...a, clearing: '83279', account_number: '1234567890' }])).toEqual(a)
  })

  it('returns null when one part names another account or none', () => {
    expect(sharedAccountIdentity([a, { ...a, account_number: '9876543210' }])).toBeNull()
    expect(sharedAccountIdentity([a, null])).toBeNull()
    expect(sharedAccountIdentity([])).toBeNull()
  })
})

describe('preambleAccountIdentity', () => {
  it('reads the Kontonummer line above the header in any delimiter', () => {
    expect(preambleAccountIdentity(['Kontonummer;6789 123 456 789', 'Datum;Belopp'], 1)?.account_number)
      .toBe('6789 123 456 789')
    expect(preambleAccountIdentity(['Kontonummer: 1234 567 890', 'Datum;Belopp'], 1)?.account_number)
      .toBe('1234 567 890')
    expect(preambleAccountIdentity(['"Kontonummer","9750-8770139"', 'x'], 1)?.account_number)
      .toBe('9750-8770139')
  })

  it('never reads the header or a transaction row', () => {
    expect(preambleAccountIdentity(['Datum;Text', 'Kontonummer;6789 123 456 789'], 0)).toBeNull()
    expect(preambleAccountIdentity(['Kontonamn: Lönekonto', 'Datum;Text'], 1)).toBeNull()
  })
})

describe('parseBankFile: the statement account', () => {
  it('Swedbank: the clearing and account columns every row shares', () => {
    const csv = [
      '* Transaktionsrapport Period 2024-01-01 2024-01-31',
      'Radnr,Clnr,Kontonr,Produkt,Valuta,Bokfdag,Transdag,Valutadag,Referens,Text,Belopp,Saldo',
      '1,8327-9,123 456 789-0,Företagskonto,SEK,2024-01-15,2024-01-15,2024-01-15,SPOTIFY,Kortköp,-99.00,12345.67',
      '2,8327-9,123 456 789-0,Företagskonto,SEK,2024-01-14,2024-01-14,2024-01-14,ICA,Kortköp,-432.50,12444.67',
    ].join('\n')
    const result = parseBankFile(csv, 'swedbank.csv')
    expect(result.format).toBe('swedbank')
    expect(result.account).toEqual({ iban: null, clearing: '8327-9', account_number: '123 456 789-0' })
  })

  it('Swedbank: no single account when the rows belong to two', () => {
    const csv = [
      'Clearingnummer,Kontonummer,Datum,Text,Belopp,Saldo',
      '8123,12345678,2024-01-15,SPOTIFY AB,-99.00,12345.67',
      '8123,87654321,2024-01-14,ICA MAXI,-432.50,12444.67',
    ].join('\n')
    const result = parseBankFile(csv, 'swedbank.csv')
    expect(result.format).toBe('swedbank')
    expect(result.transactions).toHaveLength(2)
    expect(result.account).toBeNull()
  })

  it('camt.053: the IBAN of <Stmt><Acct>, never a counterparty account', () => {
    const result = parseBankFile(CAMT053_PRETTY_WITH_REFS, 'statement.xml')
    expect(result.format).toBe('camt053')
    expect(result.account).toEqual({ iban: 'SE3550000000054910000003', clearing: null, account_number: null })
  })

  it('camt.053: no single account when the statements are for two accounts', () => {
    const result = parseBankFile(CAMT053_V08_PREFIXED_MULTI_STMT, 'kontoutdrag.txt')
    expect(result.format).toBe('camt053')
    expect(result.account).toBeNull()
  })

  it('camt.053: a domestic number in <Othr><Id>', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><Othr><Id>83279-1234567890</Id></Othr></Id><Ccy>SEK</Ccy></Acct>
<Ntry><BookgDt><Dt>2024-01-15</Dt></BookgDt><Amt Ccy="SEK">99.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><NtryRef>R1</NtryRef></Ntry>
</Stmt></BkToCstmrStmt></Document>`
    expect(parseBankFile(xml, 'statement.xml').account).toEqual({
      iban: null,
      clearing: null,
      account_number: '83279-1234567890',
    })
  })

  it('Handelsbanken, ICA Banken and Northmill: the Kontonummer preamble line', () => {
    const handelsbanken = [
      'Kontonummer;6789 123 456 789',
      'Kontohavare;Testbolaget AB',
      '',
      'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
      '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67',
    ].join('\n')
    const ica = [
      'Kontonamn: Lönekonto',
      'Kontonummer: 9271 123 45 67',
      'Saldo: 12 877,17',
      'Datum;Text;Belopp;Saldo',
      '2024-01-15;SPOTIFY AB;-99,00;12345,67',
    ].join('\n')
    const northmill = [
      'Kontonummer,9750-8770139',
      'Saldo,"100,00",SEK',
      '',
      'Bokföringsdag,Beskrivning,Belopp,Saldo,Valuta',
      '2026-04-01,Månadsavgift,"−139,00","100,00",SEK',
    ].join('\n')

    const hb = parseBankFile(handelsbanken, 'kontoutdrag.csv')
    expect(hb.format).toBe('handelsbanken')
    expect(hb.account?.account_number).toBe('6789 123 456 789')

    const icaResult = parseBankFile(ica, 'ica.csv')
    expect(icaResult.format).toBe('ica_banken')
    expect(icaResult.account?.account_number).toBe('9271 123 45 67')

    const nm = parseBankFile(northmill, 'northmill.csv')
    expect(nm.format).toBe('northmill')
    expect(nm.account?.account_number).toBe('9750-8770139')
  })

  it('a format that prints no account has none', () => {
    const result = parseBankFile(
      ['Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo', '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67'].join('\n'),
      'kontoutdrag.csv',
    )
    expect(result.format).toBe('handelsbanken')
    expect(result.account).toBeNull()
  })
})
