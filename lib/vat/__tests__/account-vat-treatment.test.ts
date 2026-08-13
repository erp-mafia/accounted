import { describe, expect, it } from 'vitest'
import {
  defaultRateForVatTreatment,
  isVatTreatmentValidForAccountClass,
  resolveVatTreatmentRuta,
  suggestVatTreatment,
  vatTreatmentsForAccountClass,
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
    expect(resolveVatTreatmentRuta('export_services', 5)).toEqual({ box: 'ruta22', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4)).toEqual({ box: 'ruta23', side: 'debit' })
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 5)).toEqual({ box: 'ruta24', side: 'debit' })
    expect(resolveVatTreatmentRuta('export_goods', 4)).toEqual({ box: 'ruta50', side: 'debit' })
    expect(resolveVatTreatmentRuta('exempt', 4)).toBeNull()
  })
})

describe('vat treatment applicability', () => {
  it('exposes only treatments that resolve for the account class', () => {
    expect(vatTreatmentsForAccountClass(3)).toContain('vmb')
    expect(vatTreatmentsForAccountClass(5)).not.toContain('vmb')
    expect(isVatTreatmentValidForAccountClass('reverse_charge_eu_services', 5)).toBe(true)
    expect(isVatTreatmentValidForAccountClass('standard_25', 5)).toBe(false)
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

  it('matches EU as a term, not a substring inside another word', () => {
    expect(suggestVatTreatment('4056', 'Reumatologiska varor 25%')).toBeNull()
    expect(suggestVatTreatment('4056', 'Inköp EU-varor 25%')).toEqual({
      treatment: 'reverse_charge_eu_goods',
      rate: 0.25,
    })
  })

  it('does not assume a purchase-side reverse-charge rate', () => {
    expect(defaultRateForVatTreatment('reverse_charge_eu_goods', 4)).toBeNull()
    expect(defaultRateForVatTreatment('reverse_charge_eu_services', 5)).toBeNull()
    expect(defaultRateForVatTreatment('reverse_charge_domestic', 6)).toBeNull()
    expect(defaultRateForVatTreatment('export_goods', 4)).toBeNull()
    expect(suggestVatTreatment('4056', 'Inköp varor EU')).toEqual({
      treatment: 'reverse_charge_eu_goods',
      rate: null,
    })
  })

  it('does not use a gross account rate for VMB', () => {
    expect(defaultRateForVatTreatment('vmb', 3)).toBeNull()
    expect(suggestVatTreatment('3021', 'Försäljning begagnat 25% VMB')).toEqual({
      treatment: 'vmb',
      rate: null,
    })
  })
})
