/**
 * The kassaflödesanalys shape (K3 chapter 7): line keys, their order, label
 * and K3 taxonomy concept, and the per-year result. Pure data and types, no
 * BAS chart, so a client component can render a statement from it. The
 * builder lives in kassaflodesanalys-statement.ts.
 *
 * `KassaflodesanalysYear.amounts` is keyed by `KassaflodesanalysLineKey`, and
 * `KASSAFLODESANALYS_LAYOUT` gives the order, the Swedish label and the K3
 * taxonomy concept for each key. Both are the contract the årsredovisning
 * (PDF) and the iXBRL mapping read: add keys, never rename or repurpose one.
 */

export type KassaflodesanalysLineKey =
  // Den löpande verksamheten
  | 'rorelseresultat'
  | 'justeringar_ej_kassaflode'
  | 'erhallen_utdelning'
  | 'erhallen_ranta'
  | 'erlagd_ranta'
  | 'ovriga_finansiella_poster'
  | 'betald_inkomstskatt'
  | 'koncernbidrag'
  | 'kassaflode_fore_rorelsekapital'
  | 'forandring_varulager'
  | 'forandring_rorelsefordringar'
  | 'forandring_rorelseskulder'
  | 'ovriga_poster'
  | 'kassaflode_lopande'
  // Investeringsverksamheten
  | 'investering_immateriella'
  | 'forsaljning_immateriella'
  | 'investering_materiella'
  | 'forsaljning_materiella'
  | 'investering_finansiella'
  | 'forsaljning_finansiella'
  | 'forandring_kortfristiga_placeringar'
  | 'forandring_sparrade_bankmedel'
  | 'kassaflode_investering'
  // Finansieringsverksamheten
  | 'upptagna_lan'
  | 'amortering_lan'
  | 'forandring_checkrakningskredit'
  | 'nyemission'
  | 'erhallna_aktieagartillskott'
  | 'utbetald_utdelning'
  | 'kassaflode_finansiering'
  // Likvida medel
  | 'arets_kassaflode'
  | 'likvida_medel_ib'
  | 'kursdifferens_likvida_medel'
  | 'likvida_medel_ub'

export type KassaflodesanalysSection = 'lopande' | 'investering' | 'finansiering' | 'likvida_medel'

export interface KassaflodesanalysLayoutRow {
  key: KassaflodesanalysLineKey
  section: KassaflodesanalysSection
  /** line: an item; subtotal: a sum inside a section; total: a section or year total. */
  kind: 'line' | 'subtotal' | 'total'
  /** The Swedish label printed in the statement (statutory wording, stays Swedish). */
  label: string
  /**
   * The K3 taxonomy concept (se-gen-base, kassaflödesanalys indirekt metod)
   * the line maps to, or null where the taxonomy has none. likvida_medel_ib
   * and _ub are the same concept at the period's start and end instant.
   */
  concept: string | null
  /** Printed even when zero in both years. */
  alwaysShow: boolean
}

export const KASSAFLODESANALYS_LAYOUT: readonly KassaflodesanalysLayoutRow[] = [
  { key: 'rorelseresultat', section: 'lopande', kind: 'line', label: 'Rörelseresultat', concept: 'Rorelseresultat', alwaysShow: true },
  { key: 'justeringar_ej_kassaflode', section: 'lopande', kind: 'line', label: 'Justeringar för poster som inte ingår i kassaflödet', concept: 'JusteringPosterSomInteIngarIKassaflodet', alwaysShow: true },
  { key: 'erhallen_utdelning', section: 'lopande', kind: 'line', label: 'Erhållen utdelning', concept: 'ErhallenUtdelning', alwaysShow: false },
  { key: 'erhallen_ranta', section: 'lopande', kind: 'line', label: 'Erhållen ränta', concept: 'ErhallenRanta', alwaysShow: false },
  { key: 'erlagd_ranta', section: 'lopande', kind: 'line', label: 'Erlagd ränta', concept: 'ErlagdRanta', alwaysShow: false },
  { key: 'ovriga_finansiella_poster', section: 'lopande', kind: 'line', label: 'Övriga finansiella poster', concept: null, alwaysShow: false },
  { key: 'betald_inkomstskatt', section: 'lopande', kind: 'line', label: 'Betald inkomstskatt', concept: 'BetaldSkatt', alwaysShow: true },
  { key: 'koncernbidrag', section: 'lopande', kind: 'line', label: 'Erhållna och lämnade koncernbidrag', concept: null, alwaysShow: false },
  { key: 'kassaflode_fore_rorelsekapital', section: 'lopande', kind: 'subtotal', label: 'Kassaflöde från den löpande verksamheten före förändringar av rörelsekapital', concept: 'KassaflodeLopandeVerksamhetenForeForandringarRorelsekapital', alwaysShow: true },
  { key: 'forandring_varulager', section: 'lopande', kind: 'line', label: 'Förändring av varulager', concept: 'ForandringKassaflodeVarulagerPagaendeArbeten', alwaysShow: false },
  { key: 'forandring_rorelsefordringar', section: 'lopande', kind: 'line', label: 'Förändring av rörelsefordringar', concept: 'ForandringKassaflodeRorelsefodringar', alwaysShow: true },
  { key: 'forandring_rorelseskulder', section: 'lopande', kind: 'line', label: 'Förändring av rörelseskulder', concept: 'ForandringKassaflodeRorelseskulder', alwaysShow: true },
  { key: 'ovriga_poster', section: 'lopande', kind: 'line', label: 'Övriga poster', concept: null, alwaysShow: false },
  { key: 'kassaflode_lopande', section: 'lopande', kind: 'total', label: 'Kassaflöde från den löpande verksamheten', concept: 'KassaflodeLopandeVerksamheten', alwaysShow: true },
  { key: 'investering_immateriella', section: 'investering', kind: 'line', label: 'Investeringar i immateriella anläggningstillgångar', concept: 'InvesteringImmateriellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'forsaljning_immateriella', section: 'investering', kind: 'line', label: 'Försäljning av immateriella anläggningstillgångar', concept: 'ForsaljningImmateriellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'investering_materiella', section: 'investering', kind: 'line', label: 'Investeringar i materiella anläggningstillgångar', concept: 'InvesteringMateriellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'forsaljning_materiella', section: 'investering', kind: 'line', label: 'Försäljning av materiella anläggningstillgångar', concept: 'ForsaljningMateriellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'investering_finansiella', section: 'investering', kind: 'line', label: 'Investeringar i finansiella anläggningstillgångar', concept: 'InvesteringFinansiellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'forsaljning_finansiella', section: 'investering', kind: 'line', label: 'Försäljning och amortering av finansiella anläggningstillgångar', concept: 'ForsaljningFinansiellaAnlaggningstillgangar', alwaysShow: false },
  { key: 'forandring_kortfristiga_placeringar', section: 'investering', kind: 'line', label: 'Förändring av kortfristiga placeringar', concept: 'ForandringKassaflodeOvrigaKortfristigaPlaceringar', alwaysShow: false },
  { key: 'forandring_sparrade_bankmedel', section: 'investering', kind: 'line', label: 'Förändring av spärrade bankmedel', concept: null, alwaysShow: false },
  { key: 'kassaflode_investering', section: 'investering', kind: 'total', label: 'Kassaflöde från investeringsverksamheten', concept: 'KassaflodeInvesteringsverksamheten', alwaysShow: true },
  { key: 'upptagna_lan', section: 'finansiering', kind: 'line', label: 'Upptagna lån', concept: 'UpptagnaLan', alwaysShow: false },
  { key: 'amortering_lan', section: 'finansiering', kind: 'line', label: 'Amortering av lån', concept: 'AmorteringSkuld', alwaysShow: false },
  { key: 'forandring_checkrakningskredit', section: 'finansiering', kind: 'line', label: 'Förändring av checkräkningskredit', concept: 'ForandringCheckrakningskredit', alwaysShow: false },
  { key: 'nyemission', section: 'finansiering', kind: 'line', label: 'Nyemission', concept: 'NyemissionKassaflode', alwaysShow: false },
  { key: 'erhallna_aktieagartillskott', section: 'finansiering', kind: 'line', label: 'Erhållna aktieägartillskott', concept: 'ErhallnaAktieagartillskottKassaflode', alwaysShow: false },
  { key: 'utbetald_utdelning', section: 'finansiering', kind: 'line', label: 'Utbetald utdelning', concept: 'UtbetaldUtdelningKassaflode', alwaysShow: false },
  { key: 'kassaflode_finansiering', section: 'finansiering', kind: 'total', label: 'Kassaflöde från finansieringsverksamheten', concept: 'KassaflodeFinansieringsverksamheten', alwaysShow: true },
  { key: 'arets_kassaflode', section: 'likvida_medel', kind: 'total', label: 'Årets kassaflöde', concept: 'AretsKassaflode', alwaysShow: true },
  { key: 'likvida_medel_ib', section: 'likvida_medel', kind: 'line', label: 'Likvida medel vid årets början', concept: 'LikvidaMedel', alwaysShow: true },
  { key: 'kursdifferens_likvida_medel', section: 'likvida_medel', kind: 'line', label: 'Kursdifferens i likvida medel', concept: 'LikvidaMedelKursdifferens', alwaysShow: false },
  { key: 'likvida_medel_ub', section: 'likvida_medel', kind: 'total', label: 'Likvida medel vid årets slut', concept: 'LikvidaMedel', alwaysShow: true },
]

export type KassaflodesanalysAmounts = Record<KassaflodesanalysLineKey, number>

/** What "Justeringar för poster som inte ingår i kassaflödet" consists of. */
export interface KassaflodesanalysJusteringar {
  /** Avskrivningar and nedskrivningar (net of återföringar) of anläggningstillgångar. */
  avskrivningar_nedskrivningar: number
  /** Realised result on disposals of anläggningstillgångar, reversed (its cash is in investering). */
  realisationsresultat: number
  /** Unrealised exchange differences on likvida medel booked in rörelseresultat, reversed (7.13). */
  orealiserade_kursdifferenser: number
  /**
   * Everything else without a cash effect: changes in avsättningar (22xx),
   * bokslutsdispositioner against obeskattade reserver, deferred tax, the
   * interest share of the pension cost (8412), foreign income tax already
   * in rörelseresultat (its payment is in betald inkomstskatt).
   */
  ovriga: number
}

/** Likvida medel by the parts 7.18 names, at one instant. */
export interface LikvidaMedelComposition {
  /** Kassamedel (191x). */
  kassamedel: number
  /** Disponibla tillgodohavanden hos banker och andra kreditinstitut. */
  bank: number
  /** Kortfristiga, likvida placeringar (1950 and any 18xx account the caller qualifies under 7.4 c). */
  kortfristiga_placeringar: number
  /** The company's share of a koncernkonto (1960), when 7.4 second paragraph applies. */
  koncernkonto: number
  total: number
}

export interface LikvidaMedelDefinition {
  /** Accounts (by prefix) whose balance is likvida medel. */
  account_prefixes: string[]
  /** 7.4 second paragraph (BFNAR 2025:3): koncernkonto 1960 counted as likvida medel. */
  koncernkonto_included: boolean
  /** 19xx accounts left out (not disponibla, or koncernkonto before 2026). */
  excluded_accounts: string[]
  /** Accounts outside 19xx the caller added. */
  extra_accounts: string[]
}

export interface KassaflodesanalysYear {
  period_start: string
  period_end: string
  amounts: KassaflodesanalysAmounts
  justeringar: KassaflodesanalysJusteringar
  likvida_medel: {
    definition: LikvidaMedelDefinition
    ib: LikvidaMedelComposition
    ub: LikvidaMedelComposition
  }
  /** 7.20: the total income tax paid. Never split across categories here, so it equals betald_inkomstskatt. */
  total_tax_payments: number
  /** Accounts in ovriga_poster: outside every classified range. */
  unclassified_accounts: string[]
  reconciliation: {
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}

export type KassaflodesanalysPreviousStatus =
  | 'included'
  | 'not_requested'
  | 'no_previous_period'
  | 'no_activity'
  | 'unavailable'

export interface KassaflodesanalysStatement {
  method: 'indirect'
  current: KassaflodesanalysYear
  /** The comparative year (K3 3.5), computed with the current year's likvida medel definition. */
  previous: KassaflodesanalysYear | null
  previous_status: KassaflodesanalysPreviousStatus
}
