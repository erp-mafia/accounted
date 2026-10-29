/**
 * The resultaträkning and balansräkning as data: one row list per framework
 * (K2 AB risbs 2024-09-12, K3 AB risbs 2021-10-31), one renderer. The K3
 * lists follow the K3 forms' presentation linkbases (fisbn, fbs) in order;
 * the K2 lists reproduce the layout the K2 document has always had.
 *
 * Amounts come from the mapper: posts from `rr`/`br` (concept-keyed), sums
 * from `totals`. A group is printed only when its total is non-zero in
 * either year; a post only when it is non-zero, unless `alwaysShow`.
 */

import type { K2MappingResult } from '../k2-mapper'
import type { ConceptAmounts } from '../types'
import type { FactWriter } from './ix'
import { moneyRow, sectionRow } from './layout'
import { el, escapeText } from './xml'

export type TotalKey = keyof K2MappingResult['totals']

export type StatementNode =
  | {
      kind: 'post'
      label: string
      concept: string
      indent?: boolean
      displayMinus?: boolean
      alwaysShow?: boolean
    }
  | {
      kind: 'sum'
      label: string
      concept: string
      total: TotalKey
      rowClass: 'subtotal' | 'total'
      displayMinus?: boolean
    }
  | { kind: 'heading'; label: string; level: 'section' | 'subsection' }
  | { kind: 'group'; showIf: TotalKey; children: StatementNode[] }

export interface StatementTable {
  title: string
  rows: StatementNode[]
}

const post = (
  label: string,
  concept: string,
  opts: { indent?: boolean; displayMinus?: boolean; alwaysShow?: boolean } = {},
): StatementNode => ({ kind: 'post', label, concept, indent: opts.indent ?? true, ...opts })
const cost = (label: string, concept: string): StatementNode => post(label, concept, { displayMinus: true })
const subtotal = (label: string, concept: string, total: TotalKey, displayMinus = false): StatementNode => ({
  kind: 'sum',
  label,
  concept,
  total,
  rowClass: 'subtotal',
  displayMinus,
})
const grandTotal = (label: string, concept: string, total: TotalKey): StatementNode => ({
  kind: 'sum',
  label,
  concept,
  total,
  rowClass: 'total',
})
const section = (label: string): StatementNode => ({ kind: 'heading', label, level: 'section' })
const subsection = (label: string): StatementNode => ({ kind: 'heading', label, level: 'subsection' })
const group = (showIf: TotalKey, ...children: StatementNode[]): StatementNode => ({ kind: 'group', showIf, children })

// ---- resultaträkning (kostnadsslagsindelad) --------------------------------

function resultatrakning(otherAppropriations: string): StatementNode[] {
  return [
    section('Rörelseintäkter, lagerförändringar m.m.'),
    post('Nettoomsättning', 'Nettoomsattning', { alwaysShow: true }),
    post(
      'Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning',
      'ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning',
    ),
    post('Aktiverat arbete för egen räkning', 'AktiveratArbeteEgenRakning'),
    post('Övriga rörelseintäkter', 'OvrigaRorelseintakter'),
    subtotal('Summa rörelseintäkter, lagerförändringar m.m.', 'RorelseintakterLagerforandringarMm', 'rorelseintakter'),
    section('Rörelsekostnader'),
    cost('Råvaror och förnödenheter', 'RavarorFornodenheterKostnader'),
    cost('Handelsvaror', 'HandelsvarorKostnader'),
    cost('Övriga externa kostnader', 'OvrigaExternaKostnader'),
    cost('Personalkostnader', 'Personalkostnader'),
    cost(
      'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
      'AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar',
    ),
    cost(
      'Nedskrivningar av omsättningstillgångar utöver normala nedskrivningar',
      'NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar',
    ),
    cost('Övriga rörelsekostnader', 'OvrigaRorelsekostnader'),
    subtotal('Summa rörelsekostnader', 'Rorelsekostnader', 'rorelsekostnader', true),
    subtotal('Rörelseresultat', 'Rorelseresultat', 'rorelseresultat'),
    section('Finansiella poster'),
    post('Resultat från andelar i koncernföretag', 'ResultatAndelarKoncernforetag'),
    post(
      'Resultat från andelar i intresseföretag och gemensamt styrda företag',
      'ResultatAndelarIntresseforetagGemensamtStyrda',
    ),
    post('Resultat från övriga företag som det finns ett ägarintresse i', 'ResultatOvrigaforetagAgarintresse'),
    post('Resultat från övriga finansiella anläggningstillgångar', 'ResultatOvrigaFinansiellaAnlaggningstillgangar'),
    post('Övriga ränteintäkter och liknande resultatposter', 'OvrigaRanteintakterLiknandeResultatposter'),
    cost(
      'Nedskrivningar av finansiella anläggningstillgångar och kortfristiga placeringar',
      'NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar',
    ),
    cost('Räntekostnader och liknande resultatposter', 'RantekostnaderLiknandeResultatposter'),
    subtotal('Summa finansiella poster', 'FinansiellaPoster', 'finansiellaPoster'),
    subtotal('Resultat efter finansiella poster', 'ResultatEfterFinansiellaPoster', 'resultatEfterFinansiellaPoster'),
    group(
      'bokslutsdispositioner',
      section('Bokslutsdispositioner'),
      post('Erhållna koncernbidrag', 'ErhallnaKoncernbidrag'),
      cost('Lämnade koncernbidrag', 'LamnadeKoncernbidrag'),
      post('Förändring av periodiseringsfonder', 'ForandringPeriodiseringsfond'),
      post('Förändring av överavskrivningar', 'ForandringOveravskrivningar'),
      post('Övriga bokslutsdispositioner', otherAppropriations),
      subtotal('Summa bokslutsdispositioner', 'Bokslutsdispositioner', 'bokslutsdispositioner'),
    ),
    subtotal('Resultat före skatt', 'ResultatForeSkatt', 'resultatForeSkatt'),
    section('Skatter'),
    cost('Skatt på årets resultat', 'SkattAretsResultat'),
    cost('Övriga skatter', 'OvrigaSkatter'),
    grandTotal('Årets resultat', 'AretsResultat', 'aretsResultat'),
  ]
}

/** K2 AB risbs 2024-09-12. */
export const K2_RESULTATRAKNING: StatementNode[] = resultatrakning('OvrigaBokslutsdispositioner')

/** K3 AB risbs 2021-10-31 (fisbn): K3 names the other appropriations AndraBokslutsdispositioner. */
export const K3_RESULTATRAKNING: StatementNode[] = resultatrakning('AndraBokslutsdispositioner')

// ---- balansräkning ------------------------------------------------------------

/** K2 AB risbs 2024-09-12: assets. */
export const K2_BALANSRAKNING_TILLGANGAR: StatementNode[] = [
  post('Tecknat men ej inbetalt kapital', 'TecknatEjInbetaltKapital', { indent: false }),
  section('Anläggningstillgångar'),
  group(
    'immateriellaAnlaggningstillgangar',
    subsection('Immateriella anläggningstillgångar'),
    post('Koncessioner, patent, licenser, varumärken samt liknande rättigheter', 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter'),
    post('Hyresrätter och liknande rättigheter', 'HyresratterLiknandeRattigheter'),
    post('Goodwill', 'Goodwill'),
    post('Förskott avseende immateriella anläggningstillgångar', 'ForskottImmateriellaAnlaggningstillgangar'),
    subtotal('Summa immateriella anläggningstillgångar', 'ImmateriellaAnlaggningstillgangar', 'immateriellaAnlaggningstillgangar'),
  ),
  group(
    'materiellaAnlaggningstillgangar',
    subsection('Materiella anläggningstillgångar'),
    post('Byggnader och mark', 'ByggnaderMark'),
    post('Maskiner och andra tekniska anläggningar', 'MaskinerAndraTekniskaAnlaggningar'),
    post('Inventarier, verktyg och installationer', 'InventarierVerktygInstallationer'),
    post('Förbättringsutgifter på annans fastighet', 'ForbattringsutgifterAnnansFastighet'),
    post('Övriga materiella anläggningstillgångar', 'OvrigaMateriellaAnlaggningstillgangar'),
    post('Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar', 'PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar'),
    subtotal('Summa materiella anläggningstillgångar', 'MateriellaAnlaggningstillgangar', 'materiellaAnlaggningstillgangar'),
  ),
  group(
    'finansiellaAnlaggningstillgangar',
    subsection('Finansiella anläggningstillgångar'),
    post('Andelar i koncernföretag', 'AndelarKoncernforetag'),
    post('Fordringar hos koncernföretag', 'FordringarKoncernforetagLangfristiga'),
    post('Andelar i intresseföretag och gemensamt styrda företag', 'AndelarIntresseforetagGemensamtStyrdaForetag'),
    post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga'),
    post('Ägarintressen i övriga företag', 'AgarintressenOvrigaForetag'),
    post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaForetagAgarintresseLangfristiga'),
    post('Andra långfristiga värdepappersinnehav', 'AndraLangfristigaVardepappersinnehav'),
    post('Lån till delägare eller närstående', 'LanDelagareNarstaende'),
    post('Andra långfristiga fordringar', 'AndraLangfristigaFordringar'),
    subtotal('Summa finansiella anläggningstillgångar', 'FinansiellaAnlaggningstillgangar', 'finansiellaAnlaggningstillgangar'),
  ),
  subtotal('Summa anläggningstillgångar', 'Anlaggningstillgangar', 'anlaggningstillgangar'),
  section('Omsättningstillgångar'),
  group(
    'varulager',
    subsection('Varulager m.m.'),
    post('Råvaror och förnödenheter', 'LagerRavarorFornodenheter'),
    post('Varor under tillverkning', 'LagerVarorUnderTillverkning'),
    post('Färdiga varor och handelsvaror', 'LagerFardigaVarorHandelsvaror'),
    post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningOmsattningstillgangar'),
    post('Förskott till leverantörer', 'ForskottTillLeverantorer'),
    post('Övriga lagertillgångar', 'OvrigaLagertillgangar'),
    subtotal('Summa varulager m.m.', 'VarulagerMm', 'varulager'),
  ),
  subsection('Kortfristiga fordringar'),
  post('Kundfordringar', 'Kundfordringar'),
  post('Fordringar hos koncernföretag', 'FordringarKoncernforetagKortfristiga'),
  post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga'),
  post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaforetagAgarintresseKortfristiga'),
  post('Övriga fordringar', 'OvrigaFordringarKortfristiga', { alwaysShow: true }),
  post('Upparbetad men ej fakturerad intäkt', 'UpparbetadEjFaktureradIntakt'),
  post('Förutbetalda kostnader och upplupna intäkter', 'ForutbetaldaKostnaderUpplupnaIntakter'),
  subtotal('Summa kortfristiga fordringar', 'KortfristigaFordringar', 'kortfristigaFordringar'),
  group(
    'kortfristigaPlaceringar',
    subsection('Kortfristiga placeringar'),
    post('Andelar i koncernföretag', 'AndelarKoncernforetagKortfristiga'),
    post('Övriga kortfristiga placeringar', 'OvrigaKortfristigaPlaceringar'),
    subtotal('Summa kortfristiga placeringar', 'KortfristigaPlaceringar', 'kortfristigaPlaceringar'),
  ),
  subsection('Kassa och bank'),
  post('Kassa och bank', 'KassaBankExklRedovisningsmedel', { alwaysShow: true }),
  post('Redovisningsmedel', 'Redovisningsmedel'),
  subtotal('Summa kassa och bank', 'KassaBank', 'kassaBank'),
  subtotal('Summa omsättningstillgångar', 'Omsattningstillgangar', 'omsattningstillgangar'),
  grandTotal('Summa tillgångar', 'Tillgangar', 'tillgangar'),
]

/** K2 AB risbs 2024-09-12: equity and liabilities. */
export const K2_BALANSRAKNING_EGET_KAPITAL_SKULDER: StatementNode[] = [
  section('Eget kapital'),
  subsection('Bundet eget kapital'),
  post('Aktiekapital', 'Aktiekapital', { alwaysShow: true }),
  post('Ej registrerat aktiekapital', 'EjRegistreratAktiekapital'),
  post('Bunden överkursfond', 'OverkursfondBunden'),
  post('Uppskrivningsfond', 'Uppskrivningsfond'),
  post('Reservfond', 'Reservfond'),
  subtotal('Summa bundet eget kapital', 'BundetEgetKapital', 'bundetEgetKapital'),
  subsection('Fritt eget kapital'),
  post('Överkursfond', 'Overkursfond'),
  post('Balanserat resultat', 'BalanseratResultat', { alwaysShow: true }),
  post('Årets resultat', 'AretsResultatEgetKapital', { alwaysShow: true }),
  subtotal('Summa fritt eget kapital', 'FrittEgetKapital', 'frittEgetKapital'),
  subtotal('Summa eget kapital', 'EgetKapital', 'egetKapital'),
  group(
    'obeskattadeReserver',
    section('Obeskattade reserver'),
    post('Periodiseringsfonder', 'Periodiseringsfonder'),
    post('Ackumulerade överavskrivningar', 'AckumuleradeOveravskrivningar'),
    post('Övriga obeskattade reserver', 'OvrigaObeskattadeReserver'),
    subtotal('Summa obeskattade reserver', 'ObeskattadeReserver', 'obeskattadeReserver'),
  ),
  group(
    'avsattningar',
    section('Avsättningar'),
    post('Avsättningar för pensioner och liknande förpliktelser enligt lag', 'AvsattningarPensionerLiknandeForpliktelserEnligtLag'),
    post('Övriga avsättningar för pensioner och liknande förpliktelser', 'OvrigaAvsattningarPensionerLiknandeForpliktelser'),
    post('Övriga avsättningar', 'OvrigaAvsattningar'),
    subtotal('Summa avsättningar', 'Avsattningar', 'avsattningar'),
  ),
  group(
    'langfristigaSkulder',
    section('Långfristiga skulder'),
    post('Obligationslån', 'Obligationslan'),
    post('Checkräkningskredit', 'CheckrakningskreditLangfristig'),
    post('Övriga skulder till kreditinstitut', 'OvrigaLangfristigaSkulderKreditinstitut'),
    post('Skulder till koncernföretag', 'SkulderKoncernforetagLangfristiga'),
    post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga'),
    post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseLangfristiga'),
    post('Övriga skulder', 'OvrigaLangfristigaSkulder'),
    subtotal('Summa långfristiga skulder', 'LangfristigaSkulder', 'langfristigaSkulder'),
  ),
  section('Kortfristiga skulder'),
  post('Förskott från kunder', 'ForskottFranKunder'),
  post('Checkräkningskredit', 'CheckrakningskreditKortfristig'),
  post('Övriga skulder till kreditinstitut', 'OvrigaKortfristigaSkulderKreditinstitut'),
  post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningKortfristigaSkulder'),
  post('Fakturerad men ej upparbetad intäkt', 'FaktureradEjUpparbetadIntakt'),
  post('Leverantörsskulder', 'Leverantorsskulder', { alwaysShow: true }),
  post('Växelskulder', 'Vaxelskulder'),
  post('Skulder till koncernföretag', 'SkulderKoncernforetagKortfristiga'),
  post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga'),
  post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseKortfristiga'),
  post('Skatteskulder', 'Skatteskulder'),
  post('Övriga skulder', 'OvrigaKortfristigaSkulder', { alwaysShow: true }),
  post('Upplupna kostnader och förutbetalda intäkter', 'UpplupnaKostnaderForutbetaldaIntakter'),
  subtotal('Summa kortfristiga skulder', 'KortfristigaSkulder', 'kortfristigaSkulder'),
  grandTotal('Summa eget kapital och skulder', 'EgetKapitalSkulder', 'egetKapitalSkulder'),
]

/**
 * K3 AB risbs 2021-10-31 (fbs), in the form's presentation order. K3's own
 * posts (K3 4.3, 29.6, 29.19-29.20, ÅRL bilaga 1): balanserade utgifter för
 * utvecklingsarbeten, uppskjuten skattefordran, aktuell skattefordran (the
 * taxonomy spells it AktuellSkattefodran), fond för utvecklingsutgifter,
 * fond för verkligt värde, uppskjuten skatteskuld and avsättningar för
 * övriga skatter. K2 names that K3 does not use are renamed
 * (ForskottImmateriella... → PagaendeUtvecklingsarbetenForskott...,
 * OvrigaObeskattadeReserver → AndraObeskattadeReserver) by the K3 mapping.
 */
export const K3_BALANSRAKNING_TILLGANGAR: StatementNode[] = [
  post('Tecknat men ej inbetalt kapital', 'TecknatEjInbetaltKapital', { indent: false }),
  section('Anläggningstillgångar'),
  group(
    'immateriellaAnlaggningstillgangar',
    subsection('Immateriella anläggningstillgångar'),
    post('Balanserade utgifter för utvecklingsarbeten och liknande arbeten', 'BalanseradeUtgifterUtvecklingsarbetenLiknandeArbeten'),
    post('Koncessioner, patent, licenser, varumärken samt liknande rättigheter', 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter'),
    post('Hyresrätter och liknande rättigheter', 'HyresratterLiknandeRattigheter'),
    post('Goodwill', 'Goodwill'),
    post('Pågående utvecklingsarbeten och förskott avseende immateriella anläggningstillgångar', 'PagaendeUtvecklingsarbetenForskottImmateriellaAnlaggningstillgangar'),
    subtotal('Summa immateriella anläggningstillgångar', 'ImmateriellaAnlaggningstillgangar', 'immateriellaAnlaggningstillgangar'),
  ),
  group(
    'materiellaAnlaggningstillgangar',
    subsection('Materiella anläggningstillgångar'),
    post('Byggnader och mark', 'ByggnaderMark'),
    post('Maskiner och andra tekniska anläggningar', 'MaskinerAndraTekniskaAnlaggningar'),
    post('Inventarier, verktyg och installationer', 'InventarierVerktygInstallationer'),
    post('Förbättringsutgifter på annans fastighet', 'ForbattringsutgifterAnnansFastighet'),
    post('Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar', 'PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar'),
    post('Övriga materiella anläggningstillgångar', 'OvrigaMateriellaAnlaggningstillgangar'),
    subtotal('Summa materiella anläggningstillgångar', 'MateriellaAnlaggningstillgangar', 'materiellaAnlaggningstillgangar'),
  ),
  group(
    'finansiellaAnlaggningstillgangar',
    subsection('Finansiella anläggningstillgångar'),
    post('Andelar i koncernföretag', 'AndelarKoncernforetag'),
    post('Fordringar hos koncernföretag', 'FordringarKoncernforetagLangfristiga'),
    post('Andelar i intresseföretag och gemensamt styrda företag', 'AndelarIntresseforetagGemensamtStyrdaForetag'),
    post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga'),
    post('Ägarintressen i övriga företag', 'AgarintressenOvrigaForetag'),
    post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaForetagAgarintresseLangfristiga'),
    post('Andra långfristiga värdepappersinnehav', 'AndraLangfristigaVardepappersinnehav'),
    post('Lån till delägare eller närstående', 'LanDelagareNarstaende'),
    post('Uppskjuten skattefordran', 'UppskjutenSkattefordran'),
    post('Andra långfristiga fordringar', 'AndraLangfristigaFordringar'),
    subtotal('Summa finansiella anläggningstillgångar', 'FinansiellaAnlaggningstillgangar', 'finansiellaAnlaggningstillgangar'),
  ),
  subtotal('Summa anläggningstillgångar', 'Anlaggningstillgangar', 'anlaggningstillgangar'),
  section('Omsättningstillgångar'),
  group(
    'varulager',
    subsection('Varulager m.m.'),
    post('Råvaror och förnödenheter', 'LagerRavarorFornodenheter'),
    post('Varor under tillverkning', 'LagerVarorUnderTillverkning'),
    post('Färdiga varor och handelsvaror', 'LagerFardigaVarorHandelsvaror'),
    post('Övriga lagertillgångar', 'OvrigaLagertillgangar'),
    post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningOmsattningstillgangar'),
    post('Förskott till leverantörer', 'ForskottTillLeverantorer'),
    subtotal('Summa varulager m.m.', 'VarulagerMm', 'varulager'),
  ),
  subsection('Kortfristiga fordringar'),
  post('Kundfordringar', 'Kundfordringar'),
  post('Fordringar hos koncernföretag', 'FordringarKoncernforetagKortfristiga'),
  post('Fordringar hos intresseföretag och gemensamt styrda företag', 'FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga'),
  post('Fordringar hos övriga företag som det finns ett ägarintresse i', 'FordringarOvrigaforetagAgarintresseKortfristiga'),
  post('Aktuell skattefordran', 'AktuellSkattefodran'),
  post('Övriga fordringar', 'OvrigaFordringarKortfristiga', { alwaysShow: true }),
  post('Upparbetad men ej fakturerad intäkt', 'UpparbetadEjFaktureradIntakt'),
  post('Förutbetalda kostnader och upplupna intäkter', 'ForutbetaldaKostnaderUpplupnaIntakter'),
  subtotal('Summa kortfristiga fordringar', 'KortfristigaFordringar', 'kortfristigaFordringar'),
  group(
    'kortfristigaPlaceringar',
    subsection('Kortfristiga placeringar'),
    post('Andelar i koncernföretag', 'AndelarKoncernforetagKortfristiga'),
    post('Övriga kortfristiga placeringar', 'OvrigaKortfristigaPlaceringar'),
    subtotal('Summa kortfristiga placeringar', 'KortfristigaPlaceringar', 'kortfristigaPlaceringar'),
  ),
  subsection('Kassa och bank'),
  post('Kassa och bank', 'KassaBankExklRedovisningsmedel', { alwaysShow: true }),
  post('Redovisningsmedel', 'Redovisningsmedel'),
  subtotal('Summa kassa och bank', 'KassaBank', 'kassaBank'),
  subtotal('Summa omsättningstillgångar', 'Omsattningstillgangar', 'omsattningstillgangar'),
  grandTotal('Summa tillgångar', 'Tillgangar', 'tillgangar'),
]

export const K3_BALANSRAKNING_EGET_KAPITAL_SKULDER: StatementNode[] = [
  section('Eget kapital'),
  subsection('Bundet eget kapital'),
  post('Aktiekapital', 'Aktiekapital', { alwaysShow: true }),
  post('Ej registrerat aktiekapital', 'EjRegistreratAktiekapital'),
  post('Bunden överkursfond', 'OverkursfondBunden'),
  post('Uppskrivningsfond', 'Uppskrivningsfond'),
  post('Reservfond', 'Reservfond'),
  post('Fond för utvecklingsutgifter', 'FondUtvecklingsutgifter'),
  subtotal('Summa bundet eget kapital', 'BundetEgetKapital', 'bundetEgetKapital'),
  subsection('Fritt eget kapital'),
  post('Överkursfond', 'Overkursfond'),
  post('Fond för verkligt värde', 'FondVerkligtVarde'),
  post('Balanserat resultat', 'BalanseratResultat', { alwaysShow: true }),
  post('Årets resultat', 'AretsResultatEgetKapital', { alwaysShow: true }),
  subtotal('Summa fritt eget kapital', 'FrittEgetKapital', 'frittEgetKapital'),
  subtotal('Summa eget kapital', 'EgetKapital', 'egetKapital'),
  group(
    'obeskattadeReserver',
    section('Obeskattade reserver'),
    post('Periodiseringsfonder', 'Periodiseringsfonder'),
    post('Ackumulerade överavskrivningar', 'AckumuleradeOveravskrivningar'),
    post('Andra obeskattade reserver', 'AndraObeskattadeReserver'),
    subtotal('Summa obeskattade reserver', 'ObeskattadeReserver', 'obeskattadeReserver'),
  ),
  group(
    'avsattningar',
    section('Avsättningar'),
    post('Avsättningar för pensioner och liknande förpliktelser enligt lag', 'AvsattningarPensionerLiknandeForpliktelserEnligtLag'),
    post('Övriga avsättningar för pensioner och liknande förpliktelser', 'OvrigaAvsattningarPensionerLiknandeForpliktelser'),
    post('Avsättningar för uppskjutna skatter', 'UppskjutenSkatteskuld'),
    post('Avsättningar för övriga skatter', 'AvsattningarOvrigSkatt'),
    post('Övriga avsättningar', 'OvrigaAvsattningar'),
    subtotal('Summa avsättningar', 'Avsattningar', 'avsattningar'),
  ),
  group(
    'langfristigaSkulder',
    section('Långfristiga skulder'),
    post('Obligationslån', 'Obligationslan'),
    post('Checkräkningskredit', 'CheckrakningskreditLangfristig'),
    post('Övriga skulder till kreditinstitut', 'OvrigaLangfristigaSkulderKreditinstitut'),
    post('Skulder till koncernföretag', 'SkulderKoncernforetagLangfristiga'),
    post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga'),
    post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseLangfristiga'),
    post('Övriga skulder', 'OvrigaLangfristigaSkulder'),
    subtotal('Summa långfristiga skulder', 'LangfristigaSkulder', 'langfristigaSkulder'),
  ),
  section('Kortfristiga skulder'),
  post('Checkräkningskredit', 'CheckrakningskreditKortfristig'),
  post('Övriga skulder till kreditinstitut', 'OvrigaKortfristigaSkulderKreditinstitut'),
  post('Förskott från kunder', 'ForskottFranKunder'),
  post('Pågående arbete för annans räkning', 'PagaendeArbetenAnnansRakningKortfristigaSkulder'),
  post('Leverantörsskulder', 'Leverantorsskulder', { alwaysShow: true }),
  post('Växelskulder', 'Vaxelskulder'),
  post('Skulder till koncernföretag', 'SkulderKoncernforetagKortfristiga'),
  post('Skulder till intresseföretag och gemensamt styrda företag', 'SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga'),
  post('Skulder till övriga företag som det finns ett ägarintresse i', 'SkulderOvrigaForetagAgarintresseKortfristiga'),
  post('Skatteskulder', 'Skatteskulder'),
  post('Övriga skulder', 'OvrigaKortfristigaSkulder', { alwaysShow: true }),
  post('Fakturerad men ej upparbetad intäkt', 'FaktureradEjUpparbetadIntakt'),
  post('Upplupna kostnader och förutbetalda intäkter', 'UpplupnaKostnaderForutbetaldaIntakter'),
  subtotal('Summa kortfristiga skulder', 'KortfristigaSkulder', 'kortfristigaSkulder'),
  grandTotal('Summa eget kapital och skulder', 'EgetKapitalSkulder', 'egetKapitalSkulder'),
]

/** Every concept a row list tags, for registry checks in tests. */
export function statementConcepts(rows: readonly StatementNode[]): string[] {
  return rows.flatMap((row) =>
    row.kind === 'group' ? statementConcepts(row.children) : row.kind === 'heading' ? [] : [row.concept],
  )
}

/** Render a row list into table rows (empty strings dropped by the caller). */
export function renderStatementRows(
  writer: FactWriter,
  rows: readonly StatementNode[],
  amounts: ConceptAmounts,
  totals: K2MappingResult['totals'],
  ctx: { current: string; previous: string | null },
): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.kind === 'heading') {
      out.push(sectionRow(row.label, row.level))
    } else if (row.kind === 'post') {
      out.push(
        moneyRow(writer, row.label, row.concept, amounts[row.concept], ctx, {
          indent: row.indent,
          displayMinus: row.displayMinus,
          alwaysShow: row.alwaysShow,
        }),
      )
    } else if (row.kind === 'sum') {
      out.push(
        moneyRow(writer, row.label, row.concept, totals[row.total], ctx, {
          rowClass: row.rowClass,
          displayMinus: row.displayMinus,
          alwaysShow: true,
        }),
      )
    } else {
      const total = totals[row.showIf]
      if (total.current !== 0 || (total.previous ?? 0) !== 0) {
        out.push(...renderStatementRows(writer, row.children, amounts, totals, ctx))
      }
    }
  }
  return out
}

/** Header row: title and the two column labels. */
export function statementHead(title: string, current: string, previous: string): string {
  return el(
    'tr',
    {},
    el('th', {}, escapeText(title)) +
      el('th', { class: 'num' }, escapeText(current)) +
      el('th', { class: 'num' }, previous ? escapeText(previous) : ''),
  )
}
