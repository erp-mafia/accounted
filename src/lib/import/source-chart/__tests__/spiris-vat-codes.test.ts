import { describe, it, expect } from 'vitest'
import { parseSpirisVatCode, spirisVatTreatment } from '../spiris-vat-codes'
import { resolveVatTreatmentRuta } from '@/lib/vat/account-vat-treatment'

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
    ['06-25%', '3401', 'own_use'],
    ['06-12%', '3402', 'own_use'],
    ['06-25%', '3910', 'own_use'],
    ['50-25%', '4545', 'import_goods'],
    ['50-6%', '4547', 'import_goods'],
    ['50-25%', '4540', 'import_goods'],
  ])('reads %s on %s as %s', (code, account, treatment) => {
    // Both boxes used to answer null here, which was survivable only while the
    // account number happened to be one ACCOUNT_RUTA knows: 3401-3403 for ruta
    // 06, 4545-4547 for ruta 50. On any other number the amount reached no box
    // at all. The non-standard numbers in this list are the point.
    expect(spirisVatTreatment(code, account)).toBe(treatment)
  })

  it('will not read an uttag code on a purchase account, or an import code on a sale', () => {
    // The class check is what stops a box from being filled from the wrong
    // side of the ledger: ruta 06 is revenue, ruta 50 is a cost-side basis.
    expect(spirisVatTreatment('06-25%', '4010')).toBeNull()
    expect(spirisVatTreatment('50-25%', '3010')).toBeNull()
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

describe('spirisVatTreatment: the code must file where the source said', () => {
  // Omvänd skattskyldighet inom Sverige is the one treatment whose ruta comes
  // from the account NUMBER rather than from itself: 4415-4417 varor file ruta
  // 23, 4425-4427 tjänster file ruta 24, and everything else falls to the
  // goods branch. A Spiris "24" on any other class 4 account therefore filed a
  // service purchase as goods, and did it silently, because the code HAD
  // translated and so the row never reached the review list.

  it('translates 23 and 24 on the six accounts whose number carries the split', () => {
    for (const account of ['4415', '4416', '4417']) {
      expect(spirisVatTreatment('23-25%', account)).toBe('reverse_charge_domestic')
    }
    for (const account of ['4425', '4426', '4427']) {
      expect(spirisVatTreatment('24-25%', account)).toBe('reverse_charge_domestic')
    }
  })

  it('refuses 24 on a class 4 account the resolver would read as varor', () => {
    // Left untranslated, so applySourceVatCodes keeps the code on the mapping,
    // shows it, and leaves the row in the review list: a person decides,
    // instead of ruta 23 being filed on a tjänsteinköp behind their back.
    for (const account of ['4400', '4429', '4530', '4010']) {
      expect(spirisVatTreatment('24-25%', account)).toBeNull()
    }
  })

  it('refuses 23 on an account the resolver would read as tjänster', () => {
    expect(spirisVatTreatment('23-25%', '4425')).toBeNull()
    // Classes 5 and 6 never take the varor branch, so a goods code there is
    // exactly as unreadable.
    expect(spirisVatTreatment('23-25%', '5010')).toBeNull()
    expect(spirisVatTreatment('23-25%', '6010')).toBeNull()
  })

  it('still translates 24 on classes 5 and 6, which the resolver reads as tjänster', () => {
    expect(spirisVatTreatment('24-25%', '5010')).toBe('reverse_charge_domestic')
    expect(spirisVatTreatment('24-25%', '6010')).toBe('reverse_charge_domestic')
  })

  it('ratchet: every code this file translates files the ruta it names', () => {
    // The property, not a list: whatever spirisVatTreatment returns, the
    // declaration must put it in the box the source system wrote. Stated over
    // the whole two-digit space so a ruta added to either table later is
    // covered without anyone remembering to extend a fixture.
    const accounts = [
      '3051', '3110', '3231', '3910', '3058', '3107', '3105', '3308', '3305', '3401', '3004',
      '4415', '4416', '4417', '4425', '4426', '4427', '4400', '4429', '4512', '4515', '4535',
      '4531', '4545', '5010', '6010',
    ]
    const rates = ['-25%', '-12%', '-6%', '-0%', '']
    let translated = 0
    for (let n = 0; n < 100; n++) {
      const ruta = String(n).padStart(2, '0')
      for (const rate of rates) {
        for (const account of accounts) {
          const treatment = spirisVatTreatment(`${ruta}${rate}`, account)
          if (!treatment) continue
          translated += 1
          const accountClass = Number(account.charAt(0))
          expect(
            resolveVatTreatmentRuta(treatment, accountClass, account)?.box,
            `${ruta}${rate} on ${account} translated to ${treatment}, which files elsewhere`,
          ).toBe(`ruta${ruta}`)
        }
      }
    }
    // Guard the guard: a change that made spirisVatTreatment always return null
    // would satisfy every assertion above vacuously.
    expect(translated).toBeGreaterThan(50)
  })
})
