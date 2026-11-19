/**
 * The uppställningsform of BFNAR 2010:1 bilaga 2 (förenklat årsbokslut for
 * ideella föreningar and registrerade trossamfund), as data: rubriker, posts
 * and summeringsrader in the order BFN prints them. An editorial change from
 * BFN is an edit here, not in the engine or the PDF.
 *
 * Source: BFN, "Ideella föreningar och registrerade trossamfund som upprättar
 * förenklat årsbokslut", consolidated vägledning updated 2024-12-13, bilaga 2
 * (as amended by BFNAR 2024:6), and the commentary to chapter 5 (pp. 32-33):
 *   - rubriker keep their names; posts and summeringsrader may be renamed to
 *     describe their content better (5.1), and the defaults below are BFN's;
 *   - a rubrik, post or summeringsrad with nothing to report may be left out;
 *   - no rubrik, post or summeringsrad may be added and no posts merged;
 *   - comparatives for every post and summeringsrad (5.2).
 *
 * Amounts follow BFN's example 5-2: in the resultaträkning an income is
 * positive and a cost negative (credit minus debit), so every summeringsrad is
 * a plain sum; in the balansräkning assets, eget kapital, obeskattade reserver
 * and skulder are each positive on their own side.
 */

export type ResultatPost =
  | 'medlemsavgifter'
  | 'gavorOchBidrag'
  | 'ovrigaVerksamhetsintakter'
  | 'forsaljningsintakter'
  | 'ovrigaIntakter'
  | 'verksamhetskostnader'
  | 'forsaljningskostnader'
  | 'ovrigaExternaKostnader'
  | 'personalkostnader'
  | 'avOchNedskrivningar'
  | 'ovrigaKostnader'
  | 'finansiellaIntakter'
  | 'finansiellaKostnader'
  | 'bokslutsdispositioner'
  | 'skatt'

export type BalansPost =
  | 'immateriellaAnlaggningstillgangar'
  | 'byggnaderOchMark'
  | 'inventarier'
  | 'varulager'
  | 'kundfordringar'
  | 'ovrigaFordringar'
  | 'finansiellaPlaceringar'
  | 'kassaOchBank'
  | 'balanseradeOverUnderskott'
  | 'aretsOverUnderskott'
  | 'obeskattadeReserver'
  | 'laneskulder'
  | 'leverantorsskulder'
  | 'skatteskulder'
  | 'ovrigaSkulder'

export type K1Post = ResultatPost | BalansPost

export type ResultatSumma =
  | 'summaIntakter'
  | 'summaKostnader'
  | 'verksamhetensOverUnderskott'
  | 'overUnderskottEfterFinansiellaPoster'
  | 'aretsOverUnderskottResultat'

export type BalansSumma =
  | 'summaTillgangar'
  | 'summaEgetKapital'
  | 'summaSkulder'
  | 'summaEgetKapitalOchSkulder'

export type K1Summa = ResultatSumma | BalansSumma

export type K1LayoutRow =
  | { kind: 'rubrik'; key: string; label: string }
  | { kind: 'post'; key: K1Post; label: string }
  | {
      kind: 'summa'
      key: K1Summa
      label: string
      /** The posts and earlier summeringsrader this row adds up. */
      terms: ReadonlyArray<K1Post | K1Summa>
      /**
       * Printed whatever the figures: the statement's closing line. Other
       * summeringsrader are left out when no post they add is printed.
       */
      always?: boolean
    }

/** Bilaga 2, Resultaträkning. */
export const RESULTATRAKNING_LAYOUT: readonly K1LayoutRow[] = [
  { kind: 'rubrik', key: 'intakter', label: 'Intäkter' },
  { kind: 'post', key: 'medlemsavgifter', label: 'Medlemsavgifter' },
  { kind: 'post', key: 'gavorOchBidrag', label: 'Gåvor och bidrag' },
  { kind: 'post', key: 'ovrigaVerksamhetsintakter', label: 'Övriga verksamhetsintäkter' },
  { kind: 'post', key: 'forsaljningsintakter', label: 'Försäljningsintäkter' },
  { kind: 'post', key: 'ovrigaIntakter', label: 'Övriga intäkter' },
  {
    kind: 'summa',
    key: 'summaIntakter',
    label: 'Summa intäkter',
    terms: ['medlemsavgifter', 'gavorOchBidrag', 'ovrigaVerksamhetsintakter', 'forsaljningsintakter', 'ovrigaIntakter'],
  },
  { kind: 'rubrik', key: 'kostnader', label: 'Kostnader' },
  { kind: 'post', key: 'verksamhetskostnader', label: 'Verksamhetskostnader' },
  { kind: 'post', key: 'forsaljningskostnader', label: 'Försäljningskostnader' },
  { kind: 'post', key: 'ovrigaExternaKostnader', label: 'Övriga externa kostnader' },
  { kind: 'post', key: 'personalkostnader', label: 'Personalkostnader' },
  {
    kind: 'post',
    key: 'avOchNedskrivningar',
    label: 'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
  },
  { kind: 'post', key: 'ovrigaKostnader', label: 'Övriga kostnader' },
  {
    kind: 'summa',
    key: 'summaKostnader',
    label: 'Summa kostnader',
    terms: [
      'verksamhetskostnader',
      'forsaljningskostnader',
      'ovrigaExternaKostnader',
      'personalkostnader',
      'avOchNedskrivningar',
      'ovrigaKostnader',
    ],
  },
  {
    kind: 'summa',
    key: 'verksamhetensOverUnderskott',
    label: 'Verksamhetens över-/underskott',
    terms: ['summaIntakter', 'summaKostnader'],
  },
  { kind: 'post', key: 'finansiellaIntakter', label: 'Finansiella intäkter' },
  { kind: 'post', key: 'finansiellaKostnader', label: 'Finansiella kostnader' },
  {
    kind: 'summa',
    key: 'overUnderskottEfterFinansiellaPoster',
    label: 'Över-/underskott efter finansiella poster',
    terms: ['verksamhetensOverUnderskott', 'finansiellaIntakter', 'finansiellaKostnader'],
  },
  { kind: 'post', key: 'bokslutsdispositioner', label: 'Bokslutsdispositioner' },
  { kind: 'post', key: 'skatt', label: 'Skatt' },
  {
    kind: 'summa',
    key: 'aretsOverUnderskottResultat',
    label: 'Årets över-/underskott',
    terms: ['overUnderskottEfterFinansiellaPoster', 'bokslutsdispositioner', 'skatt'],
    always: true,
  },
]

/** Bilaga 2, Balansräkning. */
export const BALANSRAKNING_LAYOUT: readonly K1LayoutRow[] = [
  { kind: 'rubrik', key: 'tillgangar', label: 'Tillgångar' },
  { kind: 'post', key: 'immateriellaAnlaggningstillgangar', label: 'Immateriella anläggningstillgångar' },
  { kind: 'post', key: 'byggnaderOchMark', label: 'Byggnader och mark' },
  { kind: 'post', key: 'inventarier', label: 'Inventarier' },
  { kind: 'post', key: 'varulager', label: 'Varulager' },
  { kind: 'post', key: 'kundfordringar', label: 'Kundfordringar' },
  { kind: 'post', key: 'ovrigaFordringar', label: 'Övriga fordringar' },
  { kind: 'post', key: 'finansiellaPlaceringar', label: 'Finansiella placeringar' },
  { kind: 'post', key: 'kassaOchBank', label: 'Kassa och bank' },
  {
    kind: 'summa',
    key: 'summaTillgangar',
    label: 'Summa tillgångar',
    terms: [
      'immateriellaAnlaggningstillgangar',
      'byggnaderOchMark',
      'inventarier',
      'varulager',
      'kundfordringar',
      'ovrigaFordringar',
      'finansiellaPlaceringar',
      'kassaOchBank',
    ],
    always: true,
  },
  { kind: 'rubrik', key: 'egetKapital', label: 'Eget kapital' },
  { kind: 'post', key: 'balanseradeOverUnderskott', label: 'Balanserade över-/underskott' },
  { kind: 'post', key: 'aretsOverUnderskott', label: 'Årets över-/underskott' },
  {
    kind: 'summa',
    key: 'summaEgetKapital',
    label: 'Summa eget kapital',
    terms: ['balanseradeOverUnderskott', 'aretsOverUnderskott'],
  },
  { kind: 'post', key: 'obeskattadeReserver', label: 'Obeskattade reserver' },
  { kind: 'rubrik', key: 'skulder', label: 'Skulder' },
  { kind: 'post', key: 'laneskulder', label: 'Låneskulder' },
  { kind: 'post', key: 'leverantorsskulder', label: 'Leverantörsskulder' },
  { kind: 'post', key: 'skatteskulder', label: 'Skatteskulder' },
  { kind: 'post', key: 'ovrigaSkulder', label: 'Övriga skulder' },
  {
    kind: 'summa',
    key: 'summaSkulder',
    label: 'Summa skulder',
    terms: ['laneskulder', 'leverantorsskulder', 'skatteskulder', 'ovrigaSkulder'],
  },
  {
    kind: 'summa',
    key: 'summaEgetKapitalOchSkulder',
    label: 'Summa eget kapital och skulder',
    terms: ['summaEgetKapital', 'obeskattadeReserver', 'summaSkulder'],
    always: true,
  },
]

/** Posts on the debit side of the balansräkning: shown as debit minus credit. */
export const ASSET_POSTS: ReadonlySet<BalansPost> = new Set<BalansPost>([
  'immateriellaAnlaggningstillgangar',
  'byggnaderOchMark',
  'inventarier',
  'varulager',
  'kundfordringar',
  'ovrigaFordringar',
  'finansiellaPlaceringar',
  'kassaOchBank',
])
