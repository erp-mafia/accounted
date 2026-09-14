import { describe, it, expect } from 'vitest'
import { parseSpirisVatCode, spirisVatTreatment } from '../spiris-vat-codes'

describe('parseSpirisVatCode', () => {
  it('splits the ruta from the rate', () => {
    expect(parseSpirisVatCode('05-25%')).toEqual({ ruta: '05', rate: 0.25 })
    expect(parseSpirisVatCode('23-12%')).toEqual({ ruta: '23', rate: 0.12 })
    expect(parseSpirisVatCode('12-6%')).toEqual({ ruta: '12', rate: 0.06 })
    expect(parseSpirisVatCode('35-0%')).toEqual({ ruta: '35', rate: 0 })
  })

  it('reads the bare form that names no rate', () => {
    expect(parseSpirisVatCode('48')).toEqual({ ruta: '48', rate: null })
  })

  it('keeps the leading zero, because the ruta is an identifier', () => {
    expect(parseSpirisVatCode('05-25%')?.ruta).toBe('05')
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseSpirisVatCode('  05-25%  ')).toEqual({ ruta: '05', rate: 0.25 })
  })

  it('refuses anything it does not recognise rather than guessing', () => {
    for (const junk of ['', '   ', 'IVEU', '5-25%', '05-25', '05%', '05-8%', '05-25%%', 'abc']) {
      expect(parseSpirisVatCode(junk)).toBeNull()
    }
  })
})

describe('spirisVatTreatment', () => {
  // Every ruta seen across six yearly exports from one company, on the account
  // class it actually appeared on.
  it.each([
    ['05-25%', '3051', 'standard_25'],
    ['05-12%', '3052', 'reduced_12'],
    ['05-6%', '3053', 'reduced_6'],
    ['07-25%', '3110', 'vmb'],
    ['08-25%', '3910', 'rental_voluntary'],
    ['35-0%', '3058', 'reverse_charge_eu_goods'],
    ['36-0%', '3055', 'export_goods'],
    ['39-0%', '3048', 'reverse_charge_eu_services'],
    ['40-0%', '3045', 'export_services'],
    ['41-0%', '3231', 'reverse_charge_domestic'],
    ['42-0%', '3054', 'exempt'],
    ['20-25%', '4515', 'reverse_charge_eu_goods'],
    ['21-25%', '4535', 'reverse_charge_eu_services'],
    ['22-25%', '4531', 'reverse_charge_non_eu_services'],
    ['23-25%', '4415', 'reverse_charge_domestic'],
    ['24-25%', '4425', 'reverse_charge_domestic'],
    ['38-0%', '3107', 'triangulation_eu_goods'],
    ['37-0%', '4512', 'triangulation_eu_goods'],
  ])('translates %s on %s', (code, account, expected) => {
    expect(spirisVatTreatment(code, account)).toBe(expected)
  })

  it.each([
    ['06-25%', '3401', 'momspliktiga egna uttag'],
    ['06-12%', '3402', 'momspliktiga egna uttag'],
    ['50-25%', '4545', 'beskattningsunderlag vid import'],
    ['50-6%', '4547', 'beskattningsunderlag vid import'],
  ])('answers null for %s, which is %s', (code, account) => {
    // Real codes this project has no treatment for. Null is not a failure:
    // applySourceVatCodes keeps the code on the mapping and leaves the row in
    // the review list with its label suggestion.
    expect(spirisVatTreatment(code, account)).toBeNull()
  })

  it('answers null for the VAT accounts themselves', () => {
    // Rutor 10/11/12, 30/31/32, 48 and 60/61/62 sit on class 2 accounts, which
    // this project maps structurally rather than through a treatment.
    for (const [code, account] of [['10-25%', '2611'], ['30-25%', '2614'], ['48', '2641'], ['60-25%', '2615']]) {
      expect(spirisVatTreatment(code, account)).toBeNull()
    }
  })

  it('will not read a rate into a code that names none', () => {
    // A bare "05" states the box but not which of the three rates applies, and
    // defaulting it to 25 % would silently register 6 % revenue at 25 %.
    expect(spirisVatTreatment('05', '3051')).toBeNull()
  })

  it('will not put a purchase ruta on a revenue account, or the reverse', () => {
    expect(spirisVatTreatment('20-25%', '3051')).toBeNull()
    expect(spirisVatTreatment('35-0%', '4515')).toBeNull()
  })

  it('answers null for blank and malformed codes', () => {
    expect(spirisVatTreatment('', '3051')).toBeNull()
    expect(spirisVatTreatment('IVEU', '3051')).toBeNull()
  })
})
