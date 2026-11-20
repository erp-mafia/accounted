import { describe, expect, it } from 'vitest'
import {
  defaultRateForVatTreatment,
  isVatTreatmentAllowedForAccountClass,
  NOT_DOMESTIC_SALE,
  resolveVatTreatmentRuta,
  suggestVatTreatment,
  vatRateFromLabel,
  vatTreatmentsForAccountClass,
} from '../account-vat-treatment'
import { inferDomesticSalesRate } from '@/lib/reports/vat-revenue-accounts'
import { CLASS_4_ACCOUNTS } from '@/lib/bookkeeping/bas-data/class-4-purchases'

// One veto: the import suggestion and the declaration's inference used to hold
// a list each, and each missed words the other had.
describe('a label that says a class 3 account is no domestic taxable sale', () => {
  it.each([
    'Försäljning undantag 25 % moms',
    'Försäljning momsbefriad 25 % moms',
    'Försäljning ej moms 25 % moms',
    'Försäljning eu-land 25 % moms',
    'Försäljning momsfri 25 % moms',
    'Försäljning export 25 % moms',
    'Försäljning 0 % 25 % moms',
    'FÖRSÄLJNING UNDANTAG 25 % MOMS',
  ])('%s vetoes the rate on both doors', (label) => {
    expect(NOT_DOMESTIC_SALE.test(label)).toBe(true)
    expect(inferDomesticSalesRate('3041', label)).toBeNull()
    expect(suggestVatTreatment('3041', label)?.treatment).not.toBe('standard_25')
  })

  it('a plain taxable label keeps its rate on both doors', () => {
    expect(inferDomesticSalesRate('3041', 'Försäljning tjänster 25 % moms')).toBe(0.25)
    expect(suggestVatTreatment('3041', 'Försäljning tjänster 25 % moms')).toEqual({ treatment: 'standard_25', rate: 0.25 })
  })

  it('a decimal that ends in 0 % is no zero rate', () => {
    expect(NOT_DOMESTIC_SALE.test('Försäljning 1,0 % avgift 25 % moms')).toBe(false)
  })
})

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

  it('keeps OSS revenue off the declaration and offers it only for revenue accounts', () => {
    // Unionsordningen: declared in the OSS declaration, never in a ruta.
    expect(resolveVatTreatmentRuta('oss', 3)).toBeNull()
    expect(resolveVatTreatmentRuta('oss', 4)).toBeNull()
    expect(vatTreatmentsForAccountClass(3)).toContain('oss')
    expect(vatTreatmentsForAccountClass(3)).not.toContain('reverse_charge_non_eu_services')
    expect(vatTreatmentsForAccountClass(4)).not.toContain('oss')
    expect(defaultRateForVatTreatment('oss', 3)).toBeNull()
  })
})

describe('omvänd betalningsskyldighet inom Sverige on the BAS group 44 accounts (crm#1754)', () => {
  // BAS 2026 names what each account buys, and that decides the ruta:
  // råvaror och material file ruta 23, tjänster file ruta 24. Read from the
  // repo's BAS data rather than a hand-kept list, so a renamed or added group
  // 44 account is checked too. 4400 is the group account for both and is
  // left out.
  const group44 = CLASS_4_ACCOUNTS.filter(
    (a) => a.account_group === '44' && a.account_number !== '4400',
  )

  it('covers the varor and tjänster accounts, with and without a stated sats', () => {
    expect(group44.map((a) => a.account_number)).toEqual(
      ['4410', '4415', '4416', '4417', '4420', '4425', '4426', '4427'],
    )
  })

  it.each(group44.map((a) => [a.account_number, a.account_name] as const))(
    '%s %s files the ruta its BAS name gives',
    (account, name) => {
      const box = /tjänster/.test(name) ? 'ruta24' : 'ruta23'
      expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4, account)).toEqual({ box, side: 'debit' })
    },
  )

  it('files 4420 in ruta 24, where its SIE label suggestion now lands too', () => {
    expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4, '4420')).toEqual({ box: 'ruta24', side: 'debit' })
    const suggested = suggestVatTreatment('4420', 'Inköp av tjänster i Sverige, omvänd betalningsskyldighet')
    expect(suggested).toEqual({ treatment: 'reverse_charge_domestic', rate: 0.25 })
    expect(resolveVatTreatmentRuta(suggested!.treatment, 4, '4420')?.box).toBe('ruta24')
  })

  it('leaves the group account and numbers outside BAS on the varor default', () => {
    for (const account of ['4400', '4421', '4428', '4429']) {
      expect(resolveVatTreatmentRuta('reverse_charge_domestic', 4, account)?.box).toBe('ruta23')
    }
  })
})

describe('momsfria EU-inköp', () => {
  it('declines a momsfri EU purchase rather than inventing a reverse charge', () => {
    // BAS 4518 exists beside 4515 to 4517 and is deliberately absent from
    // ACCOUNT_RUTA: an exempt acquisition is not self-assessed, so there is
    // nothing to declare. Visma eEkonomi says the same by leaving the code
    // blank on its equivalent account. Without the rule the label reads EU
    // and varor, answers reverse charge, and defaults to 25 % because the
    // name states no percentage.
    expect(suggestVatTreatment('4059', 'Inköp varor EG momsfri')).toBeNull()
    expect(suggestVatTreatment('4518', 'Inköp av råvaror och material från annat EU-land momsfri')).toBeNull()
  })

  it('still reads the taxable EU purchases beside it', () => {
    expect(suggestVatTreatment('4056', 'Inköp varor 25% EG'))
      .toEqual({ treatment: 'reverse_charge_eu_goods', rate: 0.25 })
    expect(suggestVatTreatment('4057', 'Inköp varor 12% EG'))
      .toEqual({ treatment: 'reverse_charge_eu_goods', rate: 0.12 })
  })

  it('leaves the sales side alone, where momsfri EU goods ARE ruta 35', () => {
    // The asymmetry is in the tax, not the code: a momsfri supply is a
    // zero-rated intra-EU supply and belongs in ruta 35, while a momsfri
    // acquisition belongs nowhere.
    expect(suggestVatTreatment('3058', 'Försäljn varor EG momsfri'))
      .toEqual({ treatment: 'reverse_charge_eu_goods', rate: 0 })
  })
})

describe('trepartshandel', () => {
  it('files the middleman on both sides of the trade', () => {
    expect(resolveVatTreatmentRuta('triangulation_eu_goods', 3)).toEqual({ box: 'ruta38', side: 'credit' })
    expect(resolveVatTreatmentRuta('triangulation_eu_goods', 4)).toEqual({ box: 'ruta37', side: 'debit' })
  })

  it('carries no rate on either side, purchases included', () => {
    // The purchase side is the one that can go wrong: the fall-through for
    // reverse charge answers 0.25 on classes 4 to 6, and a middleman does not
    // self-assess acquisition VAT at all. The scheme exists precisely so the
    // tax is accounted for by the final buyer in the destination country.
    expect(defaultRateForVatTreatment('triangulation_eu_goods', 3)).toBe(0)
    expect(defaultRateForVatTreatment('triangulation_eu_goods', 4)).toBe(0)
    expect(defaultRateForVatTreatment('triangulation_eu_goods', 5)).toBe(0)
  })

  it('reads a Treparts label without taking the rate the name states', () => {
    // "Treparts försäljn varor till EG 25%" names 25 %, and the purchase-side
    // twin in the same chart names none. The percentage is a goods category in
    // that naming scheme, not a sats, and the trade carries neither.
    expect(suggestVatTreatment('3057', 'Treparts försäljn varor till EG 25%'))
      .toEqual({ treatment: 'triangulation_eu_goods', rate: 0 })
    expect(suggestVatTreatment('4055', 'Trepartsförv varor fr EG'))
      .toEqual({ treatment: 'triangulation_eu_goods', rate: 0 })
  })
})

describe('momspliktiga uttag och importunderlag', () => {
  it('files each on its own box, by account class', () => {
    expect(resolveVatTreatmentRuta('own_use', 3)).toEqual({ box: 'ruta06', side: 'credit' })
    expect(resolveVatTreatmentRuta('import_goods', 4)).toEqual({ box: 'ruta50', side: 'debit' })
  })

  it('refuses each on the other side of the ledger', () => {
    // ruta 06 is revenue and ruta 50 a cost-side basis; neither box can be
    // filled from the wrong class, which is what the dropdown reads too.
    expect(resolveVatTreatmentRuta('own_use', 4)).toBeNull()
    expect(isVatTreatmentAllowedForAccountClass('import_goods', 3)).toBe(false)
    expect(isVatTreatmentAllowedForAccountClass('own_use', 3)).toBe(true)
    expect(isVatTreatmentAllowedForAccountClass('import_goods', 4)).toBe(true)
  })

  it('starts at 25 %, because the box covers three rates', () => {
    // Unlike ruta 05, which spends a treatment per sats, one box here carries
    // 25, 12 and 6 %. The label or a source chart code moves it.
    expect(defaultRateForVatTreatment('own_use', 3)).toBe(0.25)
    expect(defaultRateForVatTreatment('import_goods', 4)).toBe(0.25)
  })

  it('reads an uttag label, and the rate it names', () => {
    expect(suggestVatTreatment('3401', 'Försäljning/uttag av varor 25 %'))
      .toEqual({ treatment: 'own_use', rate: 0.25 })
    expect(suggestVatTreatment('3910', 'Egna uttag av tjänster 12 %'))
      .toEqual({ treatment: 'own_use', rate: 0.12 })
  })

  it('keeps momsfria uttag in ruta 42, where BAS 3404 puts them', () => {
    // The uttag rule sits after the momsfri rule on purpose: an exempt
    // withdrawal is not a taxable one and does not belong in ruta 06.
    expect(suggestVatTreatment('3404', 'Momsfria uttag'))
      .toEqual({ treatment: 'exempt', rate: 0 })
  })

  it('never reads a motkonto as the basis it counters', () => {
    // Found in a real migration: "Motkonto beskattningsunderlag import" took
    // import_goods from the rule meant for 4545, so the counter-account would
    // have joined ruta 50 on the debit side and subtracted its own credit from
    // the box the basis was filling. BAS says the same about its own
    // equivalent, 4598, which nets the basis out of the income statement while
    // the 45xx accounts carry it to ruta 20-24.
    expect(suggestVatTreatment('4549', 'Motkonto beskattningsunderlag import')).toBeNull()
    expect(suggestVatTreatment('4598', 'Motkonto beräknad omvänd moms')).toBeNull()
    // The account it counters still reads as the basis.
    expect(suggestVatTreatment('4545', 'Beskattningsunderlag vid import 25 %'))
      .toEqual({ treatment: 'import_goods', rate: 0.25 })
  })

  it('reads an import BASIS label but still declines a plain import cost account', () => {
    // The distinction the box turns on: ruta 50 is tullvärde plus tullar plus
    // bikostnader, booked on its own account. An account that merely buys
    // imported goods holds what the supplier invoiced, and routing that to
    // ruta 50 would overstate the basis.
    expect(suggestVatTreatment('4540', 'Beskattningsunderlag vid import 25 %'))
      .toEqual({ treatment: 'import_goods', rate: 0.25 })
    expect(suggestVatTreatment('4049', 'Inköp varor import')).toBeNull()
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

  it('recognises OSS labels and leaves momspliktig EU-försäljning for review', () => {
    // Fortnox has no OSS accounts in its base chart; users name their own
    // per country and rate ("Försäljning enl. OSS (Spanien 21%)").
    expect(suggestVatTreatment('3111', 'Försäljning enl. OSS (Spanien 21%)')).toEqual({
      treatment: 'oss', rate: null,
    })
    expect(suggestVatTreatment('3112', 'Försäljning varor unionsordningen Tyskland')).toEqual({
      treatment: 'oss', rate: null,
    })
    // BAS 3106 is Swedish moms below the OSS threshold or OSS above it; a
    // ruta 35 (momsfri EU-leverans) suggestion is wrong either way.
    expect(suggestVatTreatment('3106', 'Försäljning varor till annat EU-land, momspliktig')).toBeNull()
  })

  it('does not match EU inside an unrelated word', () => {
    expect(suggestVatTreatment('4010', 'Reumatologiska varor')).toBeNull()
  })

  // "EG" (Europeiska gemenskapen) is the pre-Lisbon name for the union. Charts
  // predating the 2009 rename kept it, and one chart carries both spellings:
  // the file this came from (ex-Visma eEkonomi, company created 2021) says
  // "till annat EU-land" on 3109/3309 and "EG" on 3041-3058 and 4056-4059.
  // Every row below read as momsfri ruta 42 or fell through to no suggestion.
  it('reads EG labels as the union, exactly like their EU spelling', () => {
    expect(suggestVatTreatment('3048', 'Försäljn tjänst EG momsfri')).toEqual({
      treatment: 'reverse_charge_eu_services', rate: 0,
    })
    expect(suggestVatTreatment('3058', 'Försäljn varor EG momsfri')).toEqual({
      treatment: 'reverse_charge_eu_goods', rate: 0,
    })
    expect(suggestVatTreatment('4056', 'Inköp varor 25% EG')).toEqual({
      treatment: 'reverse_charge_eu_goods', rate: 0.25,
    })
    expect(suggestVatTreatment('4058', 'Inköp varor EG 6%')).toEqual({
      treatment: 'reverse_charge_eu_goods', rate: 0.06,
    })
  })

  it('checks outside-EG labels before the generic union matcher', () => {
    expect(suggestVatTreatment('3045', 'Försäljn tjänst utanför EG momsfri')).toEqual({
      treatment: 'export_services', rate: 0,
    })
    expect(suggestVatTreatment('3055', 'Försäljn varor utanför EG momsfri')).toEqual({
      treatment: 'export_goods', rate: 0,
    })
    // Purchases of goods from outside the union are an import, which has no
    // supported purchase treatment: the EG spelling must not fall through to
    // the intra-union goods branch below it.
    expect(suggestVatTreatment('4545', 'Import varor utanför EG 25%')).toBeNull()
  })

  it('does not match EG inside an unrelated word or a wider place name', () => {
    expect(suggestVatTreatment('4010', 'Egna uttag av varor')).toBeNull()
    expect(suggestVatTreatment('5410', 'Förbrukningsinventarier, regionala')).toBeNull()
    // "utanför Europa" is not "utanför EU": without the word boundary this
    // read as an export and zero-rated the row.
    expect(suggestVatTreatment('3055', 'Försäljning varor utanför Europa')).toBeNull()
  })

  it('keeps VMB without a generic booking rate', () => {
    expect(suggestVatTreatment('3211', 'Försäljning VMB')).toEqual({
      treatment: 'vmb', rate: null,
    })
    expect(defaultRateForVatTreatment('vmb', 3)).toBeNull()
  })
})

// crm#1146: a custom account named "... (ej EU)" missed the outside-union
// matcher, hit the union matcher on the bare word and was suggested as an EU
// reverse charge (ruta 21) when the label says the opposite (ruta 22).
describe('a negated union name reads as outside the union', () => {
  const NON_EU_SERVICES = { treatment: 'reverse_charge_non_eu_services', rate: 0.25 }

  it.each([
    ['6541', 'IT-tjänster utlandet (ej EU)'],
    ['6542', 'Inköp tjänster ej EU'],
    ['6543', 'Inköp tjänster inte EU'],
    ['6544', 'Inköp tjänster icke EU'],
    ['6545', 'Inköp tjänster icke-EU'],
    ['6546', 'Inköp tjänster utom EU'],
    ['6547', 'Inköp tjänster exkl EU'],
    ['6548', 'Inköp tjänster exkl. EU'],
    ['6549', 'Inköp tjänster exklusive EU'],
    ['4531', 'Inköp tjänster non-EU'],
    ['4532', 'Inköp tjänster (ej EG)'],
    ['4533', 'Inköp tjänster icke-EG'],
    ['5611', 'Tjänster utlandet, EJ EU-land'],
  ])('purchase of services %s "%s" is ruta 22, not ruta 21', (accountNumber, accountName) => {
    expect(suggestVatTreatment(accountNumber, accountName)).toEqual(NON_EU_SERVICES)
  })

  it('still takes the rate the label names', () => {
    expect(suggestVatTreatment('6541', 'IT-tjänster utlandet (ej EU) 12%')).toEqual({
      treatment: 'reverse_charge_non_eu_services', rate: 0.12,
    })
  })

  // Goods from outside the union are an import, which has no supported
  // purchase treatment: the row is left for review, exactly like its
  // "utanför EU" spelling, instead of falling through to ruta 20.
  it.each([
    ['4541', 'Inköp varor utlandet (ej EU)'],
    ['4542', 'Inköp varor icke-EU 25%'],
    ['4543', 'Inköp varor exkl. EG'],
    ['4544', 'Inköp varor utom EU'],
  ])('purchase of goods %s "%s" is not an EU acquisition', (accountNumber, accountName) => {
    expect(suggestVatTreatment(accountNumber, accountName)).toBeNull()
  })

  it.each([
    ['3055', 'Försäljning varor (ej EU)', 'export_goods'],
    ['3056', 'Försäljn varor icke-EG momsfri', 'export_goods'],
    ['3057', 'Försäljning varor utom EU', 'export_goods'],
    ['3045', 'Försäljning tjänster ej EU', 'export_services'],
    ['3046', 'Försäljn tjänst exkl. EG momsfri', 'export_services'],
    ['3047', 'Försäljning tjänster inte EU 25%', 'export_services'],
  ])('sale %s "%s" is %s, not an EU supply', (accountNumber, accountName, treatment) => {
    expect(suggestVatTreatment(accountNumber, accountName)).toEqual({ treatment, rate: 0 })
  })

  // The negation has to sit directly in front of the union word. Every label
  // here carries both a negation and the union name, and none of them says
  // the trade is outside the union.
  it.each([
    ['6540', 'IT-tjänster EU, ej avdragsgill moms', 'reverse_charge_eu_services'],
    ['4535', 'Ej avdragsgill moms, inköp tjänster EU', 'reverse_charge_eu_services'],
    ['4536', 'Inköp tjänster EU (ej Sverige)', 'reverse_charge_eu_services'],
    ['4537', 'Inköp tjänster inom EU, inte Norge', 'reverse_charge_eu_services'],
    ['4515', 'Inköp varor EU exkl moms', 'reverse_charge_eu_goods'],
    ['4516', 'Inköp varor exkl. frakt EU', 'reverse_charge_eu_goods'],
    ['4517', 'Inköp varor Canon EU', 'reverse_charge_eu_goods'],
    // The moms is what is excluded here, not the union.
    ['4538', 'Inköp tjänster exkl. EU-moms', 'reverse_charge_eu_services'],
    ['4539', 'Inköp tjänster ej EU-moms', 'reverse_charge_eu_services'],
  ])('purchase %s "%s" stays %s', (accountNumber, accountName, treatment) => {
    expect(suggestVatTreatment(accountNumber, accountName)).toEqual({ treatment, rate: 0.25 })
  })

  it.each([
    ['3308', 'Försäljning tjänster EU, ej momspliktig', 'reverse_charge_eu_services'],
    ['3108', 'Försäljning varor EU exkl frakt', 'reverse_charge_eu_goods'],
  ])('sale %s "%s" stays %s', (accountNumber, accountName, treatment) => {
    expect(suggestVatTreatment(accountNumber, accountName)).toEqual({ treatment, rate: 0 })
  })

  it('does not read a negated wider place name as outside the union', () => {
    // Same word boundary that keeps "utanför Europa" out.
    expect(suggestVatTreatment('3055', 'Försäljning varor (ej Europa)')).toBeNull()
    expect(suggestVatTreatment('6541', 'Inköp tjänster icke-europeiska')).toBeNull()
  })
})

describe('a label that names a Swedish sats', () => {
  it('reads a fee account with a rate as a domestic sale at that rate', () => {
    // Company-numbered 35xx accounts: in no static ruta map, so without a
    // suggestion the basis reached no ruta while the moms still did.
    expect(suggestVatTreatment('3543', 'Faktureringavgift 12%')).toEqual({
      treatment: 'reduced_12', rate: 0.12,
    })
    expect(suggestVatTreatment('3544', 'Faktureringavgift 6%')).toEqual({
      treatment: 'reduced_6', rate: 0.06,
    })
    expect(suggestVatTreatment('3545', 'Fakturerade frakter 25 %')).toEqual({
      treatment: 'standard_25', rate: 0.25,
    })
  })

  it('keeps reading a sales label with a spaced rate', () => {
    expect(suggestVatTreatment('3002', 'Försäljning 12 %')).toEqual({
      treatment: 'reduced_12', rate: 0.12,
    })
  })

  it('accepts procent and a trailing moms', () => {
    expect(suggestVatTreatment('3590', 'Övriga intäkter 25 procent moms')).toEqual({
      treatment: 'standard_25', rate: 0.25,
    })
    expect(suggestVatTreatment('3591', 'Serviceavgift 6% moms')).toEqual({
      treatment: 'reduced_6', rate: 0.06,
    })
  })

  it('lets the exempt, export and reverse-charge rules win over the percentage', () => {
    expect(suggestVatTreatment('3004', 'Momsfri försäljning 25%')).toEqual({
      treatment: 'exempt', rate: 0,
    })
    expect(suggestVatTreatment('3305', 'Försäljning tjänster export 25%')).toEqual({
      treatment: 'export_services', rate: 0,
    })
    expect(suggestVatTreatment('3231', 'Försäljning omvänd moms 25%')).toEqual({
      treatment: 'reverse_charge_domestic', rate: 0,
    })
  })

  it('leaves a rate label with an unresolved non-domestic marker for review', () => {
    expect(suggestVatTreatment('3541', 'Faktureringsavgift EU 25%')).toBeNull()
    expect(suggestVatTreatment('3542', 'Faktureringsavgift export 25%')).toBeNull()
    expect(suggestVatTreatment('3549', 'Faktureringsavgift 0% / 25%')).toBeNull()
  })

  it('leaves a rate label with an exempt wording other than momsfri for review', () => {
    expect(suggestVatTreatment('3009', 'Försäljning undantagen moms 25%')).toBeNull()
    expect(suggestVatTreatment('3990', 'Övr intäkter ej momspliktiga 25%')).toBeNull()
    expect(suggestVatTreatment('3991', 'Intäkter ej moms 12%')).toBeNull()
    expect(suggestVatTreatment('3992', 'Momsbefriad försäljning 6%')).toBeNull()
  })

  it('does not suggest ruta 05 for premises rental with a rate but no frivillig marker', () => {
    // Premises rental carries moms only under frivillig skattskyldighet,
    // which is ruta 08; the frivillig rule handles labels that say so.
    expect(suggestVatTreatment('3911', 'Hyra lokal 25%')).toBeNull()
    expect(suggestVatTreatment('3912', 'Uthyrning lokaler 25%')).toBeNull()
    expect(suggestVatTreatment('3913', 'Frivillig uthyrning lokal 25%')).toEqual({
      treatment: 'rental_voluntary', rate: 0.25,
    })
    // Renting out equipment is an ordinary taxable supply.
    expect(suggestVatTreatment('3914', 'Uthyrning maskiner 25%')).toEqual({
      treatment: 'standard_25', rate: 0.25,
    })
  })

  it('does not guess a purchase treatment from a rate alone', () => {
    // The treatment model has no domestic purchase treatment: a domestic
    // purchase has no base ruta, and its moms reaches ruta 48 via 2641.
    expect(suggestVatTreatment('4010', 'Inköp varor 12%')).toBeNull()
    expect(suggestVatTreatment('5460', 'Förbrukningsmaterial 25 %')).toBeNull()
  })
})

describe('vatRateFromLabel', () => {
  it('reads one sats in any common spelling', () => {
    expect(vatRateFromLabel('Faktureringavgift 12%')).toBe(0.12)
    expect(vatRateFromLabel('Försäljning 6 % moms')).toBe(0.06)
    expect(vatRateFromLabel('Intäkter 25 Procent')).toBe(0.25)
  })

  it('names no sats for a decimal, two rates, or none', () => {
    expect(vatRateFromLabel('Ränta 0,6 %')).toBeNull()
    expect(vatRateFromLabel('Provision 1.25%')).toBeNull()
    expect(vatRateFromLabel('Livsmedel 12% och övrigt 25%')).toBeNull()
    expect(vatRateFromLabel('Faktureringsavgifter')).toBeNull()
    expect(vatRateFromLabel('Försäljning 16%')).toBeNull()
  })
})
