/**
 * BAS trial balance → K2 risbs concept amounts.
 *
 * Maps account-level closing balances (current + previous fiscal year) onto
 * the K2 AB `risbs` uppställningsform (full kostnadsslagsindelad RR + full
 * BR). Account ranges follow BAS 2025/2026 as shipped in
 * lib/bookkeeping/bas-data/ and are cross-checked against the INK2R mappings
 * in lib/reports/ink2/ink2-engine.ts (same ÅRL structure, coarser posts).
 *
 * Sign conventions: every produced amount is oriented to the concept's
 * natural balance: credit-balance concepts are positive when the underlying
 * accounts carry a net credit; debit concepts positive on net debit. The
 * document layer adds presentational minuses for cost rows and `sign="-"`
 * for genuinely deviating values (TA §2.10.6).
 */

import type { ConceptAmount, ConceptAmounts } from './types'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import {
  SIGN_RECLASSIFICATION_RULES,
  type SignReclassificationId,
  type SignReclassificationRule,
} from '@/lib/reports/sign-reclassification'

export interface TrialBalanceRowLike {
  account_number: string
  account_name: string
  closing_debit: number
  closing_credit: number
}

/**
 * Per-year trial balance pair. The year-end closing entry (source_type
 * 'year_end') zeroes every class 3-8 account into 2099, so a single TB can
 * never serve both statements:
 *   - `full` (including the closing entry) carries the booked 2099 and the
 *     correct equity: it drives the BR concepts.
 *   - `preClosing` (generateTrialBalance with excludeFinalClosingEntry: true)
 *     still has the RR accounts open: it drives the RR concepts.
 * Mirrors how lib/reports' generateIncomeStatement/generateBalanceSheet split
 * the same source.
 */
export interface TrialBalancePair {
  full: TrialBalanceRowLike[]
  preClosing: TrialBalanceRowLike[]
}

interface Range {
  start: string
  end: string
}

interface PostMapping {
  concept: string
  /** Orientation of the produced amount. */
  balance: 'debit' | 'credit'
  ranges: Range[]
}

const r = (start: string, end: string): Range => ({ start, end })

/** RR: kostnadsslagsindelad (risbs), in uppställningsform order. */
export const K2_RR_MAPPINGS: PostMapping[] = [
  { concept: 'Nettoomsattning', balance: 'credit', ranges: [r('3000', '3799')] },
  {
    concept: 'ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning',
    balance: 'credit',
    // Lagerförändring for own production + pågående arbeten. Changes in
    // råvarulager (4910-4929) belong to RavarorFornodenheterKostnader and
    // handelsvaror (4960-4969) to HandelsvarorKostnader per K2 RR.
    ranges: [r('4930', '4959'), r('4970', '4999')],
  },
  { concept: 'AktiveratArbeteEgenRakning', balance: 'credit', ranges: [r('3800', '3899')] },
  { concept: 'OvrigaRorelseintakter', balance: 'credit', ranges: [r('3900', '3999')] },
  {
    concept: 'RavarorFornodenheterKostnader',
    balance: 'debit',
    ranges: [r('4000', '4599'), r('4700', '4899'), r('4910', '4929')],
  },
  {
    concept: 'HandelsvarorKostnader',
    balance: 'debit',
    ranges: [r('4600', '4699'), r('4960', '4969')],
  },
  { concept: 'OvrigaExternaKostnader', balance: 'debit', ranges: [r('5000', '6999')] },
  { concept: 'Personalkostnader', balance: 'debit', ranges: [r('7000', '7699')] },
  {
    concept: 'AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar',
    balance: 'debit',
    // 7710-7733 are nedskrivningar of anläggningstillgångar and 7760-7789
    // their återföringar (credit-normal, netted within the line); only
    // 774x/779x concern omsättningstillgångar. Intervals follow the official
    // BAS kopplingstabell for INK2R 3.9/3.10 (fältkod 7515: 7700-7739,
    // 7750-7789, 7800-7899; fältkod 7516: 774x, 779x).
    ranges: [r('7700', '7739'), r('7750', '7789'), r('7800', '7899')],
  },
  {
    concept: 'NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar',
    balance: 'debit',
    ranges: [r('7740', '7749'), r('7790', '7799')],
  },
  { concept: 'OvrigaRorelsekostnader', balance: 'debit', ranges: [r('7900', '7999')] },
  { concept: 'ResultatAndelarKoncernforetag', balance: 'credit', ranges: [r('8000', '8099')] },
  {
    concept: 'ResultatAndelarIntresseforetagGemensamtStyrda',
    balance: 'credit',
    ranges: [r('8100', '8199')],
  },
  {
    concept: 'ResultatOvrigaforetagAgarintresse',
    balance: 'credit',
    ranges: [r('8200', '8269')],
  },
  {
    concept: 'ResultatOvrigaFinansiellaAnlaggningstillgangar',
    balance: 'credit',
    ranges: [r('8270', '8299')],
  },
  {
    concept: 'OvrigaRanteintakterLiknandeResultatposter',
    balance: 'credit',
    ranges: [r('8300', '8399')],
  },
  {
    concept: 'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar',
    balance: 'debit',
    ranges: [r('8500', '8599')],
  },
  {
    concept: 'RantekostnaderLiknandeResultatposter',
    balance: 'debit',
    ranges: [r('8400', '8499')],
  },
  { concept: 'ErhallnaKoncernbidrag', balance: 'credit', ranges: [r('8820', '8829')] },
  { concept: 'LamnadeKoncernbidrag', balance: 'debit', ranges: [r('8830', '8839')] },
  { concept: 'ForandringPeriodiseringsfond', balance: 'credit', ranges: [r('8810', '8819')] },
  { concept: 'ForandringOveravskrivningar', balance: 'credit', ranges: [r('8850', '8859')] },
  {
    concept: 'OvrigaBokslutsdispositioner',
    balance: 'credit',
    ranges: [r('8840', '8849'), r('8860', '8899')],
  },
  { concept: 'SkattAretsResultat', balance: 'debit', ranges: [r('8900', '8949')] },
  { concept: 'OvrigaSkatter', balance: 'debit', ranges: [r('8950', '8989')] },
]

/** BR: full balansräkning (risbs), in uppställningsform order. */
export const K2_BR_MAPPINGS: PostMapping[] = [
  { concept: 'TecknatEjInbetaltKapital', balance: 'debit', ranges: [r('1690', '1699')] },
  // Immateriella anläggningstillgångar
  {
    concept: 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter',
    balance: 'debit',
    ranges: [r('1000', '1059'), r('1090', '1099')],
  },
  { concept: 'HyresratterLiknandeRattigheter', balance: 'debit', ranges: [r('1060', '1069')] },
  { concept: 'Goodwill', balance: 'debit', ranges: [r('1070', '1079')] },
  {
    concept: 'ForskottImmateriellaAnlaggningstillgangar',
    balance: 'debit',
    ranges: [r('1080', '1089')],
  },
  // Materiella anläggningstillgångar
  {
    concept: 'ByggnaderMark',
    balance: 'debit',
    ranges: [r('1100', '1119'), r('1130', '1179'), r('1190', '1199')],
  },
  {
    concept: 'MaskinerAndraTekniskaAnlaggningar',
    balance: 'debit',
    ranges: [r('1210', '1219')],
  },
  {
    concept: 'InventarierVerktygInstallationer',
    balance: 'debit',
    ranges: [r('1220', '1279')],
  },
  {
    concept: 'ForbattringsutgifterAnnansFastighet',
    balance: 'debit',
    ranges: [r('1120', '1129')],
  },
  {
    concept: 'OvrigaMateriellaAnlaggningstillgangar',
    balance: 'debit',
    ranges: [r('1290', '1299')],
  },
  {
    concept: 'PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar',
    balance: 'debit',
    ranges: [r('1180', '1189'), r('1280', '1289')],
  },
  // Finansiella anläggningstillgångar
  { concept: 'AndelarKoncernforetag', balance: 'debit', ranges: [r('1310', '1319')] },
  {
    concept: 'FordringarKoncernforetagLangfristiga',
    balance: 'debit',
    ranges: [r('1320', '1329')],
  },
  {
    concept: 'AndelarIntresseforetagGemensamtStyrdaForetag',
    balance: 'debit',
    ranges: [r('1330', '1335'), r('1338', '1339')],
  },
  {
    concept: 'FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga',
    balance: 'debit',
    ranges: [r('1340', '1345'), r('1348', '1349')],
  },
  { concept: 'AgarintressenOvrigaForetag', balance: 'debit', ranges: [r('1336', '1337')] },
  {
    concept: 'FordringarOvrigaForetagAgarintresseLangfristiga',
    balance: 'debit',
    ranges: [r('1346', '1347')],
  },
  {
    concept: 'AndraLangfristigaVardepappersinnehav',
    balance: 'debit',
    ranges: [r('1350', '1359'), r('1380', '1389')],
  },
  { concept: 'LanDelagareNarstaende', balance: 'debit', ranges: [r('1360', '1369')] },
  {
    concept: 'AndraLangfristigaFordringar',
    balance: 'debit',
    ranges: [r('1370', '1379'), r('1390', '1399')],
  },
  // Varulager m.m.
  { concept: 'LagerRavarorFornodenheter', balance: 'debit', ranges: [r('1400', '1439')] },
  { concept: 'LagerVarorUnderTillverkning', balance: 'debit', ranges: [r('1440', '1449')] },
  { concept: 'LagerFardigaVarorHandelsvaror', balance: 'debit', ranges: [r('1450', '1469')] },
  {
    concept: 'PagaendeArbetenAnnansRakningOmsattningstillgangar',
    balance: 'debit',
    ranges: [r('1470', '1479')],
  },
  { concept: 'ForskottTillLeverantorer', balance: 'debit', ranges: [r('1480', '1489')] },
  { concept: 'OvrigaLagertillgangar', balance: 'debit', ranges: [r('1490', '1499')] },
  // Kortfristiga fordringar
  {
    concept: 'Kundfordringar',
    balance: 'debit',
    ranges: [r('1500', '1559'), r('1590', '1599')],
  },
  {
    concept: 'FordringarKoncernforetagKortfristiga',
    balance: 'debit',
    ranges: [r('1560', '1569'), r('1660', '1669')],
  },
  {
    concept: 'FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga',
    balance: 'debit',
    ranges: [r('1570', '1572'), r('1670', '1672')],
  },
  {
    concept: 'FordringarOvrigaforetagAgarintresseKortfristiga',
    balance: 'debit',
    ranges: [r('1573', '1579'), r('1673', '1679')],
  },
  {
    concept: 'OvrigaFordringarKortfristiga',
    balance: 'debit',
    ranges: [r('1580', '1589'), r('1600', '1619'), r('1630', '1659'), r('1680', '1689')],
  },
  { concept: 'UpparbetadEjFaktureradIntakt', balance: 'debit', ranges: [r('1620', '1629')] },
  {
    concept: 'ForutbetaldaKostnaderUpplupnaIntakter',
    balance: 'debit',
    ranges: [r('1700', '1799')],
  },
  // Kortfristiga placeringar
  {
    concept: 'AndelarKoncernforetagKortfristiga',
    balance: 'debit',
    ranges: [r('1860', '1869')],
  },
  {
    concept: 'OvrigaKortfristigaPlaceringar',
    balance: 'debit',
    ranges: [r('1800', '1859'), r('1870', '1899')],
  },
  // Kassa och bank
  { concept: 'KassaBankExklRedovisningsmedel', balance: 'debit', ranges: [r('1900', '1989')] },
  { concept: 'Redovisningsmedel', balance: 'debit', ranges: [r('1990', '1999')] },
  // Eget kapital
  { concept: 'Aktiekapital', balance: 'credit', ranges: [r('2080', '2081')] },
  { concept: 'EjRegistreratAktiekapital', balance: 'credit', ranges: [r('2082', '2082')] },
  { concept: 'OverkursfondBunden', balance: 'credit', ranges: [r('2087', '2087')] },
  { concept: 'Uppskrivningsfond', balance: 'credit', ranges: [r('2085', '2085')] },
  // 2083/2084 (medlems-/förlagsinsatser) and 2088/2089 (övriga bundna fonder)
  // lack own risbs posts for AB: closest bundet-EK post is Reservfond; the
  // mapper flags them for review when present.
  {
    concept: 'Reservfond',
    balance: 'credit',
    ranges: [r('2083', '2084'), r('2086', '2086'), r('2088', '2089')],
  },
  { concept: 'Overkursfond', balance: 'credit', ranges: [r('2097', '2097')] },
  {
    concept: 'BalanseratResultat',
    balance: 'credit',
    ranges: [r('2090', '2096'), r('2098', '2098')],
  },
  { concept: 'AretsResultatEgetKapital', balance: 'credit', ranges: [r('2099', '2099')] },
  // Obeskattade reserver
  { concept: 'Periodiseringsfonder', balance: 'credit', ranges: [r('2100', '2129')] },
  { concept: 'AckumuleradeOveravskrivningar', balance: 'credit', ranges: [r('2150', '2159')] },
  {
    concept: 'OvrigaObeskattadeReserver',
    balance: 'credit',
    ranges: [r('2130', '2149'), r('2160', '2199')],
  },
  // Avsättningar
  {
    concept: 'AvsattningarPensionerLiknandeForpliktelserEnligtLag',
    balance: 'credit',
    ranges: [r('2210', '2219')],
  },
  {
    concept: 'OvrigaAvsattningarPensionerLiknandeForpliktelser',
    balance: 'credit',
    ranges: [r('2220', '2229')],
  },
  { concept: 'OvrigaAvsattningar', balance: 'credit', ranges: [r('2230', '2299')] },
  // Långfristiga skulder
  { concept: 'Obligationslan', balance: 'credit', ranges: [r('2300', '2329')] },
  { concept: 'CheckrakningskreditLangfristig', balance: 'credit', ranges: [r('2330', '2339')] },
  {
    concept: 'OvrigaLangfristigaSkulderKreditinstitut',
    balance: 'credit',
    ranges: [r('2340', '2359')],
  },
  { concept: 'SkulderKoncernforetagLangfristiga', balance: 'credit', ranges: [r('2360', '2369')] },
  {
    concept: 'SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga',
    balance: 'credit',
    ranges: [r('2370', '2372')],
  },
  {
    concept: 'SkulderOvrigaForetagAgarintresseLangfristiga',
    balance: 'credit',
    ranges: [r('2373', '2379')],
  },
  { concept: 'OvrigaLangfristigaSkulder', balance: 'credit', ranges: [r('2380', '2399')] },
  // Kortfristiga skulder: ranges per BAS 2025/2026 as shipped in
  // lib/bookkeeping/bas-data/class-2-equity-liabilities.ts (2410 = andra
  // kortfristiga låneskulder, 2420 = förskott från kunder, 2430 = pågående
  // arbeten, 2450 = fakturerad ej upparbetad, 2460 = koncern, 2470 =
  // intresse/gem styrda/ägarintresse, 2480 = kontokredit, 2492 = växelskulder).
  { concept: 'ForskottFranKunder', balance: 'credit', ranges: [r('2420', '2429')] },
  { concept: 'CheckrakningskreditKortfristig', balance: 'credit', ranges: [r('2480', '2489')] },
  {
    concept: 'OvrigaKortfristigaSkulderKreditinstitut',
    balance: 'credit',
    ranges: [r('2410', '2419')],
  },
  {
    concept: 'PagaendeArbetenAnnansRakningKortfristigaSkulder',
    balance: 'credit',
    ranges: [r('2430', '2439')],
  },
  { concept: 'FaktureradEjUpparbetadIntakt', balance: 'credit', ranges: [r('2450', '2459')] },
  { concept: 'Leverantorsskulder', balance: 'credit', ranges: [r('2440', '2449')] },
  { concept: 'Vaxelskulder', balance: 'credit', ranges: [r('2492', '2492')] },
  { concept: 'SkulderKoncernforetagKortfristiga', balance: 'credit', ranges: [r('2460', '2469')] },
  {
    concept: 'SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga',
    balance: 'credit',
    ranges: [r('2470', '2472')],
  },
  {
    concept: 'SkulderOvrigaForetagAgarintresseKortfristiga',
    balance: 'credit',
    ranges: [r('2473', '2479')],
  },
  { concept: 'Skatteskulder', balance: 'credit', ranges: [r('2500', '2599')] },
  {
    concept: 'OvrigaKortfristigaSkulder',
    balance: 'credit',
    ranges: [r('2400', '2409'), r('2490', '2491'), r('2493', '2499'), r('2600', '2899')],
  },
  {
    concept: 'UpplupnaKostnaderForutbetaldaIntakter',
    balance: 'credit',
    ranges: [r('2900', '2999')],
  },
]

/** Accounts that map to a "nearest" post and deserve a manual-review nudge. */
const RECLASSIFIED_ACCOUNTS: Record<string, string> = {
  '2083': 'Medlemsinsatser (2083) redovisas under Reservfond: granska klassificeringen.',
  '2084': 'Förlagsinsatser (2084) redovisas under Reservfond: granska klassificeringen.',
  '2088': 'Fond för yttre underhåll (2088) redovisas under Reservfond: granska klassificeringen.',
  '2089': 'Fond för utvecklingsutgifter (2089) redovisas under Reservfond: granska klassificeringen (K2 tillåter inte aktivering av egenupparbetade utgifter).',
}

/**
 * K2 BR posts each shared sign-reclassification rule moves between. The rules
 * themselves (ranges, mode, warning) live in lib/reports/sign-reclassification
 * .ts so INK2R presents the same balance sheet as the årsredovisning. Only the
 * post names are K2-specific; the arithmetic below stays öre-exact here.
 */
const SIGN_RECLASSIFICATION_POSTS: Record<
  SignReclassificationId,
  { sourceConcept: string; targetConcept: string }
> = {
  tax_account_credit_to_liability: {
    sourceConcept: 'OvrigaFordringarKortfristiga',
    targetConcept: 'Skatteskulder',
  },
  tax_liability_debit_to_receivable: {
    sourceConcept: 'Skatteskulder',
    targetConcept: 'OvrigaFordringarKortfristiga',
  },
  vat_liability_debit_to_receivable: {
    sourceConcept: 'OvrigaKortfristigaSkulder',
    targetConcept: 'OvrigaFordringarKortfristiga',
  },
}

export interface K2MappingResult {
  rr: ConceptAmounts
  br: ConceptAmounts
  /** Computed RR subtotals + BR totals, same orientation rules. */
  totals: {
    rorelseintakter: ConceptAmount
    rorelsekostnader: ConceptAmount
    rorelseresultat: ConceptAmount
    finansiellaPoster: ConceptAmount
    resultatEfterFinansiellaPoster: ConceptAmount
    bokslutsdispositioner: ConceptAmount
    resultatForeSkatt: ConceptAmount
    aretsResultat: ConceptAmount
    anlaggningstillgangar: ConceptAmount
    immateriellaAnlaggningstillgangar: ConceptAmount
    materiellaAnlaggningstillgangar: ConceptAmount
    finansiellaAnlaggningstillgangar: ConceptAmount
    varulager: ConceptAmount
    kortfristigaFordringar: ConceptAmount
    kortfristigaPlaceringar: ConceptAmount
    kassaBank: ConceptAmount
    omsattningstillgangar: ConceptAmount
    tillgangar: ConceptAmount
    bundetEgetKapital: ConceptAmount
    frittEgetKapital: ConceptAmount
    egetKapital: ConceptAmount
    obeskattadeReserver: ConceptAmount
    avsattningar: ConceptAmount
    langfristigaSkulder: ConceptAmount
    kortfristigaSkulder: ConceptAmount
    egetKapitalSkulder: ConceptAmount
  }
  warnings: string[]
  /** Accounts with balances that no mapping covered (should be none). */
  unmappedAccounts: Array<{ account: string; name: string; balance: number }>
}

function netBalance(row: TrialBalanceRowLike, orientation: 'debit' | 'credit'): number {
  const net = roundOre(row.closing_debit - row.closing_credit)
  return orientation === 'debit' ? net : -net
}

function inRanges(account: string, ranges: Range[]): boolean {
  return ranges.some((range) => account >= range.start && account <= range.end)
}

function exactSumForMapping(rows: TrialBalanceRowLike[], mapping: PostMapping): number {
  return sumOre(
    rows
      .filter((row) => inRanges(row.account_number, mapping.ranges))
      .map((row) => netBalance(row, mapping.balance)),
  )
}

function roundWhole(amount: number): number {
  const normalized = roundOre(amount)
  const rounded = Math.round(Math.abs(normalized))
  return rounded === 0 ? 0 : Math.sign(normalized) * rounded
}

function exactAmount(
  mapping: PostMapping,
  current: TrialBalanceRowLike[],
  previous: TrialBalanceRowLike[] | null,
): ConceptAmount {
  return {
    current: exactSumForMapping(current, mapping),
    previous: previous ? exactSumForMapping(previous, mapping) : null,
  }
}

function deviatingRowsTotal(
  rows: TrialBalanceRowLike[],
  rule: SignReclassificationRule,
): number {
  return sumOre(
    rows
      .filter((row) => inRanges(row.account_number, rule.ranges))
      .map((row) => netBalance(row, rule.balance))
      .filter((balance) => balance < 0),
  )
}

function applySignReclassifications(
  br: ConceptAmounts,
  current: TrialBalanceRowLike[],
  previous: TrialBalanceRowLike[] | null,
  warnings: string[],
): void {
  for (const rule of SIGN_RECLASSIFICATION_RULES) {
    const { sourceConcept, targetConcept } = SIGN_RECLASSIFICATION_POSTS[rule.id]
    let reclassified = false
    for (const field of ['current', 'previous'] as const) {
      const rows = field === 'current' ? current : previous
      if (!rows) continue
      const deviatingBalance =
        rule.mode === 'deviating_rows'
          ? deviatingRowsTotal(rows, rule)
          : exactSumForMapping(rows, {
              concept: sourceConcept,
              balance: rule.balance,
              ranges: rule.ranges,
            })
      if (deviatingBalance >= 0) continue

      const amountToMove = -deviatingBalance
      adjustConcept(br, sourceConcept, field, amountToMove)
      adjustConcept(br, targetConcept, field, amountToMove)
      reclassified = true
    }
    if (reclassified) warnings.push(rule.warning)
  }
}

function add(a: ConceptAmount, b: ConceptAmount, sign = 1): ConceptAmount {
  return {
    current: roundOre(a.current + sign * b.current),
    previous:
      a.previous === null && b.previous === null
        ? null
        : roundOre((a.previous ?? 0) + sign * (b.previous ?? 0)),
  }
}

const ZERO: ConceptAmount = { current: 0, previous: null }

function sumConcepts(amounts: ConceptAmounts, concepts: string[], signs?: number[]): ConceptAmount {
  let total: ConceptAmount = { current: 0, previous: null }
  concepts.forEach((concept, index) => {
    total = add(total, amounts[concept] ?? ZERO, signs?.[index] ?? 1)
  })
  return total
}

/**
 * Map current + previous trial balance pairs onto the K2 risbs posts.
 *
 * RR concepts come from the pre-closing TB (year-end closing excluded: the
 * closing entry zeroes class 3-8); BR concepts come from the full TB (the
 * closing entry books 2099). See TrialBalancePair.
 *
 * `previous = null` → first fiscal year (jämförelsesiffror omitted,
 * which kontrollera 3006/3007 accepts only for year one).
 */
export function mapTrialBalancesToK2(
  current: TrialBalancePair,
  previous: TrialBalancePair | null,
): K2MappingResult {
  const warnings: string[] = []
  const rr: ConceptAmounts = {}
  const rrExact: ConceptAmounts = {}
  const br: ConceptAmounts = {}
  const brExact: ConceptAmounts = {}

  for (const mapping of K2_RR_MAPPINGS) {
    rrExact[mapping.concept] = exactAmount(
      mapping,
      current.preClosing,
      previous?.preClosing ?? null,
    )
    const exact = rrExact[mapping.concept]
    rr[mapping.concept] = {
      current: roundWhole(exact.current),
      previous: exact.previous === null ? null : roundWhole(exact.previous),
    }
  }
  for (const mapping of K2_BR_MAPPINGS) {
    brExact[mapping.concept] = exactAmount(mapping, current.full, previous?.full ?? null)
  }
  applySignReclassifications(brExact, current.full, previous?.full ?? null, warnings)
  for (const mapping of K2_BR_MAPPINGS) {
    const exact = brExact[mapping.concept]
    br[mapping.concept] = {
      current: roundWhole(exact.current),
      previous: exact.previous === null ? null : roundWhole(exact.previous),
    }
  }

  // Reclassification + unmapped sweep over balance-carrying accounts. Both TB
  // variants are swept: the full TB exposes unmapped BR accounts, the
  // pre-closing TB exposes unmapped RR accounts (zeroed in the full TB).
  const allMappings = [...K2_RR_MAPPINGS, ...K2_BR_MAPPINGS]
  const unmappedAccounts: K2MappingResult['unmappedAccounts'] = []
  const seenReclass = new Set<string>()
  for (const rows of [
    current.full,
    current.preClosing,
    previous?.full ?? [],
    previous?.preClosing ?? [],
  ]) {
    for (const row of rows) {
      const balance = Math.round(row.closing_debit - row.closing_credit)
      if (balance === 0) continue
      const reclass = RECLASSIFIED_ACCOUNTS[row.account_number]
      if (reclass && !seenReclass.has(row.account_number)) {
        seenReclass.add(row.account_number)
        warnings.push(reclass)
      }
      const covered = allMappings.some((mapping) => inRanges(row.account_number, mapping.ranges))
      if (!covered && !unmappedAccounts.some((u) => u.account === row.account_number)) {
        unmappedAccounts.push({ account: row.account_number, name: row.account_name, balance })
      }
    }
  }
  for (const u of unmappedAccounts) {
    warnings.push(
      `Konto ${u.account} (${u.name}) med saldo ${u.balance} kr täcks inte av K2-mappningen: beloppet saknas i årsredovisningen.`,
    )
  }

  let totals = computeTotals(rr, br)

  // ---- öre-rounding residual smoothing ------------------------------------
  // Every tagged post is independently rounded to whole SEK, so the sum of
  // rounded posts can drift by ±1 kr from the rounded exact total even though
  // the underlying trial balance ties to the öre. Bolagsverket compares the
  // tagged totals exactly (kontrollera 3005), so a ±1 kr residual is
  // distributed back into a line item instead of tolerated. Deterministic
  // rule, per year:
  //   - BR: each side is reconciled to its rounded exact total. The residual
  //     is assigned only to a post with an exact öre amount on that side.
  //     Exact whole-krona posts, such as a booked reserve, are never changed.
  //   - RR: the residual (RR-resultat − konto 2099) is absorbed by the
  //     largest RR post: cost posts are increased by the residual, income
  //     posts decreased (ties broken toward the EARLIER post).
  // Multi-krona residuals are distributed over multiple fractional posts.
  // A residual without enough fractional posts is left for the exact balance
  // checks below instead of changing a booked whole-krona amount.
  let smoothedAny = false
  for (const field of ['current', 'previous'] as const) {
    if (field === 'previous' && previous === null) continue
    const rrSmoothed = smoothRrResidual(rr, rrExact, br, brExact, totals, field)
    const brSmoothed = smoothBrResidual(br, brExact, totals, field)
    smoothedAny = smoothedAny || rrSmoothed || brSmoothed
  }
  if (smoothedAny) totals = computeTotals(rr, br)

  // Internal consistency: the RR result must equal BR 2099 (årets resultat)
  // EXACTLY: if the year-end closing hasn't booked the result yet, warn
  // (the BR will not balance against RR otherwise). Rounding residuals were
  // smoothed above, so any remaining difference is a data problem.
  const brResult = br['AretsResultatEgetKapital'] ?? ZERO
  if (totals.aretsResultat.current !== brResult.current) {
    warnings.push(
      `Årets resultat enligt resultaträkningen (${totals.aretsResultat.current} kr) stämmer inte med konto 2099 (${brResult.current} kr). Kontrollera att bokslutet är genomfört (resultatdisposition bokad).`,
    )
  }
  if (totals.tillgangar.current !== totals.egetKapitalSkulder.current) {
    warnings.push(
      `Balansräkningen balanserar inte: Summa tillgångar ${totals.tillgangar.current} kr ≠ Summa eget kapital och skulder ${totals.egetKapitalSkulder.current} kr (kontrollera-kod 3005).`,
    )
  }

  return { rr, br, totals, warnings, unmappedAccounts }
}

function adjustConcept(
  amounts: ConceptAmounts,
  concept: string,
  field: 'current' | 'previous',
  delta: number,
): void {
  const existing = amounts[concept] ?? { current: 0, previous: null }
  amounts[concept] = { ...existing, [field]: roundOre((existing[field] ?? 0) + delta) }
}

/** Absorb a ±1 kr rounding residual between the RR result and BR 2099. */
function smoothRrResidual(
  rr: ConceptAmounts,
  rrExact: ConceptAmounts,
  br: ConceptAmounts,
  brExact: ConceptAmounts,
  totals: K2MappingResult['totals'],
  field: 'current' | 'previous',
): boolean {
  const target = br['AretsResultatEgetKapital']?.[field]
  const result = totals.aretsResultat[field]
  if (target === null || target === undefined || result === null) return false
  const diff = result - target
  if (diff === 0) return false

  const exactResult = computeTotals(rrExact, brExact).aretsResultat[field]
  const exactTarget = brExact['AretsResultatEgetKapital']?.[field]
  if (exactResult === null || exactTarget === null || exactTarget === undefined) return false
  if (!equalOre(exactResult, exactTarget)) return false

  const direction = Math.sign(diff)
  const candidates = K2_RR_MAPPINGS.flatMap((mapping, index) => {
    const rounded = rr[mapping.concept]?.[field]
    const exact = rrExact[mapping.concept]?.[field]
    if (rounded === null || rounded === undefined || exact === null || exact === undefined) return []
    if (Math.abs(exact - rounded) < 0.000001) return []
    const delta = mapping.balance === 'debit' ? direction : -direction
    return [{ concept: mapping.concept, delta, error: Math.abs(rounded + delta - exact), index }]
  }).sort((left, right) => left.error - right.error || left.index - right.index)
  if (candidates.length < Math.abs(diff)) return false
  for (const candidate of candidates.slice(0, Math.abs(diff))) {
    adjustConcept(rr, candidate.concept, field, candidate.delta)
  }
  return true
}

/** Equity/liability-side posts (everything from Aktiekapital onwards). */
const FIRST_EQ_LIAB_MAPPING_INDEX = K2_BR_MAPPINGS.findIndex(
  (mapping) => mapping.concept === 'Aktiekapital',
)
const ASSET_MAPPINGS = K2_BR_MAPPINGS.slice(0, FIRST_EQ_LIAB_MAPPING_INDEX)
const EQ_LIAB_MAPPINGS = K2_BR_MAPPINGS.slice(
  FIRST_EQ_LIAB_MAPPING_INDEX,
)

/**
 * Reconcile each BR side to its own rounded exact total without changing exact
 * posts. Residuals must not be netted across sides: doing so could make the
 * balance check pass while leaving one reported side different from its exact
 * accounting total.
 */
function smoothBrResidual(
  br: ConceptAmounts,
  brExact: ConceptAmounts,
  totals: K2MappingResult['totals'],
  field: 'current' | 'previous',
): boolean {
  const assets = totals.tillgangar[field]
  const eqLiab = totals.egetKapitalSkulder[field]
  if (assets === null || eqLiab === null) return false
  const exactTotals = computeTotals({}, brExact)
  const exactAssets = exactTotals.tillgangar[field]
  const exactEqLiab = exactTotals.egetKapitalSkulder[field]
  if (exactAssets === null || exactEqLiab === null) return false
  if (!equalOre(exactAssets, exactEqLiab)) return false

  const sides = [
    { mappings: ASSET_MAPPINGS, rounded: assets, target: roundWhole(exactAssets) },
    { mappings: EQ_LIAB_MAPPINGS, rounded: eqLiab, target: roundWhole(exactEqLiab) },
  ]
  const residuals = sides.map((side) => side.target - side.rounded)
  if (residuals.every((residual) => residual === 0)) return false
  const plans = sides.map((side, index) => {
    const residual = residuals[index]
    if (residual === 0) return []
    const direction = Math.sign(residual)
    const candidates = side.mappings.flatMap((mapping, mappingIndex) => {
      if (mapping.concept === 'AretsResultatEgetKapital') return []
      const rounded = br[mapping.concept]?.[field]
      const exact = brExact[mapping.concept]?.[field]
      if (rounded === null || rounded === undefined || exact === null || exact === undefined) return []
      if (Math.abs(exact - rounded) < 0.000001) return []
      return [{
        concept: mapping.concept,
        error: Math.abs(rounded + direction - exact),
        index: mappingIndex,
      }]
    }).sort((left, right) => left.error - right.error || left.index - right.index)
    if (candidates.length < Math.abs(residual)) return null
    return candidates.slice(0, Math.abs(residual)).map((candidate) => ({
      concept: candidate.concept,
      delta: direction,
    }))
  })
  if (plans.some((plan) => plan === null)) return false
  for (const plan of plans) {
    for (const adjustment of plan ?? []) {
      adjustConcept(br, adjustment.concept, field, adjustment.delta)
    }
  }
  return plans.some((plan) => (plan?.length ?? 0) > 0)
}

function computeTotals(rr: ConceptAmounts, br: ConceptAmounts): K2MappingResult['totals'] {
  // ---- RR subtotals (credit-positive orientation) ----
  const rorelseintakter = sumConcepts(rr, [
    'Nettoomsattning',
    'ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning',
    'AktiveratArbeteEgenRakning',
    'OvrigaRorelseintakter',
  ])
  const rorelsekostnader = sumConcepts(rr, [
    'RavarorFornodenheterKostnader',
    'HandelsvarorKostnader',
    'OvrigaExternaKostnader',
    'Personalkostnader',
    'AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar',
    'NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar',
    'OvrigaRorelsekostnader',
  ])
  const rorelseresultat = add(rorelseintakter, rorelsekostnader, -1)
  const finansiellaPoster = sumConcepts(
    rr,
    [
      'ResultatAndelarKoncernforetag',
      'ResultatAndelarIntresseforetagGemensamtStyrda',
      'ResultatOvrigaforetagAgarintresse',
      'ResultatOvrigaFinansiellaAnlaggningstillgangar',
      'OvrigaRanteintakterLiknandeResultatposter',
      'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar',
      'RantekostnaderLiknandeResultatposter',
    ],
    [1, 1, 1, 1, 1, -1, -1],
  )
  const resultatEfterFinansiellaPoster = add(rorelseresultat, finansiellaPoster)
  const bokslutsdispositioner = sumConcepts(
    rr,
    [
      'ErhallnaKoncernbidrag',
      'LamnadeKoncernbidrag',
      'ForandringPeriodiseringsfond',
      'ForandringOveravskrivningar',
      'OvrigaBokslutsdispositioner',
    ],
    [1, -1, 1, 1, 1],
  )
  const resultatForeSkatt = add(resultatEfterFinansiellaPoster, bokslutsdispositioner)
  const skatter = sumConcepts(rr, ['SkattAretsResultat', 'OvrigaSkatter'])
  const aretsResultat = add(resultatForeSkatt, skatter, -1)

  // ---- BR totals ----
  const immateriella = sumConcepts(br, [
    'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter',
    'HyresratterLiknandeRattigheter',
    'Goodwill',
    'ForskottImmateriellaAnlaggningstillgangar',
  ])
  const materiella = sumConcepts(br, [
    'ByggnaderMark',
    'MaskinerAndraTekniskaAnlaggningar',
    'InventarierVerktygInstallationer',
    'ForbattringsutgifterAnnansFastighet',
    'OvrigaMateriellaAnlaggningstillgangar',
    'PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar',
  ])
  const finansiella = sumConcepts(br, [
    'AndelarKoncernforetag',
    'FordringarKoncernforetagLangfristiga',
    'AndelarIntresseforetagGemensamtStyrdaForetag',
    'FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga',
    'AgarintressenOvrigaForetag',
    'FordringarOvrigaForetagAgarintresseLangfristiga',
    'AndraLangfristigaVardepappersinnehav',
    'LanDelagareNarstaende',
    'AndraLangfristigaFordringar',
  ])
  const anlaggningstillgangar = add(add(immateriella, materiella), finansiella)
  const varulager = sumConcepts(br, [
    'LagerRavarorFornodenheter',
    'LagerVarorUnderTillverkning',
    'LagerFardigaVarorHandelsvaror',
    'PagaendeArbetenAnnansRakningOmsattningstillgangar',
    'ForskottTillLeverantorer',
    'OvrigaLagertillgangar',
  ])
  const kortfristigaFordringar = sumConcepts(br, [
    'Kundfordringar',
    'FordringarKoncernforetagKortfristiga',
    'FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga',
    'FordringarOvrigaforetagAgarintresseKortfristiga',
    'OvrigaFordringarKortfristiga',
    'UpparbetadEjFaktureradIntakt',
    'ForutbetaldaKostnaderUpplupnaIntakter',
  ])
  const kortfristigaPlaceringar = sumConcepts(br, [
    'AndelarKoncernforetagKortfristiga',
    'OvrigaKortfristigaPlaceringar',
  ])
  const kassaBank = sumConcepts(br, ['KassaBankExklRedovisningsmedel', 'Redovisningsmedel'])
  const omsattningstillgangar = add(
    add(varulager, kortfristigaFordringar),
    add(kortfristigaPlaceringar, kassaBank),
  )
  const tillgangar = add(
    add(br['TecknatEjInbetaltKapital'] ?? ZERO, anlaggningstillgangar),
    omsattningstillgangar,
  )

  const bundetEgetKapital = sumConcepts(br, [
    'Aktiekapital',
    'EjRegistreratAktiekapital',
    'OverkursfondBunden',
    'Uppskrivningsfond',
    'Reservfond',
  ])
  const frittEgetKapital = sumConcepts(br, [
    'Overkursfond',
    'BalanseratResultat',
    'AretsResultatEgetKapital',
  ])
  const egetKapital = add(bundetEgetKapital, frittEgetKapital)
  const obeskattadeReserver = sumConcepts(br, [
    'Periodiseringsfonder',
    'AckumuleradeOveravskrivningar',
    'OvrigaObeskattadeReserver',
  ])
  const avsattningar = sumConcepts(br, [
    'AvsattningarPensionerLiknandeForpliktelserEnligtLag',
    'OvrigaAvsattningarPensionerLiknandeForpliktelser',
    'OvrigaAvsattningar',
  ])
  const langfristigaSkulder = sumConcepts(br, [
    'Obligationslan',
    'CheckrakningskreditLangfristig',
    'OvrigaLangfristigaSkulderKreditinstitut',
    'SkulderKoncernforetagLangfristiga',
    'SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga',
    'SkulderOvrigaForetagAgarintresseLangfristiga',
    'OvrigaLangfristigaSkulder',
  ])
  const kortfristigaSkulder = sumConcepts(br, [
    'ForskottFranKunder',
    'CheckrakningskreditKortfristig',
    'OvrigaKortfristigaSkulderKreditinstitut',
    'PagaendeArbetenAnnansRakningKortfristigaSkulder',
    'FaktureradEjUpparbetadIntakt',
    'Leverantorsskulder',
    'Vaxelskulder',
    'SkulderKoncernforetagKortfristiga',
    'SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga',
    'SkulderOvrigaForetagAgarintresseKortfristiga',
    'Skatteskulder',
    'OvrigaKortfristigaSkulder',
    'UpplupnaKostnaderForutbetaldaIntakter',
  ])
  const egetKapitalSkulder = add(
    add(add(egetKapital, obeskattadeReserver), add(avsattningar, langfristigaSkulder)),
    kortfristigaSkulder,
  )

  return {
    rorelseintakter,
    rorelsekostnader,
    rorelseresultat,
    finansiellaPoster,
    resultatEfterFinansiellaPoster,
    bokslutsdispositioner,
    resultatForeSkatt,
    aretsResultat,
    anlaggningstillgangar,
    immateriellaAnlaggningstillgangar: immateriella,
    materiellaAnlaggningstillgangar: materiella,
    finansiellaAnlaggningstillgangar: finansiella,
    varulager,
    kortfristigaFordringar,
    kortfristigaPlaceringar,
    kassaBank,
    omsattningstillgangar,
    tillgangar,
    bundetEgetKapital,
    frittEgetKapital,
    egetKapital,
    obeskattadeReserver,
    avsattningar,
    langfristigaSkulder,
    kortfristigaSkulder,
    egetKapitalSkulder,
  }
}
