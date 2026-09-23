import { describe, expect, it } from 'vitest'
import {
  applySourceVatCodes,
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

  it('stops asking about an account settled to NO treatment', () => {
    // The answer "Använd BAS-standard / Ingen" writes NULL into
    // default_vat_treatment, which is the same bytes as never having been
    // asked. Reading the treatment alone brought every such account back into
    // the review list on every later import: 13 of the 16 rows a real 2022
    // Spiris file raised were accounts answered that way during 2021 (#2700).
    const [result] = enrichAccountMappingsWithVat(
      [mapping('4400', 'Momspliktiga inköp i Sverige')],
      [{
        account_number: '4400',
        default_vat_treatment: null,
        default_vat_rate: null,
        vat_treatment_reviewed_at: '2026-09-17T10:00:00.000Z',
      } as never],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: null,
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })

  it('keeps a settled "none" even when the source chart names a treatment', () => {
    // Precedence is chart treatment > provider code > label (DECISIONS
    // 2026-09-14, #2585): a treatment the company set in Accounted is a
    // deliberate later edit, and the provider code is the user's own
    // configuration in the system they are leaving. A settled "none" is the
    // same kind of deliberate edit, so it takes the same precedence. The
    // sibling rule for a settled TREATMENT is pinned in the applySourceVatCodes
    // block below.
    const [result] = enrichAccountMappingsWithVat(
      [{ ...mapping('4400', 'Momspliktiga inköp i Sverige'),
         providerVatCode: '23-25%',
         providerVatTreatment: 'reverse_charge_domestic' }],
      [{
        account_number: '4400',
        default_vat_treatment: null,
        default_vat_rate: null,
        vat_treatment_reviewed_at: '2026-09-17T10:00:00.000Z',
      } as never],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: null,
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })

  it('leaves a settled account alone when the source chart agrees with it', () => {
    const [result] = enrichAccountMappingsWithVat(
      [{ ...mapping('4415', 'Inköpta varor i Sverige, omvänd skattskyldighet'),
         providerVatCode: '23-25%',
         providerVatTreatment: 'reverse_charge_domestic' }],
      [{
        account_number: '4415',
        default_vat_treatment: 'reverse_charge_domestic',
        default_vat_rate: 0.25,
        vat_treatment_reviewed_at: '2026-09-17T10:00:00.000Z',
      } as never],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: 'reverse_charge_domestic',
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })

  it('still asks about the same account when nobody has settled it', () => {
    // The other half of the pair: without the timestamp the row is genuinely
    // undecided, and a class 4 account must still be asked about.
    const [result] = enrichAccountMappingsWithVat(
      [mapping('4400', 'Momspliktiga inköp i Sverige')],
      [{
        account_number: '4400',
        default_vat_treatment: null,
        default_vat_rate: null,
      } as never],
    )
    expect(result.requiresVatTreatmentReview).toBe(true)
    expect(result.vatTreatmentReviewed).toBe(false)
  })

  it('recognises an account settled before the timestamp column existed', () => {
    // Why the column needs no backfill: a real treatment is still accepted as
    // its own evidence of having been settled.
    const [result] = enrichAccountMappingsWithVat(
      [mapping('3041', 'Försäljning tjänst 25% sv')],
      [{
        account_number: '3041',
        default_vat_treatment: 'standard_25',
        default_vat_rate: 0.25,
        vat_treatment_reviewed_at: null,
      } as never],
    )
    expect(result).toMatchObject({
      defaultVatTreatment: 'standard_25',
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

describe('applySourceVatCodes (#2585)', () => {
  const translate = (code: string, accountNumber: string) =>
    code === 'MP1' && accountNumber.startsWith('3') ? ('standard_25' as const)
    : code === 'IVEU' && !accountNumber.startsWith('3') ? ('reverse_charge_eu_goods' as const)
    : null

  it('prefills a translated source code as a suggestion that still needs the confirm', () => {
    // Reviewed rows are written onto existing chart accounts and let the
    // wizard skip the mapping step, so a code the user has not seen must
    // arrive unreviewed, exactly like a label suggestion.
    const [sales, purchase] = applySourceVatCodes(
      [mapping('3041', 'Försäljn tjänst 25% sv'), mapping('4056', 'Inköp varor EU')],
      new Map([['3041', 'MP1'], ['4056', 'IVEU']]),
      translate,
    )
    expect(sales).toMatchObject({
      providerVatCode: 'MP1',
      providerVatTreatment: 'standard_25',
      defaultVatTreatment: 'standard_25',
      defaultVatRate: 0.25,
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
    expect(purchase).toMatchObject({
      providerVatCode: 'IVEU',
      providerVatTreatment: 'reverse_charge_eu_goods',
      defaultVatTreatment: 'reverse_charge_eu_goods',
      defaultVatRate: 0.25,
      vatTreatmentReviewed: false,
    })
  })

  it('takes the acquisition rate from the label on a reverse-charge purchase account', () => {
    // Fortnox 4516/4517 carry the same IVEU code as 4515; only the label
    // says 12% or 6%. A flat 25% would register the account under the wrong
    // rate bucket and flag every correct voucher as an rc-basis gap.
    const [twelve, six, plain] = applySourceVatCodes(
      [
        mapping('4516', 'Inköp av varor från annat EU-land, 12%'),
        mapping('4517', 'Inköp av varor från annat EU-land, 6%'),
        mapping('4515', 'Inköp av varor från annat EU-land'),
      ],
      new Map([['4516', 'IVEU'], ['4517', 'IVEU'], ['4515', 'IVEU']]),
      translate,
    )
    expect(twelve.defaultVatRate).toBe(0.12)
    expect(six.defaultVatRate).toBe(0.06)
    expect(plain.defaultVatRate).toBe(0.25)
    // The same rows keep their rate through the mapping-step enrichment.
    const [e12, e6] = enrichAccountMappingsWithVat([twelve, six], [])
    expect(e12.defaultVatRate).toBe(0.12)
    expect(e6.defaultVatRate).toBe(0.06)
  })

  it('keeps an untranslated code visible without deciding the treatment', () => {
    const [result] = applySourceVatCodes(
      [mapping('3001', 'Uttag')],
      new Map([['3001', 'UT']]),
      translate,
    )
    expect(result.providerVatCode).toBe('UT')
    expect(result.providerVatTreatment).toBeNull()
    expect(result.defaultVatTreatment).toBeUndefined()
  })

  it('leaves remapped accounts, other classes and accounts without a code alone', () => {
    const remapped = { ...mapping('3041', 'Försäljning'), targetAccount: '3010', targetName: 'Försäljning' }
    const [asset, moms, noCode, moved] = applySourceVatCodes(
      [mapping('1930', 'Bank'), mapping('2611', 'Utgående moms'), mapping('3041', 'Försäljning'), remapped],
      new Map([['1930', 'MP1'], ['2611', 'U1'], ['3010', 'MP1']]),
      translate,
    )
    for (const row of [asset, moms, noCode, moved]) {
      expect(row.providerVatCode).toBeUndefined()
      expect(row.providerVatTreatment).toBeUndefined()
      expect(row.defaultVatTreatment).toBeUndefined()
    }
  })

  it('is suggested by the mapping-step enrichment ahead of the label', () => {
    // The label alone would say standard_25 for this account; the source
    // system says it is momsfri, and its configuration is what gets
    // suggested. Still unreviewed: the user confirms it like any suggestion.
    const [prefilled] = applySourceVatCodes(
      [mapping('3041', 'Försäljning tjänster 25%')],
      new Map([['3041', 'MF']]),
      () => 'exempt',
    )
    const [enriched] = enrichAccountMappingsWithVat([prefilled], [])
    expect(enriched).toMatchObject({
      providerVatCode: 'MF',
      providerVatTreatment: 'exempt',
      defaultVatTreatment: 'exempt',
      defaultVatRate: 0,
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
  })

  it('yields to a treatment the company already set on the account', () => {
    const [prefilled] = applySourceVatCodes(
      [mapping('3041', 'Försäljning')],
      new Map([['3041', 'MF']]),
      () => 'exempt',
    )
    const [enriched] = enrichAccountMappingsWithVat([prefilled], [{
      account_number: '3041',
      default_vat_treatment: 'standard_25',
      default_vat_rate: 0.25,
    } as never])
    expect(enriched).toMatchObject({
      defaultVatTreatment: 'standard_25',
      defaultVatRate: 0.25,
      providerVatCode: 'MF',
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })

  it('does not write over a treatment the company cleared: a re-sync still asks', () => {
    // The account exists in the chart with default_vat_treatment NULL (the
    // user set "Använd BAS-standard" after the first migration). The
    // provider code comes back as a suggestion, so nothing is persisted on
    // the existing account until the user confirms the row again.
    const [prefilled] = applySourceVatCodes(
      [mapping('3041', 'Försäljning')],
      new Map([['3041', 'MP1']]),
      () => 'standard_25',
    )
    const [enriched] = enrichAccountMappingsWithVat([prefilled], [{
      account_number: '3041',
      default_vat_treatment: null,
      default_vat_rate: null,
    } as never])
    expect(enriched).toMatchObject({
      defaultVatTreatment: 'standard_25',
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
  })

  it('survives a remap and back: the provider suggestion is derived again on identity', () => {
    const [prefilled] = applySourceVatCodes(
      [mapping('4056', 'Inköp varor EU')],
      new Map([['4056', 'MF']]),
      () => 'exempt',
    )
    const [remapped] = enrichAccountMappingsWithVat([{
      ...prefilled, targetAccount: '4010', targetName: 'Inköp material',
    }], [])
    expect(remapped).toMatchObject({ defaultVatTreatment: null, vatTreatmentReviewed: true })

    const [back] = enrichAccountMappingsWithVat([{
      ...remapped, targetAccount: '4056', targetName: 'Inköp varor EU',
    }], [])
    expect(back).toMatchObject({
      providerVatCode: 'MF',
      defaultVatTreatment: 'exempt',
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
    })
  })

  it('still label-suggests an account whose code could not be translated', () => {
    const [prefilled] = applySourceVatCodes(
      [mapping('4056', 'Inköp varor 25% EU')],
      new Map([['4056', 'XYZ']]),
      () => null,
    )
    const [enriched] = enrichAccountMappingsWithVat([prefilled], [])
    expect(enriched).toMatchObject({
      providerVatCode: 'XYZ',
      providerVatTreatment: null,
      defaultVatTreatment: 'reverse_charge_eu_goods',
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
  })
})
