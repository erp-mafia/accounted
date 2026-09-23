import { describe, expect, it } from 'vitest'

import { FORTNOX_VAT_CODES, fortnoxVatCodeToTreatment } from '../vat-codes'
import {
  ACCOUNT_VAT_TREATMENTS,
  resolveVatTreatmentRuta,
} from '@/lib/vat/account-vat-treatment'

/**
 * Fortnox names each momskod after the momsdeklaration ruta it feeds. The
 * translation is therefore checked ruta by ruta: a code translates for an
 * account only when Accounted files that account on the ruta the code
 * names, and answers null everywhere else.
 */
describe('fortnoxVatCodeToTreatment', () => {
  it.each([
    // code, account, Fortnox ruta, expected treatment
    ['MP1', '3001', 'ruta05', 'standard_25'],
    ['MP2', '3002', 'ruta05', 'reduced_12'],
    ['MP3', '3003', 'ruta05', 'reduced_6'],
    ['BVMB', '3211', 'ruta07', 'vmb'],
    ['HFS', '3913', 'ruta08', 'rental_voluntary'],
    ['VTEU', '3108', 'ruta35', 'reverse_charge_eu_goods'],
    ['E', '3105', 'ruta36', 'export_goods'],
    ['FTEU', '3308', 'ruta39', 'reverse_charge_eu_services'],
    ['ÖTEU', '3305', 'ruta40', 'export_services'],
    ['OTTU', '3231', 'ruta41', 'reverse_charge_domestic'],
    ['MF', '3004', 'ruta42', 'exempt'],
    ['IVEU', '4515', 'ruta20', 'reverse_charge_eu_goods'],
    ['ITEU', '4535', 'ruta21', 'reverse_charge_eu_services'],
    ['ITGLOB', '4531', 'ruta22', 'reverse_charge_non_eu_services'],
    ['IV', '4415', 'ruta23', 'reverse_charge_domestic'],
    ['IT', '4425', 'ruta24', 'reverse_charge_domestic'],
    ['IT', '6540', 'ruta24', 'reverse_charge_domestic'],
  ] as const)('%s on %s lands on %s', (code, account, ruta, treatment) => {
    expect(fortnoxVatCodeToTreatment(code, account)).toBe(treatment)
    expect(resolveVatTreatmentRuta(treatment, Number(account.charAt(0)), account)?.box).toBe(ruta)
  })

  it('refuses IV and IT where Accounted would file the account on the other of rutor 23 and 24', () => {
    // Accounted derives the 23/24 split from the account number (class 4 is
    // varor except 4425-4427; classes 5-6 are tjänster). A Fortnox IT on a
    // custom 46xx underentreprenör account would be filed on 23 here, so
    // the code must not translate: the row falls back to the label and the
    // user decides, instead of a reviewed value that silently moves the box.
    expect(fortnoxVatCodeToTreatment('IT', '4610')).toBeNull()
    expect(fortnoxVatCodeToTreatment('IT', '4010')).toBeNull()
    expect(fortnoxVatCodeToTreatment('IV', '4425')).toBeNull()
    expect(fortnoxVatCodeToTreatment('IV', '5410')).toBeNull()
  })

  it('normalises case and whitespace', () => {
    expect(fortnoxVatCodeToTreatment(' mp1 ', '3001')).toBe('standard_25')
    expect(fortnoxVatCodeToTreatment('öteu', '3305')).toBe('export_services')
  })

  it('answers null for blank, unknown and moms-account codes', () => {
    expect(fortnoxVatCodeToTreatment(undefined, '3001')).toBeNull()
    expect(fortnoxVatCodeToTreatment(null, '3001')).toBeNull()
    expect(fortnoxVatCodeToTreatment('', '3001')).toBeNull()
    expect(fortnoxVatCodeToTreatment('MPX', '3001')).toBeNull()
    // Codes Fortnox puts on 26xx moms accounts: no treatment on any class.
    for (const code of ['U1', 'U2', 'U3', 'I', 'UOS1', 'UEU1', 'UTFU1', 'UI25', 'R1', 'R2']) {
      expect(fortnoxVatCodeToTreatment(code, '3001')).toBeNull()
      expect(fortnoxVatCodeToTreatment(code, '4010')).toBeNull()
      expect(fortnoxVatCodeToTreatment(code, '2611')).toBeNull()
    }
    // Rutor Accounted has no treatment for yet.
    for (const code of ['UT', '3VEU', '3FEU', 'BI']) {
      expect(fortnoxVatCodeToTreatment(code, '3001')).toBeNull()
      expect(fortnoxVatCodeToTreatment(code, '4010')).toBeNull()
    }
  })

  it('refuses a code whose ruta the account can never reach', () => {
    // Revenue codes on purchase accounts and purchase codes on revenue
    // accounts: the same treatment would land on a different ruta than the
    // code names (IVEU on 3xxx would be ruta 35, not 20), so it is refused
    // in both directions.
    expect(fortnoxVatCodeToTreatment('MP1', '4010')).toBeNull()
    expect(fortnoxVatCodeToTreatment('MF', '5010')).toBeNull()
    expect(fortnoxVatCodeToTreatment('HFS', '6010')).toBeNull()
    expect(fortnoxVatCodeToTreatment('ITGLOB', '3001')).toBeNull()
    expect(fortnoxVatCodeToTreatment('IVEU', '3001')).toBeNull()
    expect(fortnoxVatCodeToTreatment('VTEU', '4515')).toBeNull()
    expect(fortnoxVatCodeToTreatment('OTTU', '4415')).toBeNull()
    // Classes 1, 2 and 7 never carry a treatment at all.
    expect(fortnoxVatCodeToTreatment('MP1', '1930')).toBeNull()
    expect(fortnoxVatCodeToTreatment('MP1', '2611')).toBeNull()
    expect(fortnoxVatCodeToTreatment('IVEU', '7010')).toBeNull()
  })

  it('only ever names a treatment Accounted knows', () => {
    for (const { treatment } of Object.values(FORTNOX_VAT_CODES)) {
      expect(ACCOUNT_VAT_TREATMENTS).toContain(treatment)
    }
  })
})
