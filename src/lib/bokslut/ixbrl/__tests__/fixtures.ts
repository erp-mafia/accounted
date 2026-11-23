/**
 * Shared deterministic fixture for iXBRL generator tests: a small AB with a
 * balanced BR (380 000 kr) and an RR netting to 120 000 kr, mapped through
 * the real k2-mapper so concept amounts stay consistent with the mapping
 * rules under test.
 *
 * Each year is a realistic post-bokslut TrialBalancePair:
 *   - `full`: the booked state AFTER the year-end closing entry: every
 *     class 3-8 account is zeroed (equal debit/credit churn) and 2099
 *     carries the year's result.
 *   - `preClosing`: the same year WITHOUT the closing entry
 *     (excludeFinalClosingEntry): RR accounts still open, 2099 only carries
 *     the prior-year churn from the resultatdisposition entry.
 */

import type { AnlaggningAsset } from '@/lib/bokslut/arsredovisning/anlaggningstillgangar-note'
import {
  buildK2FixedAssetTables,
  fixedAssetNoteBody,
  type FixedAssetNoteRows,
  type FixedAssetNoteTable,
  type WriteDownsOutsideRegister,
} from '@/lib/bokslut/arsredovisning/k2-fixed-asset-note'
import { k2AssetPostLabel } from '../document/statements'
import {
  K2_BR_MAPPINGS,
  k2BrPostForAccount,
  mapTrialBalancesToK2,
  type TrialBalancePair,
  type TrialBalanceRowLike,
} from '../k2-mapper'
import type { IxbrlArsredovisningInput, K3EquityPost } from '../types'
import { k3CashFlowFromStatement, k3EquityFromSpecification } from '../k3-adapters'

const row = (
  account: string,
  name: string,
  debit: number,
  credit: number,
): TrialBalanceRowLike => ({
  account_number: account,
  account_name: name,
  closing_debit: debit,
  closing_credit: credit,
})

/** Current year WITHOUT the closing entry: RR accounts open. 2099 nets to 0
 *  (prior-year result IB balanced away by the disposition entry). */
const CURRENT_PRE_CLOSING: TrialBalanceRowLike[] = [
  row('1220', 'Inventarier', 80_000, 0),
  row('1229', 'Ack avskrivningar', 0, 20_000),
  row('1510', 'Kundfordringar', 50_000, 0),
  row('1930', 'Bank', 270_000, 0),
  row('2081', 'Aktiekapital', 0, 25_000),
  row('2091', 'Balanserad vinst', 0, 100_000),
  row('2099', 'Årets resultat', 40_000, 40_000),
  row('2110', 'Periodiseringsfond', 0, 40_000),
  row('2440', 'Leverantörsskulder', 0, 30_000),
  row('2510', 'Skatteskulder', 0, 35_000),
  row('2610', 'Utgående moms', 0, 20_000),
  row('2941', 'Upplupna sociala avgifter', 0, 10_000),
  row('3010', 'Försäljning', 0, 1_000_000),
  row('4010', 'Inköp', 200_000, 0),
  row('5010', 'Lokalhyra', 100_000, 0),
  row('7010', 'Löner', 400_000, 0),
  row('7510', 'Arbetsgivaravgifter', 125_660, 0),
  row('7832', 'Avskrivningar', 20_000, 0),
  row('8310', 'Ränteintäkter', 0, 1_000),
  row('8410', 'Räntekostnader', 4_000, 0),
  row('8811', 'Avsättning periodiseringsfond', 10_000, 0),
  row('8910', 'Skatt', 21_340, 0),
]

/** Current year WITH the closing entry: class 3-8 zeroed, 2099 = 120 000. */
const CURRENT_FULL: TrialBalanceRowLike[] = [
  row('1220', 'Inventarier', 80_000, 0),
  row('1229', 'Ack avskrivningar', 0, 20_000),
  row('1510', 'Kundfordringar', 50_000, 0),
  row('1930', 'Bank', 270_000, 0),
  row('2081', 'Aktiekapital', 0, 25_000),
  row('2091', 'Balanserad vinst', 0, 100_000),
  row('2099', 'Årets resultat', 40_000, 160_000),
  row('2110', 'Periodiseringsfond', 0, 40_000),
  row('2440', 'Leverantörsskulder', 0, 30_000),
  row('2510', 'Skatteskulder', 0, 35_000),
  row('2610', 'Utgående moms', 0, 20_000),
  row('2941', 'Upplupna sociala avgifter', 0, 10_000),
  row('3010', 'Försäljning', 1_000_000, 1_000_000),
  row('4010', 'Inköp', 200_000, 200_000),
  row('5010', 'Lokalhyra', 100_000, 100_000),
  row('7010', 'Löner', 400_000, 400_000),
  row('7510', 'Arbetsgivaravgifter', 125_660, 125_660),
  row('7832', 'Avskrivningar', 20_000, 20_000),
  row('8310', 'Ränteintäkter', 1_000, 1_000),
  row('8410', 'Räntekostnader', 4_000, 4_000),
  row('8811', 'Avsättning periodiseringsfond', 10_000, 10_000),
  row('8910', 'Skatt', 21_340, 21_340),
]

const PREVIOUS_PRE_CLOSING: TrialBalanceRowLike[] = [
  row('1220', 'Inventarier', 80_000, 0),
  row('1229', 'Ack avskrivningar', 0, 12_000),
  row('1930', 'Bank', 185_000, 0),
  row('2081', 'Aktiekapital', 0, 25_000),
  row('2091', 'Balanserad vinst', 0, 60_000),
  row('2110', 'Periodiseringsfond', 0, 30_000),
  row('2440', 'Leverantörsskulder', 0, 25_000),
  row('2510', 'Skatteskulder', 0, 15_000),
  row('2610', 'Utgående moms', 0, 8_000),
  row('2941', 'Upplupna sociala avgifter', 0, 50_000),
  row('3010', 'Försäljning', 0, 500_000),
  row('4010', 'Inköp', 200_000, 0),
  row('5010', 'Lokalhyra', 80_000, 0),
  row('7010', 'Löner', 150_000, 0),
  row('7832', 'Avskrivningar', 8_000, 0),
  row('8410', 'Räntekostnader', 2_000, 0),
  row('8910', 'Skatt', 20_000, 0),
]

const PREVIOUS_FULL: TrialBalanceRowLike[] = [
  row('1220', 'Inventarier', 80_000, 0),
  row('1229', 'Ack avskrivningar', 0, 12_000),
  row('1930', 'Bank', 185_000, 0),
  row('2081', 'Aktiekapital', 0, 25_000),
  row('2091', 'Balanserad vinst', 0, 60_000),
  row('2099', 'Årets resultat', 0, 40_000),
  row('2110', 'Periodiseringsfond', 0, 30_000),
  row('2440', 'Leverantörsskulder', 0, 25_000),
  row('2510', 'Skatteskulder', 0, 15_000),
  row('2610', 'Utgående moms', 0, 8_000),
  row('2941', 'Upplupna sociala avgifter', 0, 50_000),
  row('3010', 'Försäljning', 500_000, 500_000),
  row('4010', 'Inköp', 200_000, 200_000),
  row('5010', 'Lokalhyra', 80_000, 80_000),
  row('7010', 'Löner', 150_000, 150_000),
  row('7832', 'Avskrivningar', 8_000, 8_000),
  row('8410', 'Räntekostnader', 2_000, 2_000),
  row('8910', 'Skatt', 20_000, 20_000),
]

export const CURRENT: TrialBalancePair = {
  full: CURRENT_FULL,
  preClosing: CURRENT_PRE_CLOSING,
}

export const PREVIOUS: TrialBalancePair = {
  full: PREVIOUS_FULL,
  preClosing: PREVIOUS_PRE_CLOSING,
}

/** A year with more balance accounts on the books, before and after the closing entry alike. */
function withRows(pair: TrialBalancePair, rows: TrialBalanceRowLike[] = []): TrialBalancePair {
  return rows.length === 0 ? pair : { full: [...pair.full, ...rows], preClosing: [...pair.preClosing, ...rows] }
}

export function makeInput(
  /** Balance accounts on top of the fixture's (they must balance among themselves). */
  extra: { current?: TrialBalanceRowLike[]; previous?: TrialBalanceRowLike[] } = {},
): IxbrlArsredovisningInput {
  const mapping = mapTrialBalancesToK2(withRows(CURRENT, extra.current), withRows(PREVIOUS, extra.previous))
  return {
    company: { name: 'Testbolaget AB', orgNumber: '556999-9997', registeredOffice: 'Sundsvall' },
    period: { start: '2025-01-01', end: '2025-12-31' },
    previousPeriod: { start: '2024-01-01', end: '2024-12-31' },
    isFirstFiscalYear: false,
    rr: mapping.rr,
    br: mapping.br,
    totals: mapping.totals,
    forvaltningsberattelse: {
      allmantOmVerksamheten:
        'Bolaget bedriver konsultverksamhet inom IT.\n\nBolaget har sitt säte i Sundsvall.',
      vasentligaHandelser: 'Inga väsentliga händelser har inträffat under räkenskapsåret.',
      // Rows 0/1 mirror the mapper outputs (duplicate facts with the RR must
      // be value-identical, TA §2.7.3): same override build-input applies.
      flerarsoversikt: [
        {
          year: '2025',
          nettoomsattning: mapping.rr['Nettoomsattning'].current,
          resultatEfterFinansiellaPoster: mapping.totals.resultatEfterFinansiellaPoster.current,
          soliditetPct: 64.5,
        },
        {
          year: '2024',
          nettoomsattning: mapping.rr['Nettoomsattning'].previous ?? 0,
          resultatEfterFinansiellaPoster:
            mapping.totals.resultatEfterFinansiellaPoster.previous ?? 0,
          soliditetPct: 49.4,
        },
        {
          year: '2023',
          nettoomsattning: 300_000,
          resultatEfterFinansiellaPoster: 25_000,
          soliditetPct: 41.0,
        },
      ],
      flerarsPerioder: [
        { start: '2025-01-01', end: '2025-12-31' },
        { start: '2024-01-01', end: '2024-12-31' },
        { start: '2023-01-01', end: '2023-12-31' },
      ],
      egetKapital: {
        aktiekapital: { ib: 25_000, ub: 25_000 },
        balanseratResultat: { ib: 60_000, ub: 100_000 },
        aretsResultat: { ib: 40_000, ub: 120_000 },
        totalt: { ib: 125_000, ub: 245_000 },
        ovrigaPoster: { ib: 0, ub: 0 },
        balanserasINyRakning: 40_000,
        utdelning: 0,
        forandringAktiekapital: 0,
        ovrigForandringBalanserat: 0,
        aretsResultatRorelse: 120_000,
      },
      resultatdisposition: {
        balanseratResultat: 100_000,
        overkursfond: 0,
        aretsResultat: 120_000,
        summa: 220_000,
        utdelning: 0,
        balanserasINyRakning: 220_000,
        kommentar: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      },
    },
    noter: [
      {
        number: 1,
        title: 'Redovisnings- och värderingsprinciper',
        body: 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).',
      },
      { number: 2, title: 'Medelantal anställda', body: 'Medelantalet anställda har uppgått till 2.' },
      { number: 3, title: 'Långfristiga skulder', body: 'Inga skulder förfaller senare än fem år efter balansdagen.' },
      { number: 4, title: 'Ställda säkerheter', body: 'Inga.' },
      { number: 5, title: 'Eventualförpliktelser', body: 'Inga.' },
      {
        number: 6,
        title: 'Koncernförhållanden',
        body: 'Moderföretag: Moderbolaget AB.',
      },
    ],
    disclosures: {
      longTermDebtOverFiveYears: 0,
      securitiesPledged: 'Inga.',
      contingentLiabilities: 'Inga.',
      parentCompany: 'Moderföretag: Moderbolaget AB.',
    },
    medelantalAnstallda: { current: 2, previous: 1 },
    underskrifter: {
      ort: 'Sundsvall',
      dateringsdatum: '2026-02-20',
      signers: [
        { firstName: 'Karl', lastName: 'Karlsson', role: 'Styrelseledamot', signedDate: '2026-02-20' },
        {
          firstName: 'Karin',
          lastName: 'Olsson',
          role: 'Verkställande direktör',
          signedDate: '2026-02-21',
        },
      ],
      harVd: true,
    },
    faststallelseintyg: {
      arsstammaDatum: '2026-03-15',
      resultatdispositionOutcome: 'proposal_approved',
      resultatdispositionDecision: null,
      signerFirstName: 'Karl',
      signerLastName: 'Karlsson',
      signerRole: 'Styrelseledamot',
      genereratDatum: '2026-02-25',
    },
    programvara: { namn: 'Arcim Technology AB - Accounted', version: '1.0' },
    entryPointId: 'k2-ab-risbs-2024-09-12',
    warnings: [],
  }
}

/**
 * The same company under K3 (entry point K3 AB risbs 2021-10-31): one K3
 * post of its own (a 5 000 kr uppskjuten skattefordran carved out of the
 * kundfordringar, totals adjusted), the equity specification from the
 * ledger (last year's result carried forward, this year's result) and a
 * chapter 7 kassaflödesanalys that ties to likvida medel (185 000 → 270 000).
 */
export function makeK3Input(): IxbrlArsredovisningInput {
  const input = makeInput()
  input.entryPointId = 'k3-ab-risbs-2021-10-31'
  input.br = {
    ...input.br,
    Kundfordringar: { current: 45_000, previous: 0 },
    UppskjutenSkattefordran: { current: 5_000, previous: 0 },
  }
  const shift = (key: keyof typeof input.totals, delta: number) => {
    input.totals = { ...input.totals, [key]: { ...input.totals[key], current: input.totals[key].current + delta } }
  }
  shift('finansiellaAnlaggningstillgangar', 5_000)
  shift('anlaggningstillgangar', 5_000)
  shift('kortfristigaFordringar', -5_000)
  shift('omsattningstillgangar', -5_000)
  input.noter = input.noter.map((note) =>
    note.number === 1
      ? { ...note, body: 'Årsredovisningen är upprättad i enlighet med årsredovisningslagen och BFNAR 2012:1 Årsredovisning och koncernredovisning (K3).' }
      : note,
  )
  const amounts: Record<string, number> = {
    rorelseresultat: 154_340,
    justeringar_ej_kassaflode: 20_000,
    erhallen_utdelning: 0,
    erhallen_ranta: 1_000,
    erlagd_ranta: -4_000,
    ovriga_finansiella_poster: 0,
    betald_inkomstskatt: -1_340,
    koncernbidrag: 0,
    kassaflode_fore_rorelsekapital: 170_000,
    forandring_varulager: 0,
    forandring_rorelsefordringar: -50_000,
    forandring_rorelseskulder: -35_000,
    ovriga_poster: 0,
    kassaflode_lopande: 85_000,
    kassaflode_investering: 0,
    kassaflode_finansiering: 0,
    arets_kassaflode: 85_000,
    likvida_medel_ib: 185_000,
    kursdifferens_likvida_medel: 0,
    likvida_medel_ub: 270_000,
  }
  input.k3 = {
    forvaltningsberattelse: [
      {
        concept: 'UppgiftAgareMerAnTioProcentAndelarRoster',
        heading: 'Ägarförhållanden',
        text: 'Bolaget ägs till 100 procent av Moderbolaget AB.',
      },
    ],
    equity: k3EquityFromSpecification(
      {
        kinds: ['resultatdisposition', 'utdelning', 'arets_resultat'],
        current: {
          posts: [
            { concept: 'Aktiekapital', label: 'Aktiekapital', bound: true, opening: 25_000, closing: 25_000, movements: {} },
            { concept: 'BalanseratResultat', label: 'Balanserat resultat', bound: false, opening: 60_000, closing: 100_000, movements: { resultatdisposition: 40_000 } },
            {
              concept: 'AretsResultatEgetKapital',
              label: 'Årets resultat',
              bound: false,
              opening: 40_000,
              closing: 120_000,
              movements: { resultatdisposition: -40_000, arets_resultat: 120_000 },
            },
          ],
        },
      },
      input.br,
    ),
    cashFlow: k3CashFlowFromStatement({
      current: { amounts, reconciliation: { is_reconciled: true } },
      previous: null,
    }),
    balanceSheetSource: 'k3_presentation',
  }
  return input
}

/** The jämförelseår of the K3 fixture's equity specification (2024: last year's 25 000 kr result carried forward). */
export const K3_EQUITY_PREVIOUS_YEAR: { posts: K3EquityPost[] } = {
  posts: [
    { concept: 'Aktiekapital', label: 'Aktiekapital', bound: true, opening: 25_000, closing: 25_000, movements: {} },
    { concept: 'BalanseratResultat', label: 'Balanserat resultat', bound: false, opening: 35_000, closing: 60_000, movements: { resultatdisposition: 25_000 } },
    {
      concept: 'AretsResultatEgetKapital',
      label: 'Årets resultat',
      bound: false,
      opening: 25_000,
      closing: 40_000,
      movements: { resultatdisposition: -25_000, arets_resultat: 40_000 },
    },
  ],
}

// ---- a complete anläggningstillgångar note ---------------------------------
//
// Bolagsverket's test criterion for the note (Testunderlag för
// K2-årsredovisning 5.0, 2024-09-12): one post where every concept of its
// note is tagged and holds a value other than zero. Maskiner och andra
// tekniska anläggningar here. The register tells a machine held, one sold,
// and four that came in during the year, one of each acquisition type; the
// write-down accounts hold more than the register; the rest is stated.

const MACHINE_HELD: AnlaggningAsset = {
  category: 'machinery',
  acquisition_date: '2020-01-01',
  acquisition_cost: 2_000_000,
  salvage_value: 0,
  useful_life_months: 600,
  disposed_at: null,
  bas_asset_account: '1210',
  figures: { ibAck: 200_000, aretsAvskrivning: 40_000, avgaendeAck: 0 },
  writeDowns: { opening: 80_000, writtenDown: 30_000, reversed: 10_000, disposed: 0, closing: 100_000 },
}
const MACHINE_SOLD: AnlaggningAsset = {
  ...MACHINE_HELD,
  acquisition_cost: 400_000,
  disposed_at: '2025-09-30',
  figures: { ibAck: 60_000, aretsAvskrivning: 6_000, avgaendeAck: 66_000 },
  writeDowns: { opening: 20_000, writtenDown: 0, reversed: 0, disposed: 20_000, closing: 0 },
}
const cameIn = (
  acquisition_type: AnlaggningAsset['acquisition_type'],
  acquisition_date: string,
  acquisition_cost: number,
  figures: AnlaggningAsset['figures'],
): AnlaggningAsset => ({ ...MACHINE_HELD, acquisition_type, acquisition_date, acquisition_cost, figures, writeDowns: undefined })
const MACHINES_ACQUIRED: AnlaggningAsset[] = [
  cameIn('purchase', '2025-05-01', 900_000, { ibAck: 0, aretsAvskrivning: 12_000, avgaendeAck: 0 }),
  cameIn('business_acquisition', '2025-03-01', 150_000, { ibAck: 0, aretsAvskrivning: 5_000, avgaendeAck: 0 }),
  // Taken over with 45 000 already depreciated.
  cameIn('merger', '2025-06-01', 250_000, { ibAck: 45_000, aretsAvskrivning: 8_000, avgaendeAck: 0 }),
  // Moved in from another post with 5 000 already depreciated.
  cameIn('reclassification', '2025-07-01', 70_000, { ibAck: 5_000, aretsAvskrivning: 3_000, avgaendeAck: 0 }),
]

export const COMPLETE_NOTE_POST = 'MaskinerAndraTekniskaAnlaggningar'

/** Every row a user can state for the post, each with an amount of its own. */
export const COMPLETE_NOTE_STATED_ROWS: FixedAssetNoteRows = {
  [COMPLETE_NOTE_POST]: {
    'cost.omrakningsdifferenser': -8_000,
    'depreciation.omrakningsdifferenser': 2_000,
    'impairment.fusion': 11_000,
    'impairment.forsaljningar': 4_000,
    'impairment.omklassificeringar': 6_000,
    'impairment.omrakningsdifferenser': 1_500,
  },
}

/**
 * What the post's write-down accounts hold beyond the register: 20 000 from
 * before Accounted, 11 000 taken over in the fusion, and 11 500 that left
 * with a machine sold, an omklassificering and an omräkning (the stated
 * nedskrivning rows).
 */
const COMPLETE_NOTE_WRITE_DOWNS_OUTSIDE: WriteDownsOutsideRegister = { opening: 20_000, written: 11_000, released: 11_500 }

/**
 * The post on the books at the start and at the end of the year, written
 * out by hand and not read off the note, so the tie between the two is a
 * check of the note's arithmetic:
 *   anskaffningsvärden 2 400 000 + 900 000 + 150 000 + 250 000 - 400 000
 *     + 70 000 - 8 000 = 3 362 000
 *   avskrivningar 260 000 + 45 000 - 66 000 + 5 000 + 74 000 - 2 000 = 316 000
 *   nedskrivningar 120 000 + 11 000 - 24 000 - 10 000 - 6 000 + 30 000
 *     - 1 500 = 119 500
 */
export const COMPLETE_NOTE_BOOKS = {
  opening: { cost: 2_400_000, depreciation: 260_000, impairment: 120_000 },
  closing: { cost: 3_362_000, depreciation: 316_000, impairment: 119_500 },
} as const

/** The K2 note tables of register assets and stated rows, as build-data builds them. */
export function fixedAssetTables(
  assets: AnlaggningAsset[],
  stated: FixedAssetNoteRows = {},
  outsideWriteDowns?: ReadonlyMap<string, WriteDownsOutsideRegister>,
): FixedAssetNoteTable[] {
  return buildK2FixedAssetTables({
    assets,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    stated,
    postOfAccount: (account) => k2BrPostForAccount(account, 'aktiebolag'),
    labelOfPost: (post) => k2AssetPostLabel(post) ?? post,
    postOrder: K2_BR_MAPPINGS.map((mapping) => mapping.concept),
    outsideWriteDowns,
  })
}

export function completeFixedAssetTables(): FixedAssetNoteTable[] {
  return fixedAssetTables(
    [MACHINE_HELD, MACHINE_SOLD, ...MACHINES_ACQUIRED],
    COMPLETE_NOTE_STATED_ROWS,
    new Map([[COMPLETE_NOTE_POST, COMPLETE_NOTE_WRITE_DOWNS_OUTSIDE]]),
  )
}

/**
 * makeInput with the complete note and the machines on the books
 * (COMPLETE_NOTE_BOOKS), financed by a long-term loan: the balance sheet
 * balances in both years and the note's redovisat värde is its post.
 */
export function makeCompleteFixedAssetNoteInput(): IxbrlArsredovisningInput {
  const tables = completeFixedAssetTables()
  const books = (at: 'opening' | 'closing'): TrialBalanceRowLike[] => {
    const { cost, depreciation, impairment } = COMPLETE_NOTE_BOOKS[at]
    return [
      row('1210', 'Maskiner och andra tekniska anläggningar', cost, 0),
      row('1218', 'Ackumulerade nedskrivningar på maskiner och andra tekniska anläggningar', 0, impairment),
      row('1219', 'Ackumulerade avskrivningar på maskiner och andra tekniska anläggningar', 0, depreciation),
      row('2350', 'Andra långfristiga skulder till kreditinstitut', 0, cost - depreciation - impairment),
    ]
  }
  const input = makeInput({ current: books('closing'), previous: books('opening') })
  input.noter = [
    ...input.noter,
    {
      number: input.noter.length + 1,
      title: 'Anläggningstillgångar',
      body: fixedAssetNoteBody(tables),
      fixedAssets: tables,
    },
  ]
  return input
}
