import { describe, it, expect } from 'vitest'
import { applySourceChartCsv } from '../apply-source-chart'
import { enrichAccountMappingsWithVat } from '@/lib/import/account-vat-treatment'
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
    // Ruta 50, beskattningsunderlag vid import: a real code with no treatment
    // here. The row must keep the code and stay up for review.
    const { mappings, summary } = applySourceChartCsv(
      [mapping('4545', 'Import av varor, 25 % moms')],
      csv('True;4545;Import av varor, 25 % moms;50-25%'),
    )
    expect(mappings[0].providerVatCode).toBe('50-25%')
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
    // Constructed rather than observed: since ruta 38 became translatable,
    // every code this project cannot read (06 uttag, 50 import) sits on a
    // label the suggester also declines, so no export in hand produces the
    // combination. The contract still has to hold the next time a ruta is
    // added or removed, which is what this pins. Export label, import code.
    const { mappings } = applySourceChartCsv(
      [mapping('3055', 'Försäljn varor utanför EG momsfri')],
      csv('True;3055;Försäljn varor utanför EG momsfri;06-25%'),
    )
    const [enriched] = enrichAccountMappingsWithVat(mappings, [])
    expect(enriched.defaultVatTreatment).toBe('export_goods')
    expect(enriched.providerVatCode).toBe('06-25%')
    expect(enriched.providerVatTreatment).toBeNull()
  })

  it('leaves the mappings alone when the file cannot be read', () => {
    const input = [mapping('3051', 'Försäljn varor 25% sv')]
    const { mappings, warnings, summary } = applySourceChartCsv(
      input,
      'Konto;Benämning;Momskod\r\n3001;Försäljning;MP1\r\n',
    )
    expect(mappings).toBe(input)
    expect(warnings[0]).toContain('Spiris Bokföring')
    expect(summary.codesApplied).toBe(0)
    expect(summary.formatLabel).toBeNull()
  })

  it('says so when the chart carries no momskoder at all', () => {
    const { mappings, warnings } = applySourceChartCsv(
      [mapping('3051', 'Test')],
      csv('True;3051;Test;', 'True;3052;Test 2;'),
    )
    expect(mappings[0].providerVatCode).toBeUndefined()
    expect(warnings).toContain('Kontoplanen innehöll inga momskoder.')
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
    expect(second.warnings[0]).toContain('känns inte igen')
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
