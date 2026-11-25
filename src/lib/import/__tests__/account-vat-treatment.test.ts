import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { fortnoxVatCodeToTreatment } from '@/lib/providers/fortnox/vat-codes'
import {
  applySourceVatCodes,
  applyVatTreatmentReview,
  countsRcBasisTwice,
  enrichChangedAccountMappingWithVat,
  enrichAccountMappingsWithVat,
  applyVatTreatmentReviewAll,
  rcBasisPairFindings,
  rcMomskodSetAside,
} from '../account-vat-treatment'
import { suggestMappings } from '../account-mapper'
import { buildSIEVatDefaults } from '../account-sync'
import { parseSIEFile } from '../sie-parser'
import { prepareSIEPreviewMappings } from '../sie-preview-mappings'
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

  it('yields to a treatment the company already set on the account while the code agrees', () => {
    const chart = [{
      account_number: '3041',
      default_vat_treatment: 'standard_25',
      default_vat_rate: 0.25,
    } as never]
    const [prefilled] = applySourceVatCodes(
      [mapping('3041', 'Försäljning')],
      new Map([['3041', 'MP1']]),
      () => 'standard_25',
    )
    expect(enrichAccountMappingsWithVat([prefilled], chart)[0]).toMatchObject({
      defaultVatTreatment: 'standard_25',
      defaultVatRate: 0.25,
      providerVatCode: 'MP1',
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    })
  })

  it('puts the row back in review when the code names another treatment than the company set', () => {
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
      defaultVatTreatment: 'exempt',
      defaultVatRate: 0,
      providerVatCode: 'MF',
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
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

describe('a reverse-charge basis the file books on a separate pair (crm#1096)', () => {
  const MARCH = new Date(2026, 2, 1).getTime()
  const JUNE = new Date(2026, 5, 1).getTime()
  /** A cost account 8 vouchers book beside a pair, the file ending on the pair unless `latest` is false. */
  const beside = (account: string, name: string, latest = true, pair: [string, string] = ['4535', '4599']): AccountMapping => ({
    ...mapping(account, name),
    rcBasisPair: {
      pairs: [{ legs: [pair[0]], offsets: [pair[1]], vouchers: 8, lastAt: MARCH }],
      ...(latest ? {} : { ownBasisLastAt: JUNE }),
    },
  })
  const findingOf = (rows: AccountMapping[], account: string) => rcBasisPairFindings(rows).get(account)
  const withoutMomskod = {
    defaultVatTreatment: null,
    vatTreatmentSuggested: false,
    vatTreatmentReviewed: false,
    requiresVatTreatmentReview: true,
  }

  it('does not prefill a source reverse-charge code on a cost account the file ends up booking beside a pair', () => {
    const [prefilled] = applySourceVatCodes(
      [beside('5420', 'Programvaror')],
      new Map([['5420', 'ITEU']]),
      fortnoxVatCodeToTreatment,
    )
    expect(prefilled).toMatchObject({
      providerVatCode: 'ITEU',
      providerVatTreatment: 'reverse_charge_eu_services',
      ...withoutMomskod,
      defaultVatRate: null,
    })
    // The mapping step's own enrichment, which runs on the fetched rows, agrees.
    const [enriched] = enrichAccountMappingsWithVat([prefilled], [])
    expect(enriched).toMatchObject({ ...withoutMomskod, defaultVatRate: null })
    expect(rcMomskodSetAside(enriched, findingOf([enriched], '5420'))).toBe('reverse_charge_eu_services')
  })

  it('keeps the code as the suggestion where the file ends on the account carrying its own basis', () => {
    const [prefilled] = applySourceVatCodes(
      [beside('5420', 'Programvaror', false)],
      new Map([['5420', 'ITEU']]),
      fortnoxVatCodeToTreatment,
    )
    expect(prefilled).toMatchObject({
      defaultVatTreatment: 'reverse_charge_eu_services',
      vatTreatmentSuggested: true,
      requiresVatTreatmentReview: true,
    })
    // Nothing was set aside; the row warns about the 8 vouchers instead.
    const finding = findingOf([prefilled], '5420')
    expect(rcMomskodSetAside(prefilled, finding)).toBeNull()
    expect(countsRcBasisTwice('5420', prefilled.defaultVatTreatment, finding)).toBe(true)
  })

  it('does not prefill the label suggestion either, and leaves a non-reverse-charge one alone', () => {
    const rows = enrichAccountMappingsWithVat(
      [beside('6545', 'Inköp tjänster utanför EU 25%'), beside('4056', 'Inköp varor trepartshandel')],
      [],
    )
    const [service, triangulation] = rows
    expect(service).toMatchObject({ ...withoutMomskod, defaultVatRate: null })
    expect(rcMomskodSetAside(service, findingOf(rows, '6545'))).toBe('reverse_charge_non_eu_services')
    expect(triangulation).toMatchObject({ defaultVatTreatment: 'triangulation_eu_goods', vatTreatmentSuggested: true })
    expect(rcMomskodSetAside(triangulation, findingOf(rows, '4056'))).toBeNull()
  })

  it('keeps the momskod where the leg beside the account reports its basis elsewhere or nowhere', () => {
    // 6540 beside the group account 4500, which no box reads; 4051 beside an
    // import's 4545 (ruta 50). Either momskod is the only report of the basis.
    const rows = [
      beside('6540', 'IT-tjänster', true, ['4500', '4598']),
      mapping('4500', 'Övriga momsrelaterade inköp'),
      beside('4051', 'Inköp varor EU 25%', true, ['4545', '4599']),
      mapping('4545', 'Beskattningsunderlag import 25%'),
    ]
    const coded = applySourceVatCodes(rows, new Map([['6540', 'ITEU']]), fortnoxVatCodeToTreatment)
    expect(coded[0]).toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_services', vatTreatmentSuggested: true })
    const [service, , goods, importBasis] = enrichAccountMappingsWithVat(coded, [])
    expect(service).toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_services', defaultVatRate: 0.25 })
    expect(goods).toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_goods', defaultVatRate: 0.25 })
    expect(importBasis).toMatchObject({ defaultVatTreatment: 'import_goods' })
    expect(rcBasisPairFindings([service, goods, importBasis]).size).toBe(0)
  })

  it('rules the momskod out beside a leg of the chart\'s own that gets a reverse-charge momskod itself', () => {
    const cost = beside('5460', 'Inköp varor EU', true, ['4505', '4599'])
    // From the leg's label, from its source code, from the kontoplan.
    const byLabel = enrichAccountMappingsWithVat([cost, mapping('4505', 'Inköp varor från annat EU-land 25%')], [])
    expect(byLabel[0]).toMatchObject(withoutMomskod)
    expect(byLabel[1]).toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_goods' })
    const byCode = applySourceVatCodes(
      [cost, mapping('4505', 'Underlag')],
      new Map([['5460', 'IVEU'], ['4505', 'IVEU']]),
      fortnoxVatCodeToTreatment,
    )
    expect(byCode[0]).toMatchObject({ providerVatTreatment: 'reverse_charge_eu_goods', ...withoutMomskod })
    const chart = [{ account_number: '4505', default_vat_treatment: 'reverse_charge_eu_goods', default_vat_rate: 0.25 } as never]
    expect(enrichAccountMappingsWithVat([cost, mapping('4505', 'Underlag')], chart)[0]).toMatchObject(withoutMomskod)
    // A leg with no momskod reports nothing, so the cost account's stays.
    expect(enrichAccountMappingsWithVat([cost, mapping('4505', 'Underlag')], [])[0])
      .toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_goods', vatTreatmentSuggested: true })
    // One row re-enriched after a remap still sees the leg's row.
    expect(enrichChangedAccountMappingWithVat(byLabel, '5460', [])[0]).toMatchObject(withoutMomskod)
  })

  it('leaves a reverse-charge momskod the chart already has in place, with the warning', () => {
    // Accounted's own bookings on such an account report their basis through
    // this momskod alone, and the file may be an older year.
    const chart = [{
      account_number: '5420',
      default_vat_treatment: 'reverse_charge_eu_services',
      default_vat_rate: 0.25,
    } as never]
    const settled = {
      defaultVatTreatment: 'reverse_charge_eu_services',
      defaultVatRate: 0.25,
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: false,
    }
    for (const latest of [true, false]) {
      const rows = enrichAccountMappingsWithVat([beside('5420', 'Programvaror', latest)], chart)
      expect(rows[0]).toMatchObject(settled)
      expect(countsRcBasisTwice('5420', rows[0].defaultVatTreatment, findingOf(rows, '5420'))).toBe(true)
      // "Bekräfta alla föreslagna" then writes nothing new onto the kontoplan.
      expect(buildSIEVatDefaults(applyVatTreatmentReviewAll(rows)).get('5420'))
        .toEqual({ treatment: 'reverse_charge_eu_services', rate: 0.25 })
    }
    // A chart file's code that the vouchers rule out says nothing usable: the
    // row records it and keeps the kontoplan's answer, still settled.
    const [coded] = applySourceVatCodes(
      enrichAccountMappingsWithVat([beside('5420', 'Programvaror')], chart),
      new Map([['5420', 'ITGLOB']]),
      fortnoxVatCodeToTreatment,
    )
    expect(coded).toMatchObject({
      ...settled,
      providerVatCode: 'ITGLOB',
      providerVatTreatment: 'reverse_charge_non_eu_services',
    })
  })

  it('lets the user set it by hand, and countsRcBasisTwice still says what it costs', () => {
    const rows = applyVatTreatmentReview([beside('5420', 'Programvaror')], '5420', 'reverse_charge_eu_services', 0.25)
    const [row] = rows
    const finding = findingOf(rows, '5420')
    expect(row).toMatchObject({ defaultVatTreatment: 'reverse_charge_eu_services', vatTreatmentReviewed: true })
    expect(countsRcBasisTwice('5420', row.defaultVatTreatment, finding)).toBe(true)
    expect(countsRcBasisTwice('5420', 'triangulation_eu_goods', finding)).toBe(false)
    expect(countsRcBasisTwice('5420', null, finding)).toBe(false)
    expect(countsRcBasisTwice('5420', 'reverse_charge_eu_services', findingOf([mapping('5420', 'Programvaror')], '5420')))
      .toBe(false)
  })

  it('from file to chart: no reverse-charge momskod beside a pair that reports, the code everywhere else', () => {
    const sie = [
      '#SIETYP 4', '#RAR 0 20260101 20261231',
      '#KONTO 1930 "Bank"', '#KONTO 2614 "Utgående moms omvänd skattskyldighet"', '#KONTO 2645 "Beräknad ingående moms"',
      '#KONTO 4500 "Övriga momsrelaterade inköp"', '#KONTO 4535 "Inköp tjänster EU 25%"',
      '#KONTO 4598 "Justering omvänd moms"', '#KONTO 4599 "Justering omvänd moms"',
      '#KONTO 5420 "Programvaror"', '#KONTO 6540 "IT-tjänster"', '#KONTO 6550 "Konsultarvoden"',
      '#VER A 1 20260129 "Inköp"', '{',
      '#TRANS 1930 {} -100', '#TRANS 5420 {} 100', '#TRANS 4535 {} 100', '#TRANS 4599 {} -100',
      '#TRANS 2645 {} 25', '#TRANS 2614 {} -25', '}',
      '#VER A 2 20260205 "Inköp"', '{',
      '#TRANS 1930 {} -200', '#TRANS 6540 {} 200', '#TRANS 2645 {} 50', '#TRANS 2614 {} -50', '}',
      // The pair's leg is the group account 4500: only the momskod reports ruta 21.
      '#VER A 3 20260210 "Inköp"', '{',
      '#TRANS 1930 {} -1000', '#TRANS 6550 {} 1000', '#TRANS 4500 {} 1000', '#TRANS 4598 {} -1000',
      '#TRANS 2645 {} 250', '#TRANS 2614 {} -250', '}',
    ].join('\n')
    const parsed = parseSIEFile(sie)
    const { mappings } = prepareSIEPreviewMappings(parsed, suggestMappings(parsed.accounts, BAS_REFERENCE))
    const coded = applySourceVatCodes(
      mappings,
      new Map([['5420', 'ITEU'], ['6540', 'ITGLOB'], ['6550', 'ITEU']]),
      fortnoxVatCodeToTreatment,
    )
    // "Bekräfta alla föreslagna", then what the import writes onto the chart.
    const defaults = buildSIEVatDefaults(applyVatTreatmentReviewAll(enrichAccountMappingsWithVat(coded, [])))
    expect(defaults.get('5420')).toEqual({ treatment: null, rate: null })
    expect(defaults.get('6540')).toEqual({ treatment: 'reverse_charge_non_eu_services', rate: 0.25 })
    expect(defaults.get('6550')).toEqual({ treatment: 'reverse_charge_eu_services', rate: 0.25 })
  })
})
