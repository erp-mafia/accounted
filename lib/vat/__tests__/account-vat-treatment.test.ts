import { describe, expect, it } from 'vitest'
import {
  defaultRateForVatTreatment,
  resolveVatTreatmentRuta,
  suggestVatTreatment,
} from '../account-vat-treatment'

describe('resolveVatTreatmentRuta', () => {
  it('maps revenue treatments to their momsdeklaration boxes', () => {
    expect(resolveVatTreatmentRuta('standard_25', 3)).toEqual({ box: 'ruta05', side: 'credit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 3)).toEqual({ box: 'ruta41', side: 'credit' })
    expect(resolveVatTreatmentRuta('reverse_charge_eu_goods', 3)).toEqual({ box: 'ruta35', side: 'credit' })
    expect(resolveVatTreatmentRuta('reverse_charge_eu_services', 3)).toEqual({ box: 'ruta39', side: 'credit' })
    expect(resolveVatTreatmentRuta('export_goods', 3)).toEqual({ box: 'ruta36', side: 'credit' })
    expect(resolveVatTreatmentRuta('export_services', 3)).toEqual({ box: 'ruta40', side: 'credit' })
    expect(resolveVatTreatmentRuta('exempt', 3)).toEqual({ box: 'ruta42', side: 'credit' })
    expect(resolveVatTreatmentRuta('vmb', 3)).toEqual({ box: 'ruta07', side: 'credit' })
    expect(resolveVatTreatmentRuta('rental_voluntary', 3)).toEqual({ box: 'ruta08', side: 'credit' })
  })

  it('maps purchase treatments by purchase class', () => {
    expect(resolveVatTreatmentRuta('reverse_charge_eu_goods', 4)).toEqual({ box: 'ruta20', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_eu_services', 4)).toEqual({ box: 'ruta21', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_non_eu_services', 5)).toEqual({ box: 'ruta22', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4)).toEqual({ box: 'ruta23', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4, '4425')).toEqual({ box: 'ruta24', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 5)).toEqual({ box: 'ruta24', side: 'debit' })
    expect(resolveVatTreatmentRuta('export_goods', 4)).toBeNull()
    expect(resolveVatTreatmentRuta('exempt', 4)).toBeNull()
  })
})

describe('suggestVatTreatment', () => {
  it('suggests the issue examples from labels, not SIE metadata', () => {
    expect(suggestVatTreatment('3041', 'Försäljning tjänst 25% sv')).toEqual({
      treatment: 'standard_25', rate: 0.25,
    })
    expect(suggestVatTreatment('4056', 'Inköp varor 25% EU')).toEqual({
      treatment: 'reverse_charge_eu_goods', rate: 0.25,
    })
  })

  it('does not guess from an account number alone', () => {
    expect(suggestVatTreatment('3041', 'Projektintäkt')).toBeNull()
    expect(suggestVatTreatment('4056', 'Projektkostnad')).toBeNull()
  })

  it('does not suggest an unsupported purchase treatment for imports of goods', () => {
    expect(suggestVatTreatment('4545', 'Import varor utanför EU 25%')).toBeNull()
  })

  it('checks outside-EU labels before the generic EU matcher', () => {
    expect(suggestVatTreatment('3048', 'Export tjänster utanför EU')).toEqual({
      treatment: 'export_services', rate: 0,
    })
    expect(suggestVatTreatment('3108', 'Försäljning varor till annat EU-land, momsfri')).toEqual({
      treatment: 'reverse_charge_eu_goods', rate: 0,
    })
    expect(suggestVatTreatment('6545', 'Inköp tjänster utanför EU 25%')).toEqual({
      treatment: 'reverse_charge_non_eu_services', rate: 0.25,
    })
  })

  it('does not match EU inside an unrelated word', () => {
    expect(suggestVatTreatment('4010', 'Reumatologiska varor')).toBeNull()
  })

  it('keeps VMB without a generic booking rate', () => {
    expect(suggestVatTreatment('3211', 'Försäljning VMB')).toEqual({
      treatment: 'vmb', rate: null,
    })
    expect(defaultRateForVatTreatment('vmb', 3)).toBeNull()
  })
})
