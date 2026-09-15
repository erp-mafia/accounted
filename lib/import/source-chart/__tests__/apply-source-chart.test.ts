import { describe, it, expect } from 'vitest'
import { applySourceChartCsv } from '../apply-source-chart'
import { enrichAccountMappingsWithVat } from '@/lib/import/account-vat-treatment'
import { ACCOUNT_TO_BOX } from '@/lib/vat/moms-box-mapping'
import { suggestVatTreatment } from '@/lib/vat/account-vat-treatment'
import type { AccountMapping } from '@/lib/import/types'

function mapping(account: string, name: string, target = account): AccountMapping {
  return {
    sourceAccount: account,
    sourceName: name,
    targetAccount: target,
    targetName: name,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

function csv(...rows: string[]): string {
  return '﻿' + ['IsActive;AccountNumber;AccountName;VatCodeAndPercent', ...rows].join('\r\n') + '\r\n'
}

describe('applySourceChartCsv', () => {
  it('puts the source system momskod on the mapping as a reviewable suggestion', () => {
    const { mappings, summary } = applySourceChartCsv(
      [mapping('3058', 'Försäljn varor EG momsfri')],
      csv('True;3058;Försäljn varor EG momsfri;35-0%'),
    )
    expect(mappings[0]).toMatchObject({
      providerVatCode: '35-0%',
      providerVatTreatment: 'reverse_charge_eu_goods',
      defaultVatTreatment: 'reverse_charge_eu_goods',
      vatTreatmentSuggested: true,
      vatTreatmentReviewed: false,
      requiresVatTreatmentReview: true,
    })
    expect(summary).toMatchObject({ codesApplied: 1, treatmentsApplied: 1, codesWithoutTreatment: 0 })
  })

  it('beats the label guess, which is the whole point', () => {
    // The label says EG and varor, so suggestVatTreatment would reach for the
    // momsfri ruta 35 treatment. The source system says this one carries
    // Swedish VAT, and it is the one that knows.
    const { mappings } = applySourceChartCsv(
      [mapping('3056', 'Försäljn varor till EG 25% momspliktig')],
      csv('True;3056;Försäljn varor till EG 25% momspliktig;05-25%'),
    )
    expect(mappings[0].providerVatTreatment).toBe('standard_25')
    expect(mappings[0].defaultVatRate).toBe(0.25)
  })

  it('takes the rate the code states over the one the label implies', () => {
    // applySourceVatCodes derives the rate from the account name, which is the
    // weaker source. A chart is free to code 20-12% on an account whose name
    // carries no percentage, and the label fallback then answers 25 %: the
    // wrong rate bucket, which makes the filing gate flag correct vouchers as
    // rc-basis gaps.
    const { mappings } = applySourceChartCsv(
      [mapping('4515', 'Inköp varor EU')],
      csv('True;4515;Inköp varor EU;20-12%'),
    )
    expect(mappings[0].providerVatTreatment).toBe('reverse_charge_eu_goods')
    expect(mappings[0].defaultVatRate).toBe(0.12)
  })

  it('does not give a rate to a treatment that deliberately has none', () => {
    // vinstmarginalbeskattning has no single sats, so defaultRateForVatTreatment
    // answers null on purpose. A chart still codes the account 07-25%, and an
    // override that fired on every treatment would write 25 % over that null.
    // The chart only outranks the label where the label was consulted at all,
    // which is a reverse charge on a purchase account.
    const { mappings } = applySourceChartCsv(
      [mapping('3110', 'Försäljning vinstmarginalbeskattning')],
      csv('True;3110;Försäljning vinstmarginalbeskattning;07-25%'),
    )
    expect(mappings[0].providerVatTreatment).toBe('vmb')
    expect(mappings[0].defaultVatRate).toBeNull()
  })

  it('leaves the rate alone when the code states none', () => {
    // The bare form names a box but no sats, so there is nothing to prefer and
    // the treatment's own default stands.
    const { mappings } = applySourceChartCsv(
      [mapping('3051', 'Försäljn varor 25% sv')],
      csv('True;3051;Försäljn varor 25% sv;05-25%'),
    )
    expect(mappings[0].defaultVatRate).toBe(0.25)
  })

  it('keeps an untranslatable code visible instead of dropping it', () => {
    // A bare "05" names the box but no sats, and 05 is the one box whose
    // treatment depends on the rate, so it cannot be read. The row must keep
    // the code and stay up for review. (Ruta 06 and 50 were the example here
    // until own_use and import_goods existed.)
    const { mappings, summary } = applySourceChartCsv(
      [mapping('3051', 'Försäljning inrikes')],
      csv('True;3051;Försäljning inrikes;05'),
    )
    expect(mappings[0].providerVatCode).toBe('05')
    expect(mappings[0].providerVatTreatment).toBeNull()
    expect(summary).toMatchObject({ codesApplied: 1, treatmentsApplied: 0, codesWithoutTreatment: 1 })
  })

  it('translates trepartshandel now that there is a treatment for it', () => {
    // Ruta 38 used to land in the untranslatable set and the row fell through
    // to the label, which reads EU and varor and answered EU-varor: ruta 35,
    // a different transaction with a different reporting duty.
    const { mappings } = applySourceChartCsv(
      [mapping('3057', 'Treparts försäljn varor till EG 25%')],
      csv('True;3057;Treparts försäljn varor till EG 25%;38-0%'),
    )
    expect(mappings[0].providerVatTreatment).toBe('triangulation_eu_goods')
    expect(mappings[0].defaultVatTreatment).toBe('triangulation_eu_goods')
  })

  it('lets the label fill an untranslated row, and leaves it distinguishable', () => {
    // Both halves of the recorded decision, pinned together. The label keeps
    // filling the row, so the user is not left with an empty select. But the
    // pair (code present, provider treatment null) has to survive, because it
    // is the only thing that tells the step this suggestion came from the
    // account name and not from the code beside it.
    //
    // An export label carrying a code that names a box without a sats: the
    // label answers, the code does not, and the pair has to survive.
    const { mappings } = applySourceChartCsv(
      [mapping('3055', 'Försäljn varor utanför EG momsfri')],
      csv('True;3055;Försäljn varor utanför EG momsfri;05'),
    )
    const [enriched] = enrichAccountMappingsWithVat(mappings, [])
    expect(enriched.defaultVatTreatment).toBe('export_goods')
    expect(enriched.providerVatCode).toBe('05')
    expect(enriched.providerVatTreatment).toBeNull()
  })

  it('leaves the mappings alone when the file cannot be read', () => {
    const input = [mapping('3051', 'Försäljn varor 25% sv')]
    const { mappings, notices, summary } = applySourceChartCsv(
      input,
      'Konto;Benämning;Momskod\r\n3001;Försäljning;MP1\r\n',
    )
    expect(mappings).toBe(input)
    expect(notices[0]?.code).toBe('source_chart_unrecognised')
    expect(summary.codesApplied).toBe(0)
    expect(summary.formatLabel).toBeNull()
  })

  it('says so when the chart carries no momskoder at all', () => {
    const { mappings, notices } = applySourceChartCsv(
      [mapping('3051', 'Test')],
      csv('True;3051;Test;', 'True;3052;Test 2;'),
    )
    expect(mappings[0].providerVatCode).toBeUndefined()
    expect(notices.map((n) => n.code)).toContain('source_chart_no_codes')
  })

  it('ignores chart rows this import does not map', () => {
    // The export is the vendor's whole chart, over a thousand rows. Only the
    // accounts the SIE file actually uses are touched.
    const { mappings, summary } = applySourceChartCsv(
      [mapping('3051', 'Försäljn varor 25% sv')],
      csv('True;3051;Försäljn varor 25% sv;05-25%', 'False;9999;Något annat;42-0%'),
    )
    expect(mappings).toHaveLength(1)
    expect(summary).toMatchObject({ accountsInChart: 2, activeInChart: 1, codesApplied: 1 })
  })

  it('replaces the previous chart instead of layering onto it', () => {
    // The wrong-year mistake the help text warns about, and the recovery the
    // "Byt fil" button offers. A 2021 chart lists 3045; the 2022 chart does
    // not, because the account went inactive. Before this, 3045 kept the 2021
    // code forever and only restarting the wizard cleared it.
    const first = applySourceChartCsv(
      [mapping('3045', 'Försäljn tjänst utanför EG momsfri'), mapping('3041', 'Försäljning tjänst 25% sv')],
      csv('True;3045;Försäljn tjänst utanför EG momsfri;40-0%', 'True;3041;Försäljning tjänst 25% sv;05-25%'),
    )
    expect(first.mappings[0].providerVatCode).toBe('40-0%')

    const second = applySourceChartCsv(
      first.mappings,
      csv('True;3041;Försäljning tjänst 25% sv;05-12%'),
    )
    // Restored to what the label alone says, which is where it started.
    expect(second.mappings[0].providerVatCode).toBeNull()
    expect(second.mappings[0].providerVatTreatment).toBeNull()
    expect(second.mappings[0].defaultVatTreatment).toBe('export_services')
    // And the row the new file does describe takes the new file's answer.
    expect(second.mappings[1].providerVatCode).toBe('05-12%')
    expect(second.mappings[1].defaultVatTreatment).toBe('reduced_12')
    // Counted over what THIS file did, so the line cannot claim the one
    // account it described was two.
    expect(second.summary).toMatchObject({ accountsInChart: 1, codesApplied: 1, treatmentsApplied: 1 })
  })

  it('leaves the previous chart standing when the new file cannot be read', () => {
    const first = applySourceChartCsv(
      [mapping('3058', 'Försäljn varor EG momsfri')],
      csv('True;3058;Försäljn varor EG momsfri;35-0%'),
    )
    const second = applySourceChartCsv(first.mappings, 'Konto;Benämning\r\n3058;Något\r\n')
    expect(second.mappings[0].providerVatCode).toBe('35-0%')
    expect(second.notices[0]?.code).toBe('source_chart_unrecognised')
  })

  it('will not overwrite a treatment the user has already confirmed', () => {
    // The upload sits above the table in the same step, so confirming a few
    // rows and then remembering the chart export is an ordinary order of
    // events. The source system does not get to undo an answer the user gave.
    const confirmed: AccountMapping = {
      ...mapping('3056', 'Försäljn varor till EG 25% momspliktig'),
      defaultVatTreatment: 'oss',
      defaultVatRate: null,
      vatTreatmentSuggested: false,
      vatTreatmentReviewed: true,
      requiresVatTreatmentReview: true,
    }
    const { mappings, summary } = applySourceChartCsv(
      [confirmed],
      csv('True;3056;Försäljn varor till EG 25% momspliktig;35-0%'),
    )
    expect(mappings[0].defaultVatTreatment).toBe('oss')
    expect(mappings[0].vatTreatmentReviewed).toBe(true)
    expect(mappings[0].providerVatCode).toBeUndefined()
    expect(summary.codesApplied).toBe(0)
  })

  it('will not overwrite a treatment the company chart already carries', () => {
    // Same flag, different origin: enrichAccountMappingsWithVat marks a row
    // reviewed when the account already has a treatment in Accounted, and a
    // re-sync must not walk that back to the old system's answer.
    const existing = enrichAccountMappingsWithVat(
      [mapping('3058', 'Försäljn varor EG momsfri')],
      [{ account_number: '3058', default_vat_treatment: 'exempt', default_vat_rate: 0 } as never],
    )
    const { mappings } = applySourceChartCsv(
      existing,
      csv('True;3058;Försäljn varor EG momsfri;35-0%'),
      [{ account_number: '3058', default_vat_treatment: 'exempt', default_vat_rate: 0 } as never],
    )
    expect(mappings[0].defaultVatTreatment).toBe('exempt')
    expect(mappings[0].providerVatCode).toBeUndefined()
  })

  it('counts an unreadable code in the summary, not in the notices', () => {
    // The step renders this count as a plain line beside "N konton fick
    // momskod": two sentences of one answer. A notice would fold it away,
    // because ImportNotices shows one and hides the rest, which is right for a
    // file that went wrong and wrong for a file that worked.
    const { summary, notices } = applySourceChartCsv(
      [mapping('3051', 'Försäljning inrikes')],
      csv('True;3051;Försäljning inrikes;05'),
    )
    expect(summary.codesWithoutTreatment).toBe(1)
    expect(notices).toEqual([])
  })

  it('names the accounts it could not translate, in table order', () => {
    // A bare count sends the user hunting through paginated pages for rows it
    // will not identify. Ascending, so the line reads in the order the table
    // shows. Ruta 06 and 50 are real and correctly coded in the source; this
    // project just has no treatment for either.
    const { summary } = applySourceChartCsv(
      [
        mapping('4051', 'Inköp varor'),
        mapping('3052', 'Försäljning butik'),
        mapping('3051', 'Försäljning inrikes'),
      ],
      csv(
        // A sales box on a purchase account, refused so an acquisition cannot
        // land in a sales box; a rate the format does not have; a box that
        // names no sats.
        'True;4051;Inköp varor;35-0%',
        'True;3052;Försäljning butik;05-9%',
        'True;3051;Försäljning inrikes;05',
      ),
    )
    expect(summary.accountsWithoutTreatment).toEqual(['3051', '3052', '4051'])
    // Derived from the list, so the sentence can never name three and count two.
    expect(summary.codesWithoutTreatment).toBe(summary.accountsWithoutTreatment.length)
  })

  it('leaves a translated account out of the list', () => {
    const { summary } = applySourceChartCsv(
      [mapping('3058', 'Försäljn varor EG momsfri'), mapping('3051', 'Försäljning inrikes')],
      csv('True;3058;Försäljn varor EG momsfri;35-0%', 'True;3051;Försäljning inrikes;05'),
    )
    expect(summary.accountsWithoutTreatment).toEqual(['3051'])
  })

  it('leaves a row with nothing at all when all three sources are silent', () => {
    // The state the mapping step's fourth source-code sentence is about, and
    // the one that used to borrow the third and claim a suggestion that is not
    // there. A bare "05" names ruta 05 but no sats, and 05 is the one box whose
    // treatment depends on the rate, so the code cannot be read; 3051 is not in
    // ACCOUNT_TO_BOX; and the label names no percentage, so the suggester
    // declines too. The amount reaches no ruta until the user picks one.
    const { mappings } = applySourceChartCsv(
      [mapping('3051', 'Försäljning inrikes')],
      csv('True;3051;Försäljning inrikes;05'),
    )
    const row = mappings[0]
    expect(row.providerVatCode).toBe('05')
    expect(row.providerVatTreatment).toBeNull()
    expect(row.defaultVatTreatment ?? null).toBeNull()
    expect(ACCOUNT_TO_BOX['3051']).toBeUndefined()
    expect(suggestVatTreatment('3051', 'Försäljning inrikes')).toBeNull()
  })

  it('reads an import basis whatever number the chart put it on', () => {
    // The whole point of import_goods: ACCOUNT_RUTA knows 4545 to 4547, and a
    // chart that books the beskattningsunderlag anywhere else used to drop the
    // amount out of the declaration in silence.
    for (const account of ['4545', '4540']) {
      const { mappings } = applySourceChartCsv(
        [mapping(account, 'Beskattningsunderlag import 25%')],
        csv(`True;${account};Beskattningsunderlag import 25%;50-25%`),
      )
      expect(mappings[0].providerVatTreatment).toBe('import_goods')
      expect(mappings[0].defaultVatRate).toBe(0.25)
    }
  })

  it('reads an uttag whatever number the chart put it on, and takes the code rate', () => {
    for (const account of ['3401', '3910']) {
      const { mappings } = applySourceChartCsv(
        [mapping(account, 'Egna uttag av varor')],
        csv(`True;${account};Egna uttag av varor;06-12%`),
      )
      expect(mappings[0].providerVatTreatment).toBe('own_use')
      // The box covers 25, 12 and 6 %, so the code's rate beats the default.
      expect(mappings[0].defaultVatRate).toBe(0.12)
    }
  })

  it('does not touch a remapped row, only identity mappings', () => {
    // 3056 redirected to 3051 takes the target's treatment, not the source
    // account's code: applySourceVatCodes guards this and the guard matters,
    // because the code describes the account being left behind.
    const { mappings } = applySourceChartCsv(
      [mapping('3056', 'Försäljn varor till EG', '3051')],
      csv('True;3056;Försäljn varor till EG;05-25%'),
    )
    expect(mappings[0].providerVatCode).toBeUndefined()
  })
})
