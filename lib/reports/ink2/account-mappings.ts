/**
 * BAS-to-SRU account mappings for INK2R (räkenskapsschema).
 *
 * Ranges follow the official BAS kopplingstabell (official-ink2r-coupling.json,
 * bas.se INK2_P1_intervall-241119.xlsx); a test pins every 4-digit number to
 * it. Extensions beyond the official file are commented on the post.
 *
 * Pure data, no runtime imports: this module is shared by the INK2 engine
 * (filing) and by lib/bookkeeping/bas-data/sru-mapping.ts (the sru_code shown
 * in the chart of accounts, seeded on new accounts and written to SIE #SRU),
 * so the two can never disagree about which field an account lands in.
 */
import type { INK2AccountMapping } from './types'

/**
 * BAS-to-SRU account mappings for INK2R
 * Source: bas.se/kontoplaner/sru/ (stable since 2017)
 */
export const INK2R_ACCOUNT_MAPPINGS: INK2AccountMapping[] = [
  // ---- Balance sheet: Assets ----
  {
    sruCode: '7201',
    description: 'Koncessioner, patent, licenser, varumärken, goodwill',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1000', end: '1087' },
      { start: '1089', end: '1099' },
    ],
  },
  {
    sruCode: '7202',
    description: 'Förskott immateriella anläggningstillgångar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1088', end: '1088' },
    ],
  },
  {
    sruCode: '7214',
    description: 'Byggnader och mark',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1100', end: '1119' },
      { start: '1130', end: '1179' },
      { start: '1190', end: '1199' },
    ],
  },
  {
    sruCode: '7215',
    description: 'Maskiner, inventarier, övriga materiella',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1200', end: '1279' },
      { start: '1290', end: '1299' },
    ],
  },
  {
    sruCode: '7216',
    description: 'Förbättringsutgifter på annans fastighet',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1120', end: '1129' },
    ],
  },
  {
    sruCode: '7217',
    description: 'Pågående nyanläggningar, förskott materiella',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1180', end: '1189' },
      { start: '1280', end: '1289' },
    ],
  },
  {
    sruCode: '7230',
    description: 'Andelar i koncernföretag',
    section: 'assets',
    normalBalance: 'debit',
    // 1310 (group account) and 1317/1318 (foreign subsidiaries, nedskrivningar)
    // belong to the same post; they were dropped from the form until 2026-09.
    accountRanges: [
      { start: '1310', end: '1319' },
    ],
  },
  {
    sruCode: '7231',
    description: 'Andelar i intresseföretag',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1330', end: '1335' },
      { start: '1338', end: '1339' },
    ],
  },
  {
    sruCode: '7233',
    description: 'Ägarintressen övriga företag + långfristiga värdepapper',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1336', end: '1337' },
      { start: '1350', end: '1359' },
    ],
  },
  {
    sruCode: '7232',
    description: 'Fordringar koncern/intresse',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1320', end: '1329' },
      { start: '1340', end: '1345' },
      { start: '1348', end: '1349' },
    ],
  },
  {
    sruCode: '7234',
    description: 'Lån till delägare eller närstående',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1360', end: '1369' },
    ],
  },
  {
    sruCode: '7235',
    description: 'Övriga långfristiga fordringar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1346', end: '1347' },
      { start: '1370', end: '1389' },
    ],
  },
  {
    sruCode: '7241',
    description: 'Råvaror och förnödenheter',
    section: 'assets',
    normalBalance: 'debit',
    // 1420-1429 (tillsatsmaterial och förnödenheter) is the same K2 post as
    // 1410-1419 (råvaror); it was dropped from the form until 2026-09.
    accountRanges: [
      { start: '1410', end: '1429' },
    ],
  },
  {
    sruCode: '7242',
    description: 'Varor under tillverkning',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1440', end: '1449' },
    ],
  },
  {
    sruCode: '7243',
    description: 'Färdiga varor och handelsvaror',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1450', end: '1469' },
    ],
  },
  {
    sruCode: '7244',
    description: 'Övriga lagertillgångar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1490', end: '1499' },
    ],
  },
  {
    sruCode: '7245',
    description: 'Pågående arbeten för annans räkning',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1470', end: '1479' },
    ],
  },
  {
    sruCode: '7246',
    description: 'Förskott till leverantörer',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1480', end: '1489' },
    ],
  },
  {
    sruCode: '7251',
    description: 'Kundfordringar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1510', end: '1559' },
      { start: '1580', end: '1589' },
    ],
  },
  {
    sruCode: '7252',
    description: 'Fordringar koncern/intresse (kortfristiga)',
    section: 'assets',
    normalBalance: 'debit',
    // 1670 (group account) is not on the official table; kept with its 167x children.
    accountRanges: [
      { start: '1560', end: '1572' },
      { start: '1574', end: '1579' },
      { start: '1660', end: '1672' },
      { start: '1674', end: '1679' },
    ],
  },
  {
    sruCode: '7261',
    description: 'Övriga fordringar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1573', end: '1573' },
      { start: '1610', end: '1619' },
      { start: '1630', end: '1659' },
      { start: '1673', end: '1673' },
      { start: '1680', end: '1699' },
    ],
  },
  {
    sruCode: '7262',
    description: 'Upparbetad men ej fakturerad intäkt',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1620', end: '1629' },
    ],
  },
  {
    sruCode: '7263',
    description: 'Förutbetalda kostnader och upplupna intäkter',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1700', end: '1799' },
    ],
  },
  {
    sruCode: '7270',
    description: 'Andelar i koncernföretag (kortfristiga)',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1860', end: '1869' },
    ],
  },
  {
    sruCode: '7271',
    description: 'Övriga kortfristiga placeringar',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1800', end: '1859' },
      { start: '1870', end: '1899' },
    ],
  },
  {
    sruCode: '7281',
    description: 'Kassa, bank och redovisningsmedel',
    section: 'assets',
    normalBalance: 'debit',
    accountRanges: [
      { start: '1900', end: '1999' },
    ],
  },

  // ---- Balance sheet: Equity & Liabilities ----
  {
    sruCode: '7301',
    description: 'Bundet eget kapital',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    // 2010-2079 (enskild firma / handelsbolag equity) are not on the aktiebolag table; kept so mixed charts still classify.
    accountRanges: [
      { start: '2010', end: '2089' },
    ],
  },
  {
    sruCode: '7302',
    description: 'Fritt eget kapital',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2090', end: '2099' },
    ],
  },
  {
    sruCode: '7321',
    description: 'Periodiseringsfonder',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2110', end: '2139' },
    ],
  },
  {
    sruCode: '7322',
    description: 'Ackumulerade överavskrivningar',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2150', end: '2159' },
    ],
  },
  {
    sruCode: '7323',
    description: 'Övriga obeskattade reserver',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2160', end: '2199' },
    ],
  },
  {
    sruCode: '7331',
    description: 'Pensionsavsättningar tryggandelagen',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2210', end: '2219' },
    ],
  },
  {
    sruCode: '7332',
    description: 'Övriga pensionsavsättningar',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2230', end: '2239' },
    ],
  },
  {
    sruCode: '7333',
    description: 'Övriga avsättningar',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2220', end: '2229' },
      { start: '2240', end: '2299' },
    ],
  },
  {
    sruCode: '7350',
    description: 'Obligationslån',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2310', end: '2329' },
    ],
  },
  {
    sruCode: '7351',
    description: 'Checkräkningskredit (långfristig)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2330', end: '2339' },
    ],
  },
  {
    sruCode: '7352',
    description: 'Övriga skulder kreditinstitut (långfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2340', end: '2359' },
    ],
  },
  {
    sruCode: '7353',
    description: 'Skulder koncern/intresse (långfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2360', end: '2372' },
      { start: '2374', end: '2379' },
    ],
  },
  {
    sruCode: '7354',
    description: 'Övriga skulder (långfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2373', end: '2373' },
      { start: '2380', end: '2399' },
    ],
  },
  {
    sruCode: '7360',
    description: 'Checkräkningskredit (kortfristig)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2480', end: '2489' },
    ],
  },
  {
    sruCode: '7361',
    description: 'Övriga skulder kreditinstitut (kortfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2410', end: '2419' },
    ],
  },
  {
    sruCode: '7362',
    description: 'Förskott från kunder',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2420', end: '2429' },
    ],
  },
  {
    sruCode: '7363',
    description: 'Pågående arbeten (skuldsida)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2430', end: '2439' },
    ],
  },
  {
    sruCode: '7364',
    description: 'Fakturerad men ej upparbetad intäkt',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2450', end: '2459' },
    ],
  },
  {
    sruCode: '7365',
    description: 'Leverantörsskulder',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2440', end: '2449' },
    ],
  },
  {
    sruCode: '7366',
    description: 'Växelskulder',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2492', end: '2492' },
    ],
  },
  {
    sruCode: '7367',
    description: 'Skulder koncern/intresse (kortfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    // 2473 and 2860-2873 (skulder till koncern-/intresseföretag) are not on the official table; kept with their siblings.
    accountRanges: [
      { start: '2460', end: '2479' },
      { start: '2860', end: '2879' },
    ],
  },
  {
    sruCode: '7369',
    description: 'Övriga skulder (kortfristiga)',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2490', end: '2491' },
      { start: '2493', end: '2499' },
      { start: '2600', end: '2859' },
      { start: '2880', end: '2899' },
    ],
  },
  {
    sruCode: '7368',
    description: 'Skatteskulder',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2500', end: '2599' },
    ],
  },
  {
    sruCode: '7370',
    description: 'Upplupna kostnader och förutbetalda intäkter',
    section: 'equity_liabilities',
    normalBalance: 'credit',
    accountRanges: [
      { start: '2900', end: '2999' },
    ],
  },

  // ---- Income statement ----
  {
    sruCode: '7410',
    description: 'Nettoomsättning',
    section: 'income_statement',
    normalBalance: 'credit',
    accountRanges: [
      { start: '3000', end: '3799' },
    ],
  },
  {
    sruCode: '7412',
    description: 'Aktiverat arbete för egen räkning',
    section: 'income_statement',
    normalBalance: 'credit',
    accountRanges: [
      { start: '3800', end: '3899' },
    ],
  },
  {
    sruCode: '7413',
    description: 'Övriga rörelseintäkter',
    section: 'income_statement',
    normalBalance: 'credit',
    accountRanges: [
      { start: '3900', end: '3999' },
    ],
  },
  {
    sruCode: '7411',
    description: 'Förändring av lager',
    section: 'income_statement',
    normalBalance: 'net',
    accountRanges: [
      { start: '4900', end: '4909' },
      { start: '4930', end: '4959' },
      { start: '4970', end: '4979' },
      { start: '4990', end: '4999' },
    ],
  },
  {
    sruCode: '7511',
    description: 'Råvaror och förnödenheter',
    section: 'income_statement',
    normalBalance: 'debit',
    // 48xx (fri kontogrupp) is not on the official table; kept as råvaror. 40xx-47xx is listed under both 7511 and 7512: the split (46xx = handelsvaror) is ours.
    accountRanges: [
      { start: '4000', end: '4599' },
      { start: '4700', end: '4899' },
      { start: '4910', end: '4920' },
    ],
  },
  {
    sruCode: '7512',
    description: 'Handelsvaror',
    section: 'income_statement',
    normalBalance: 'debit',
    // Official: 40xx-47xx (shared with 7511), 496x, 498x. 46xx is our split.
    accountRanges: [
      { start: '4600', end: '4699' },
      { start: '4960', end: '4969' },
      { start: '4980', end: '4989' },
    ],
  },
  // CRITICAL: BAS 5000-6999 ALL map to SRU 7513
  {
    sruCode: '7513',
    description: 'Övriga externa kostnader',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '5000', end: '6999' },
    ],
  },
  {
    sruCode: '7514',
    description: 'Personalkostnader',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '7000', end: '7699' },
    ],
  },
  {
    sruCode: '7515',
    description: 'Av- och nedskrivningar materiella/immateriella',
    section: 'income_statement',
    normalBalance: 'debit',
    // Official BAS kopplingstabell for INK2R 3.9: 7700-7739, 7750-7789,
    // 7800-7899 (nedskrivningar of anläggningstillgångar + återföringar);
    // only 774x/779x belong on 3.10. Mirrors K2_RR_MAPPINGS in
    // lib/bokslut/ixbrl/k2-mapper.ts.
    accountRanges: [
      { start: '7700', end: '7739' },
      { start: '7750', end: '7789' },
      { start: '7800', end: '7899' },
    ],
  },
  {
    sruCode: '7516',
    description: 'Nedskrivningar omsättningstillgångar',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '7740', end: '7749' },
      { start: '7790', end: '7799' },
    ],
  },
  {
    sruCode: '7517',
    description: 'Övriga rörelsekostnader',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '7900', end: '7999' },
    ],
  },
  {
    sruCode: '7414',
    description: 'Resultat från andelar i koncernföretag',
    section: 'income_statement',
    normalBalance: 'net',
    accountRanges: [
      { start: '8000', end: '8069' },
      { start: '8090', end: '8099' },
    ],
  },
  {
    sruCode: '7415',
    description: 'Resultat från andelar i intresseföretag',
    section: 'income_statement',
    normalBalance: 'net',
    accountRanges: [
      { start: '8100', end: '8112' },
      { start: '8114', end: '8117' },
      { start: '8119', end: '8122' },
      { start: '8124', end: '8132' },
      { start: '8134', end: '8169' },
      { start: '8190', end: '8199' },
    ],
  },
  {
    sruCode: '7423',
    description: 'Resultat från övriga företag med ägarintresse',
    section: 'income_statement',
    normalBalance: 'net',
    accountRanges: [
      { start: '8113', end: '8113' },
      { start: '8118', end: '8118' },
      { start: '8123', end: '8123' },
      { start: '8133', end: '8133' },
    ],
  },
  {
    sruCode: '7416',
    description: 'Resultat från övriga finansiella anläggningstillgångar',
    section: 'income_statement',
    normalBalance: 'net',
    accountRanges: [
      { start: '8200', end: '8269' },
      { start: '8290', end: '8299' },
    ],
  },
  {
    sruCode: '7417',
    description: 'Övriga ränteintäkter och liknande',
    section: 'income_statement',
    normalBalance: 'credit',
    accountRanges: [
      { start: '8300', end: '8369' },
      { start: '8390', end: '8399' },
    ],
  },
  {
    sruCode: '7522',
    description: 'Räntekostnader och liknande',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '8400', end: '8499' },
    ],
  },
  {
    sruCode: '7521',
    description: 'Nedskrivningar finansiella anläggningstillgångar',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '8070', end: '8089' },
      { start: '8170', end: '8189' },
      { start: '8270', end: '8289' },
      { start: '8370', end: '8389' },
    ],
  },
  // Bokslutsdispositioner: account numbers per BAS 2020 (verified against
  // lib/bookkeeping/bas-data/class-8-financial.ts).
  {
    sruCode: '7525',
    description: 'Avsättning till periodiseringsfond',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '8811', end: '8811' },
    ],
  },
  {
    sruCode: '7420',
    description: 'Återföring av periodiseringsfond',
    section: 'income_statement',
    normalBalance: 'credit',
    // 8810 (group account) goes to 7420 when the net is a credit and to 7525 when it is a debit; see the twin handling in ink2-engine.ts.
    accountRanges: [
      { start: '8810', end: '8810' },
      { start: '8819', end: '8819' },
    ],
  },
  {
    sruCode: '7419',
    description: 'Mottagna koncernbidrag',
    section: 'income_statement',
    normalBalance: 'credit',
    accountRanges: [
      { start: '8820', end: '8829' },
    ],
  },
  {
    sruCode: '7524',
    description: 'Lämnade koncernbidrag',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '8830', end: '8839' },
    ],
  },
  {
    sruCode: '7421',
    description: 'Förändring av överavskrivningar',
    section: 'income_statement',
    normalBalance: 'net',
    // 8850 = grupp, 8851-8853 = per kategori (immateriella, byggnader, M&I)
    accountRanges: [
      { start: '8850', end: '8859' },
    ],
  },
  {
    sruCode: '7422',
    description: 'Övriga bokslutsdispositioner',
    section: 'income_statement',
    normalBalance: 'net',
    // 8840 = Lämnade gottgörelser, 8860-8899 = övriga
    // 884x (lämnade gottgörelser) is listed only on the negative twin 7527; it sits here and the twin handling moves a debit net there.
    accountRanges: [
      { start: '8840', end: '8849' },
      { start: '8860', end: '8899' },
    ],
  },
  {
    sruCode: '7528',
    description: 'Skatt på årets resultat',
    section: 'income_statement',
    normalBalance: 'debit',
    accountRanges: [
      { start: '8900', end: '8989' },
    ],
  },
  // 7450/7550 (årets resultat vinst/förlust) are calculated, not mapped from accounts
]

/**
 * Check if an account number falls within a mapping's ranges
 */
export function isAccountInMapping(accountNumber: string, mapping: INK2AccountMapping): boolean {
  for (const range of mapping.accountRanges) {
    if (accountNumber >= range.start && accountNumber <= range.end) {
      if (range.exclude && range.exclude.includes(accountNumber)) {
        continue
      }
      return true
    }
  }
  return false
}
