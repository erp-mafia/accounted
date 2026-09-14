import { describe, expect, it } from 'vitest'
import {
  applySourceVatCodes,
  applyVatTreatmentReview,
  enrichChangedAccountMappingWithVat,
  enrichAccountMappingsWithVat,
  applyVatTreatmentReviewAll,
  isInVatReviewList,
  releaseAllConfirmed,
  releaseConfirmedRow,
  needsVatTreatmentReview,
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

describe('vat review list visibility', () => {
  const NONE: ReadonlySet<string> = new Set()

  // An EU purchase account whose label names no percentage, which is the
  // ordinary BAS spelling (4515 "Inköp varor EU", 4535 "Inköp tjänster EU").
  // vatRateFromLabel (#2596) reads the sats out of labels that state one, so a
  // label like "Inköp varor 12% EU" now defaults correctly; these do not, and
  // fall back to 25 %. A 12 % or 6 % acquisition booked here still has to reach
  // the sats select, which is what makes the row's visibility matter.
  function row() {
    return enrichAccountMappingsWithVat([mapping('4515', 'Inköp varor EU')], [])
  }

  it('counts a row as outstanding until it is reviewed', () => {
    const [before] = row()
    expect(needsVatTreatmentReview(before)).toBe(true)
    const [after] = applyVatTreatmentReview(row(), '4515', 'reverse_charge_eu_goods', 0.25)
    expect(needsVatTreatmentReview(after)).toBe(false)
  })

  it('keeps a row in the list between setting its momskod and its sats', () => {
    // The bug: picking the treatment marks the row reviewed, and a list keyed
    // on needsVatTreatmentReview drops it before the 25 % default can be
    // corrected. It drops the row whether or not the default happened to be
    // right, so the fix does not depend on the rate being wrong.
    const [afterTreatment] = applyVatTreatmentReview(
      row(), '4515', 'reverse_charge_eu_goods', 0.25,
    )
    expect(isInVatReviewList(afterTreatment, NONE)).toBe(false)
    expect(isInVatReviewList(afterTreatment, new Set(['4515']))).toBe(true)

    // And the rate is still correctable while it is visible.
    const [afterRate] = applyVatTreatmentReview(
      [afterTreatment], '4515', 'reverse_charge_eu_goods', 0.12,
    )
    expect(afterRate.defaultVatRate).toBe(0.12)
    expect(isInVatReviewList(afterRate, new Set(['4515']))).toBe(true)
  })

  it('shows an outstanding row whether or not it has been edited', () => {
    const [outstanding] = row()
    expect(isInVatReviewList(outstanding, NONE)).toBe(true)
    expect(isInVatReviewList(outstanding, new Set(['4515']))).toBe(true)
  })

  it('never pulls in a row that was not up for review', () => {
    // Class 5 with no label suggestion: requiresVatTreatmentReview is false, so
    // a stale entry in the edited set must not put it in the list.
    const [untouched] = enrichAccountMappingsWithVat([mapping('5410', 'Förbrukningsinventarier')], [])
    expect(untouched.requiresVatTreatmentReview).toBe(false)
    expect(isInVatReviewList(untouched, new Set(['5410']))).toBe(false)
  })

  it('lets the bulk confirm clear the list, since it feeds no edited set', () => {
    const confirmed = applyVatTreatmentReviewAll(row())
    expect(confirmed.every((m) => !needsVatTreatmentReview(m))).toBe(true)
    expect(confirmed.every((m) => !isInVatReviewList(m, NONE))).toBe(true)
  })

  it('holds a reviewed row until the set releases it, which is the confirm\'s job', () => {
    // Marking a row reviewed is NOT enough to take it out of the list: the
    // sticky set outranks it by design. Both confirm paths therefore have to
    // release, and this is the assertion that says so.
    const [edited] = applyVatTreatmentReview(row(), '4515', 'reverse_charge_eu_goods', 0.25)
    const [confirmed] = applyVatTreatmentReviewAll([edited])
    expect(needsVatTreatmentReview(confirmed)).toBe(false)
    expect(isInVatReviewList(confirmed, new Set(['4515']))).toBe(true)
    expect(isInVatReviewList(confirmed, releaseAllConfirmed(new Set(['4515'])))).toBe(false)
  })
})

describe('releaseConfirmedRow / releaseAllConfirmed', () => {
  it('drops just the confirmed row', () => {
    expect([...releaseConfirmedRow(new Set(['4515', '4535']), '4515')]).toEqual(['4535'])
  })

  it('clears every row for the bulk confirm', () => {
    expect(releaseAllConfirmed(new Set(['4515', '4535'])).size).toBe(0)
  })

  it('returns the same set when there is nothing to release', () => {
    const held = new Set(['4515'])
    expect(releaseConfirmedRow(held, '9999')).toBe(held)
    const empty: ReadonlySet<string> = new Set()
    expect(releaseAllConfirmed(empty)).toBe(empty)
  })

  it('leaves the other rows alone when one is confirmed', () => {
    // The per-row confirm must not behave like the bulk one. They were a single
    // function with an optional account until review pointed out that one stray
    // undefined would silently clear everything.
    const held = new Set(['4515', '4535', '4531'])
    expect([...releaseConfirmedRow(held, '4535')].sort()).toEqual(['4515', '4531'])
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
