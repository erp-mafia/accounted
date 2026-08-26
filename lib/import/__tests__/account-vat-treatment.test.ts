import { describe, expect, it } from 'vitest'
import {
  applyVatTreatmentReview,
  enrichChangedAccountMappingWithVat,
  enrichAccountMappingsWithVat,
  applyVatTreatmentReviewAll,
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

  it('suggests oss from an OSS label and leaves the BAS 3106 label for review', () => {
    const [oss, b2c] = enrichAccountMappingsWithVat(
      [
        mapping('3111', 'Försäljning enl. OSS (Spanien 21%)'),
        mapping('3106', 'Försäljning varor till annat EU-land, momspliktig'),
      ],
      [],
    )
    expect(oss).toMatchObject({
      defaultVatTreatment: 'oss',
      defaultVatRate: null,
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
    expect(b2c).toMatchObject({
      defaultVatTreatment: null,
      vatTreatmentSuggested: false,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
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

  it('preserves an existing booking rate when suggesting a missing treatment', () => {
    const [result] = enrichAccountMappingsWithVat(
      [mapping('3041', 'Försäljning tjänst 25% sv')],
      [{
        account_number: '3041',
        default_vat_treatment: null,
        default_vat_rate: 0.12,
      } as never],
    )
    expect(result.defaultVatTreatment).toBe('standard_25')
    expect(result.defaultVatRate).toBe(0.12)
  })

  it('requires review for a suggested class 6 service treatment', () => {
    const [result] = enrichAccountMappingsWithVat(
      [mapping('6545', 'Inköp tjänster utanför EU 25%')],
      [],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: 'reverse_charge_non_eu_services',
      requiresVatTreatmentReview: true,
      vatTreatmentReviewed: false,
    })
  })
})

describe('applyVatTreatmentReview', () => {
  it('persists a suggestion only after an explicit row confirmation', () => {
    const mappings = enrichAccountMappingsWithVat([
      mapping('4056', 'Inköp varor 25% EU'),
    ], [])

    expect(mappings[0].vatTreatmentReviewed).toBe(false)
    const reviewed = applyVatTreatmentReview(
      mappings,
      '4056',
      mappings[0].defaultVatTreatment ?? null,
      mappings[0].defaultVatRate ?? null,
    )
    expect(reviewed[0]).toMatchObject({
      defaultVatTreatment: 'reverse_charge_eu_goods',
      vatTreatmentReviewed: true,
      vatTreatmentSuggested: false,
    })
  })

  it('clears hidden review state on remap and restores it on identity mapping', () => {
    const [suggested] = enrichAccountMappingsWithVat([
      mapping('4056', 'Inköp varor 25% EU'),
    ], [])

    const [remapped] = enrichAccountMappingsWithVat([{
      ...suggested,
      targetAccount: '4010',
      targetName: 'Inköp material',
    }], [])
    expect(remapped).toMatchObject({
      defaultVatTreatment: null,
      requiresVatTreatmentReview: false,
      vatTreatmentReviewed: true,
    })

    const [identity] = enrichAccountMappingsWithVat([{
      ...remapped,
      targetAccount: '4056',
      targetName: 'Inköp varor 25% EU',
    }], [])
    expect(identity).toMatchObject({
      defaultVatTreatment: 'reverse_charge_eu_goods',
      requiresVatTreatmentReview: true,
      vatTreatmentReviewed: false,
    })
  })

  it('preserves another row review when one mapping changes', () => {
    const initial = enrichAccountMappingsWithVat([
      mapping('3041', 'Försäljning tjänst 25% sv'),
      mapping('4056', 'Inköp varor 25% EU'),
    ], [])
    const reviewed = applyVatTreatmentReview(initial, '3041', 'exempt', 0)
    const remapped = enrichChangedAccountMappingWithVat(
      reviewed.map((item) => item.sourceAccount === '4056'
        ? { ...item, targetAccount: '4010', targetName: 'Inköp material' }
        : item),
      '4056',
      [],
    )

    expect(remapped[0]).toMatchObject({
      defaultVatTreatment: 'exempt',
      defaultVatRate: 0,
      vatTreatmentReviewed: true,
    })
  })
})

describe('applyVatTreatmentReviewAll', () => {
  it('marks every unreviewed row reviewed and keeps its suggested default', () => {
    const mappings = [
      {
        sourceAccount: '3001', sourceName: 'Försäljning', targetAccount: '3001', targetName: 'Försäljning',
        confidence: 1, matchType: 'exact', isOverride: false,
        defaultVatTreatment: 'sales_25', defaultVatRate: 25,
        vatTreatmentSuggested: true, vatTreatmentReviewed: false, requiresVatTreatmentReview: true,
      },
      {
        sourceAccount: '4010', sourceName: 'Inköp', targetAccount: '4010', targetName: 'Inköp',
        confidence: 1, matchType: 'exact', isOverride: false,
        defaultVatTreatment: null, defaultVatRate: null,
        vatTreatmentSuggested: false, vatTreatmentReviewed: false, requiresVatTreatmentReview: true,
      },
      {
        sourceAccount: '1930', sourceName: 'Bank', targetAccount: '1930', targetName: 'Bank',
        confidence: 1, matchType: 'exact', isOverride: false,
        defaultVatTreatment: null, defaultVatRate: null,
        vatTreatmentSuggested: false, vatTreatmentReviewed: true, requiresVatTreatmentReview: false,
      },
    ] as never[]

    const result = applyVatTreatmentReviewAll(mappings)

    // Both review rows confirmed in one action, defaults untouched.
    expect(result[0]).toMatchObject({ vatTreatmentReviewed: true, defaultVatTreatment: 'sales_25', defaultVatRate: 25 })
    expect(result[1]).toMatchObject({ vatTreatmentReviewed: true, defaultVatTreatment: null })
    // Already-reviewed rows pass through by reference.
    expect(result[2]).toBe(mappings[2])
    // No row is left gating the wizard's Continue button.
    expect(result.filter((m: { requiresVatTreatmentReview?: boolean; vatTreatmentReviewed?: boolean }) =>
      m.requiresVatTreatmentReview && !m.vatTreatmentReviewed
    )).toHaveLength(0)
  })
})
