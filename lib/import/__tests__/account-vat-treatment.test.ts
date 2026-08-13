import { describe, expect, it } from 'vitest'
import {
  applyVatTreatmentReview,
  enrichAccountMappingsWithVat,
} from '../account-vat-treatment'
import type { AccountMapping } from '../types'

function mapping(account: string, name: string): AccountMapping {
  return {
    sourceAccount: account,
    sourceName: name,
    targetAccount: account,
    targetName: name,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

describe('enrichAccountMappingsWithVat', () => {
  it('marks label suggestions for user review', () => {
    const [result] = enrichAccountMappingsWithVat(
      [mapping('4056', 'Inköp varor 25% EU')],
      [],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: 'reverse_charge_eu_goods',
      defaultVatRate: 0.25,
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
  })

  it('requires review for suggested class 5 and 6 purchase treatments', () => {
    const results = enrichAccountMappingsWithVat(
      [
        mapping('5010', 'Inköp tjänst EU'),
        mapping('6010', 'Inköp tjänst utanför EU'),
      ],
      [],
    )
    expect(results).toEqual([
      expect.objectContaining({
        defaultVatTreatment: 'reverse_charge_eu_services',
        requiresVatTreatmentReview: true,
        vatTreatmentReviewed: false,
      }),
      expect.objectContaining({
        defaultVatTreatment: 'export_services',
        requiresVatTreatmentReview: true,
        vatTreatmentReviewed: false,
      }),
    ])
  })

  it('keeps an existing account treatment without asking again', () => {
    const [result] = enrichAccountMappingsWithVat(
      [mapping('3041', 'Försäljning tjänst 25% sv')],
      [{
        account_number: '3041',
        default_vat_treatment: 'standard_25',
        default_vat_rate: 0.25,
      } as never],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: 'standard_25',
      vatTreatmentSuggested: false,
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })
})

describe('applyVatTreatmentReview', () => {
  it('marks only the selected row reviewed, including class 5 and 6 accounts', () => {
    const mappings = [
      mapping('5010', 'Inköp tjänst EU'),
      mapping('3041', 'Försäljning tjänst 25% sv'),
    ]
    const result = applyVatTreatmentReview(
      mappings,
      '5010',
      'reverse_charge_eu_services',
      0.25,
    )
    expect(result[0]).toMatchObject({
      defaultVatTreatment: 'reverse_charge_eu_services',
      defaultVatRate: 0.25,
      vatTreatmentReviewed: true,
    })
    expect(result[1].vatTreatmentReviewed).toBeUndefined()
  })
})
