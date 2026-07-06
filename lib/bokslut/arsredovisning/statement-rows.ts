/**
 * ÅRL uppställningsform presentation rows for the årsredovisning PDF.
 *
 * Derives post-level RR/BR rows from the same K2 risbs mapping that drives
 * the iXBRL filing (lib/bokslut/ixbrl/k2-mapper.ts), so the human-readable
 * PDF and the digitally filed document cannot diverge. Labels and row order
 * mirror lib/bokslut/ixbrl/document/k2-document.ts.
 *
 * Account numbers must never appear in these labels — Bolagsverket rejects
 * balans- och resultaträkningar that contain kontonummer; the statutory
 * uppställningsform (ÅRL bilaga 1–2) knows only posts, never BAS accounts.
 *
 * Sign conventions match the iXBRL document layer: every ConceptAmount is
 * oriented to the concept's natural balance, and cost/deduction posts get a
 * presentational minus (`displayMinus`) so the RR reads top-to-bottom as
 * intäkter − kostnader = resultat.
 */

import type { ConceptAmount } from '@/lib/bokslut/ixbrl/types'
import type { K2MappingResult } from '@/lib/bokslut/ixbrl/k2-mapper'
import type { StatementRow } from './types'

const ZERO: ConceptAmount = { current: 0, previous: null }

function hasValue(amount: ConceptAmount): boolean {
  return amount.current !== 0 || (amount.previous ?? 0) !== 0
}

interface RowOptions {
  indent?: number
  /** Presentational minus — show cost posts as negative. */
  displayMinus?: boolean
  /** Emit the row even when zero in both years (statutory always-visible posts). */
  alwaysShow?: boolean
}

class RowBuilder {
  readonly rows: StatementRow[] = []

  constructor(private readonly hasPrevious: boolean) {}

  heading(label: string, indent = 0): void {
    this.rows.push({ label, current: null, previous: null, is_heading: true, indent })
  }

  post(label: string, amount: ConceptAmount | undefined, opts: RowOptions = {}): void {
    const value = amount ?? ZERO
    if (!opts.alwaysShow && !hasValue(value)) return
    this.rows.push(this.buildAmountRow(label, value, opts, false))
  }

  total(label: string, amount: ConceptAmount, opts: RowOptions = {}): void {
    this.rows.push(this.buildAmountRow(label, amount, opts, true))
  }

  private buildAmountRow(
    label: string,
    amount: ConceptAmount,
    opts: RowOptions,
    isTotal: boolean,
  ): StatementRow {
    const sign = opts.displayMinus ? -1 : 1
    return {
      label,
      current: sign * amount.current,
      previous: this.hasPrevious ? sign * (amount.previous ?? 0) : null,
      ...(isTotal ? { is_total: true } : {}),
      ...(opts.indent ? { indent: opts.indent } : {}),
    }
  }
}

/** The mapper leaves `previous` null on every concept when the company has
 *  no previous fiscal year; any concept with a number means a jämförelseår
 *  exists. */
function mappingHasPrevious(mapping: K2MappingResult): boolean {
  return mapping.totals.tillgangar.previous !== null
}

/**
 * Resultaträkning — kostnadsslagsindelad per ÅRL bilaga 2 / K2 risbs, in
 * uppställningsform order.
 */
export function buildRrRows(mapping: K2MappingResult): StatementRow[] {
  const { rr, totals } = mapping
  const b = new RowBuilder(mappingHasPrevious(mapping))

  b.heading('Rörelseintäkter, lagerförändringar m.m.')
  b.post('Nettoomsättning', rr['Nettoomsattning'], { indent: 1, alwaysShow: true })
  b.post(
    'Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning',
    rr['ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning'],
    { indent: 1 },
  )
  b.post('Aktiverat arbete för egen räkning', rr['AktiveratArbeteEgenRakning'], { indent: 1 })
  b.post('Övriga rörelseintäkter', rr['OvrigaRorelseintakter'], { indent: 1 })
  b.total('Summa rörelseintäkter, lagerförändringar m.m.', totals.rorelseintakter)

  b.heading('Rörelsekostnader')
  const cost = (label: string, concept: string): void =>
    b.post(label, rr[concept], { indent: 1, displayMinus: true })
  cost('Råvaror och förnödenheter', 'RavarorFornodenheterKostnader')
  cost('Handelsvaror', 'HandelsvarorKostnader')
  cost('Övriga externa kostnader', 'OvrigaExternaKostnader')
  cost('Personalkostnader', 'Personalkostnader')
  cost(
    'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
    'AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar',
  )
  cost(
    'Nedskrivningar av omsättningstillgångar utöver normala nedskrivningar',
    'NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar',
  )
  cost('Övriga rörelsekostnader', 'OvrigaRorelsekostnader')
  b.total('Summa rörelsekostnader', totals.rorelsekostnader, { displayMinus: true })
  b.total('Rörelseresultat', totals.rorelseresultat)

  b.heading('Finansiella poster')
  b.post('Resultat från andelar i koncernföretag', rr['ResultatAndelarKoncernforetag'], {
    indent: 1,
  })
  b.post(
    'Resultat från andelar i intresseföretag och gemensamt styrda företag',
    rr['ResultatAndelarIntresseforetagGemensamtStyrda'],
    { indent: 1 },
  )
  b.post(
    'Resultat från övriga företag som det finns ett ägarintresse i',
    rr['ResultatOvrigaforetagAgarintresse'],
    { indent: 1 },
  )
  b.post(
    'Resultat från övriga finansiella anläggningstillgångar',
    rr['ResultatOvrigaFinansiellaAnlaggningstillgangar'],
    { indent: 1 },
  )
  b.post(
    'Övriga ränteintäkter och liknande resultatposter',
    rr['OvrigaRanteintakterLiknandeResultatposter'],
    { indent: 1 },
  )
  b.post(
    'Nedskrivningar av finansiella anläggningstillgångar och kortfristiga placeringar',
    rr['NedskrivningarFinansiellaAnlaggningstillgangarKortfristigaPlaceringar'],
    { indent: 1, displayMinus: true },
  )
  b.post(
    'Räntekostnader och liknande resultatposter',
    rr['RantekostnaderLiknandeResultatposter'],
    { indent: 1, displayMinus: true },
  )
  b.total('Summa finansiella poster', totals.finansiellaPoster)
  b.total('Resultat efter finansiella poster', totals.resultatEfterFinansiellaPoster)

  if (hasValue(totals.bokslutsdispositioner)) {
    b.heading('Bokslutsdispositioner')
    b.post('Erhållna koncernbidrag', rr['ErhallnaKoncernbidrag'], { indent: 1 })
    b.post('Lämnade koncernbidrag', rr['LamnadeKoncernbidrag'], {
      indent: 1,
      displayMinus: true,
    })
    b.post('Förändring av periodiseringsfonder', rr['ForandringPeriodiseringsfond'], {
      indent: 1,
    })
    b.post('Förändring av överavskrivningar', rr['ForandringOveravskrivningar'], { indent: 1 })
    b.post('Övriga bokslutsdispositioner', rr['OvrigaBokslutsdispositioner'], { indent: 1 })
    b.total('Summa bokslutsdispositioner', totals.bokslutsdispositioner)
  }
  b.total('Resultat före skatt', totals.resultatForeSkatt)

  b.heading('Skatter')
  b.post('Skatt på årets resultat', rr['SkattAretsResultat'], { indent: 1, displayMinus: true })
  b.post('Övriga skatter', rr['OvrigaSkatter'], { indent: 1, displayMinus: true })
  b.total('Årets resultat', totals.aretsResultat)

  return b.rows
}

/**
 * Balansräkning per ÅRL bilaga 1 / K2 risbs. Subsections whose total is zero
 * in both years are omitted entirely (matching the iXBRL document layer);
 * kortfristiga fordringar, kassa och bank, eget kapital and kortfristiga
 * skulder always render.
 */
export function buildBrRows(mapping: K2MappingResult): {
  assets: StatementRow[]
  equityLiabilities: StatementRow[]
} {
  const { br, totals } = mapping
  const hasPrevious = mappingHasPrevious(mapping)

  const a = new RowBuilder(hasPrevious)
  a.post('Tecknat men ej inbetalt kapital', br['TecknatEjInbetaltKapital'])
  a.heading('Anläggningstillgångar')
  if (hasValue(totals.immateriellaAnlaggningstillgangar)) {
    a.heading('Immateriella anläggningstillgångar', 1)
    a.post(
      'Koncessioner, patent, licenser, varumärken samt liknande rättigheter',
      br['KoncessionerPatentLicenserVarumarkenLiknandeRattigheter'],
      { indent: 2 },
    )
    a.post('Hyresrätter och liknande rättigheter', br['HyresratterLiknandeRattigheter'], {
      indent: 2,
    })
    a.post('Goodwill', br['Goodwill'], { indent: 2 })
    a.post(
      'Förskott avseende immateriella anläggningstillgångar',
      br['ForskottImmateriellaAnlaggningstillgangar'],
      { indent: 2 },
    )
    a.total(
      'Summa immateriella anläggningstillgångar',
      totals.immateriellaAnlaggningstillgangar,
      { indent: 1 },
    )
  }
  if (hasValue(totals.materiellaAnlaggningstillgangar)) {
    a.heading('Materiella anläggningstillgångar', 1)
    a.post('Byggnader och mark', br['ByggnaderMark'], { indent: 2 })
    a.post(
      'Maskiner och andra tekniska anläggningar',
      br['MaskinerAndraTekniskaAnlaggningar'],
      { indent: 2 },
    )
    a.post(
      'Inventarier, verktyg och installationer',
      br['InventarierVerktygInstallationer'],
      { indent: 2 },
    )
    a.post(
      'Förbättringsutgifter på annans fastighet',
      br['ForbattringsutgifterAnnansFastighet'],
      { indent: 2 },
    )
    a.post(
      'Övriga materiella anläggningstillgångar',
      br['OvrigaMateriellaAnlaggningstillgangar'],
      { indent: 2 },
    )
    a.post(
      'Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar',
      br['PagaendeNyanlaggningarForskottMateriellaAnlaggningstillgangar'],
      { indent: 2 },
    )
    a.total('Summa materiella anläggningstillgångar', totals.materiellaAnlaggningstillgangar, {
      indent: 1,
    })
  }
  if (hasValue(totals.finansiellaAnlaggningstillgangar)) {
    a.heading('Finansiella anläggningstillgångar', 1)
    a.post('Andelar i koncernföretag', br['AndelarKoncernforetag'], { indent: 2 })
    a.post('Fordringar hos koncernföretag', br['FordringarKoncernforetagLangfristiga'], {
      indent: 2,
    })
    a.post(
      'Andelar i intresseföretag och gemensamt styrda företag',
      br['AndelarIntresseforetagGemensamtStyrdaForetag'],
      { indent: 2 },
    )
    a.post(
      'Fordringar hos intresseföretag och gemensamt styrda företag',
      br['FordringarIntresseforetagGemensamtStyrdaForetagLangfristiga'],
      { indent: 2 },
    )
    a.post('Ägarintressen i övriga företag', br['AgarintressenOvrigaForetag'], { indent: 2 })
    a.post(
      'Fordringar hos övriga företag som det finns ett ägarintresse i',
      br['FordringarOvrigaForetagAgarintresseLangfristiga'],
      { indent: 2 },
    )
    a.post(
      'Andra långfristiga värdepappersinnehav',
      br['AndraLangfristigaVardepappersinnehav'],
      { indent: 2 },
    )
    a.post('Lån till delägare eller närstående', br['LanDelagareNarstaende'], { indent: 2 })
    a.post('Andra långfristiga fordringar', br['AndraLangfristigaFordringar'], { indent: 2 })
    a.total(
      'Summa finansiella anläggningstillgångar',
      totals.finansiellaAnlaggningstillgangar,
      { indent: 1 },
    )
  }
  a.total('Summa anläggningstillgångar', totals.anlaggningstillgangar)

  a.heading('Omsättningstillgångar')
  if (hasValue(totals.varulager)) {
    a.heading('Varulager m.m.', 1)
    a.post('Råvaror och förnödenheter', br['LagerRavarorFornodenheter'], { indent: 2 })
    a.post('Varor under tillverkning', br['LagerVarorUnderTillverkning'], { indent: 2 })
    a.post('Färdiga varor och handelsvaror', br['LagerFardigaVarorHandelsvaror'], { indent: 2 })
    a.post(
      'Pågående arbete för annans räkning',
      br['PagaendeArbetenAnnansRakningOmsattningstillgangar'],
      { indent: 2 },
    )
    a.post('Förskott till leverantörer', br['ForskottTillLeverantorer'], { indent: 2 })
    a.post('Övriga lagertillgångar', br['OvrigaLagertillgangar'], { indent: 2 })
    a.total('Summa varulager m.m.', totals.varulager, { indent: 1 })
  }
  a.heading('Kortfristiga fordringar', 1)
  a.post('Kundfordringar', br['Kundfordringar'], { indent: 2 })
  a.post('Fordringar hos koncernföretag', br['FordringarKoncernforetagKortfristiga'], {
    indent: 2,
  })
  a.post(
    'Fordringar hos intresseföretag och gemensamt styrda företag',
    br['FordringarIntresseforetagGemensamtStyrdaForetagKortfristiga'],
    { indent: 2 },
  )
  a.post(
    'Fordringar hos övriga företag som det finns ett ägarintresse i',
    br['FordringarOvrigaforetagAgarintresseKortfristiga'],
    { indent: 2 },
  )
  a.post('Övriga fordringar', br['OvrigaFordringarKortfristiga'], {
    indent: 2,
    alwaysShow: true,
  })
  a.post('Upparbetad men ej fakturerad intäkt', br['UpparbetadEjFaktureradIntakt'], {
    indent: 2,
  })
  a.post(
    'Förutbetalda kostnader och upplupna intäkter',
    br['ForutbetaldaKostnaderUpplupnaIntakter'],
    { indent: 2 },
  )
  a.total('Summa kortfristiga fordringar', totals.kortfristigaFordringar, { indent: 1 })
  if (hasValue(totals.kortfristigaPlaceringar)) {
    a.heading('Kortfristiga placeringar', 1)
    a.post('Andelar i koncernföretag', br['AndelarKoncernforetagKortfristiga'], { indent: 2 })
    a.post('Övriga kortfristiga placeringar', br['OvrigaKortfristigaPlaceringar'], {
      indent: 2,
    })
    a.total('Summa kortfristiga placeringar', totals.kortfristigaPlaceringar, { indent: 1 })
  }
  a.heading('Kassa och bank', 1)
  a.post('Kassa och bank', br['KassaBankExklRedovisningsmedel'], {
    indent: 2,
    alwaysShow: true,
  })
  a.post('Redovisningsmedel', br['Redovisningsmedel'], { indent: 2 })
  a.total('Summa kassa och bank', totals.kassaBank, { indent: 1 })
  a.total('Summa omsättningstillgångar', totals.omsattningstillgangar)
  a.total('Summa tillgångar', totals.tillgangar)

  const e = new RowBuilder(hasPrevious)
  e.heading('Eget kapital')
  e.heading('Bundet eget kapital', 1)
  e.post('Aktiekapital', br['Aktiekapital'], { indent: 2, alwaysShow: true })
  e.post('Ej registrerat aktiekapital', br['EjRegistreratAktiekapital'], { indent: 2 })
  e.post('Bunden överkursfond', br['OverkursfondBunden'], { indent: 2 })
  e.post('Uppskrivningsfond', br['Uppskrivningsfond'], { indent: 2 })
  e.post('Reservfond', br['Reservfond'], { indent: 2 })
  e.total('Summa bundet eget kapital', totals.bundetEgetKapital, { indent: 1 })
  e.heading('Fritt eget kapital', 1)
  e.post('Överkursfond', br['Overkursfond'], { indent: 2 })
  e.post('Balanserat resultat', br['BalanseratResultat'], { indent: 2, alwaysShow: true })
  e.post('Årets resultat', br['AretsResultatEgetKapital'], { indent: 2, alwaysShow: true })
  e.total('Summa fritt eget kapital', totals.frittEgetKapital, { indent: 1 })
  e.total('Summa eget kapital', totals.egetKapital)
  if (hasValue(totals.obeskattadeReserver)) {
    e.heading('Obeskattade reserver')
    e.post('Periodiseringsfonder', br['Periodiseringsfonder'], { indent: 1 })
    e.post('Ackumulerade överavskrivningar', br['AckumuleradeOveravskrivningar'], { indent: 1 })
    e.post('Övriga obeskattade reserver', br['OvrigaObeskattadeReserver'], { indent: 1 })
    e.total('Summa obeskattade reserver', totals.obeskattadeReserver)
  }
  if (hasValue(totals.avsattningar)) {
    e.heading('Avsättningar')
    e.post(
      'Avsättningar för pensioner och liknande förpliktelser enligt lag',
      br['AvsattningarPensionerLiknandeForpliktelserEnligtLag'],
      { indent: 1 },
    )
    e.post(
      'Övriga avsättningar för pensioner och liknande förpliktelser',
      br['OvrigaAvsattningarPensionerLiknandeForpliktelser'],
      { indent: 1 },
    )
    e.post('Övriga avsättningar', br['OvrigaAvsattningar'], { indent: 1 })
    e.total('Summa avsättningar', totals.avsattningar)
  }
  if (hasValue(totals.langfristigaSkulder)) {
    e.heading('Långfristiga skulder')
    e.post('Obligationslån', br['Obligationslan'], { indent: 1 })
    e.post('Checkräkningskredit', br['CheckrakningskreditLangfristig'], { indent: 1 })
    e.post(
      'Övriga skulder till kreditinstitut',
      br['OvrigaLangfristigaSkulderKreditinstitut'],
      { indent: 1 },
    )
    e.post('Skulder till koncernföretag', br['SkulderKoncernforetagLangfristiga'], {
      indent: 1,
    })
    e.post(
      'Skulder till intresseföretag och gemensamt styrda företag',
      br['SkulderIntresseforetagGemensamtStyrdaForetagLangfristiga'],
      { indent: 1 },
    )
    e.post(
      'Skulder till övriga företag som det finns ett ägarintresse i',
      br['SkulderOvrigaForetagAgarintresseLangfristiga'],
      { indent: 1 },
    )
    e.post('Övriga skulder', br['OvrigaLangfristigaSkulder'], { indent: 1 })
    e.total('Summa långfristiga skulder', totals.langfristigaSkulder)
  }
  e.heading('Kortfristiga skulder')
  e.post('Förskott från kunder', br['ForskottFranKunder'], { indent: 1 })
  e.post('Checkräkningskredit', br['CheckrakningskreditKortfristig'], { indent: 1 })
  e.post('Övriga skulder till kreditinstitut', br['OvrigaKortfristigaSkulderKreditinstitut'], {
    indent: 1,
  })
  e.post(
    'Pågående arbete för annans räkning',
    br['PagaendeArbetenAnnansRakningKortfristigaSkulder'],
    { indent: 1 },
  )
  e.post('Fakturerad men ej upparbetad intäkt', br['FaktureradEjUpparbetadIntakt'], {
    indent: 1,
  })
  e.post('Leverantörsskulder', br['Leverantorsskulder'], { indent: 1, alwaysShow: true })
  e.post('Växelskulder', br['Vaxelskulder'], { indent: 1 })
  e.post('Skulder till koncernföretag', br['SkulderKoncernforetagKortfristiga'], { indent: 1 })
  e.post(
    'Skulder till intresseföretag och gemensamt styrda företag',
    br['SkulderIntresseforetagGemensamtStyrdaForetagKortfristiga'],
    { indent: 1 },
  )
  e.post(
    'Skulder till övriga företag som det finns ett ägarintresse i',
    br['SkulderOvrigaForetagAgarintresseKortfristiga'],
    { indent: 1 },
  )
  e.post('Skatteskulder', br['Skatteskulder'], { indent: 1 })
  e.post('Övriga skulder', br['OvrigaKortfristigaSkulder'], { indent: 1, alwaysShow: true })
  e.post(
    'Upplupna kostnader och förutbetalda intäkter',
    br['UpplupnaKostnaderForutbetaldaIntakter'],
    { indent: 1 },
  )
  e.total('Summa kortfristiga skulder', totals.kortfristigaSkulder)
  e.total('Summa eget kapital och skulder', totals.egetKapitalSkulder)

  return { assets: a.rows, equityLiabilities: e.rows }
}
