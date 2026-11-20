import { describe, expect, it } from 'vitest'
import { getConcept, getRegistry, mustGetConcept } from '../registry'
import { getEntryPoint, K2_AB_RISBS_2024_09_12, K3_AB_RISBS_2021_10_31 } from '../entry-points'
import { FactWriter } from '../../document/ix'

/**
 * The K3 AB registry is generated from the 2026-08-31 taxonomy package: its
 * membership is the presentation linkbases of the forms the K3 risbs entry
 * point imports. The K3 forms have no calculation linkbases, so this
 * membership is what keeps a K2 concept, or a form the entry point does not
 * use, out of a K3 document (mustGetConcept throws).
 */
describe('taxonomy registry (k3-ab-2021-10-31, rev 2026-08-31)', () => {
  const registry = getRegistry('k3-ab-2021-10-31')

  it('loads with the expected shape and the risbs forms', () => {
    expect(registry._meta.taxonomy).toBe('k3-ab')
    expect(registry._meta.version).toBe('2021-10-31')
    expect(registry._meta.revision).toBe('2026-08-31')
    expect(registry._meta.forms).toEqual(['fcd', 'fdr', 'fscie', 'fisbn', 'fbs', 'fcf', 'fdisc', 'fsign'])
    expect(registry._meta.conceptCount).toBeGreaterThan(1500)
  })

  it('keeps the K2-only concepts out (the six renames)', () => {
    for (const k2Only of [
      'AllmantVerksamheten',
      'VasentligaHandelserRakenskapsaret',
      'ForskottImmateriellaAnlaggningstillgangar',
      'OvrigaObeskattadeReserver',
      'BeloppsformatList',
      'UndertecknandeArsredovisningOrt',
    ]) {
      expect(getConcept(registry, k2Only), k2Only).toBeNull()
      expect(() => mustGetConcept(registry, k2Only)).toThrow(/not in taxonomy k3-ab/)
    }
    for (const k3Name of [
      'VerksamhetenArtInriktning',
      'ViktigaForhallandenVasentligaHandelser',
      'PagaendeUtvecklingsarbetenForskottImmateriellaAnlaggningstillgangar',
      'AndraObeskattadeReserver',
      'AndraBokslutsdispositioner',
    ]) {
      expect(getConcept(registry, k3Name), k3Name).not.toBeNull()
    }
    // The RR's "Övriga bokslutsdispositioner" row is AndraBokslutsdispositioner
    // under K3; the K2 name survives only inside a note.
    expect(mustGetConcept(registry, 'AndraBokslutsdispositioner').sections).toContain('fisbn')
    expect(mustGetConcept(registry, 'OvrigaBokslutsdispositioner').sections).toEqual(['fdisc'])
  })

  it('keeps the forms the risbs entry point does not import out', () => {
    // Funktionsindelad resultaträkning (fisbf) and the förkortade forms are
    // other K3 entry points.
    expect(getConcept(registry, 'BruttoresultatFunktionsindelad')).toBeNull()
    expect(getConcept(registry, 'KostnadSaldaVaror')).toBeNull()
  })

  it('carries the attributes from the schemas', () => {
    const netto = mustGetConcept(registry, 'Nettoomsattning')
    expect(netto).toMatchObject({ ns: 'se-gen-base', balance: 'credit', periodType: 'duration', dataType: 'xbrli:monetaryItemType' })
    expect(netto.label).toBe('Nettoomsättning')
    expect(netto.sections).toEqual(expect.arrayContaining(['fisbn', 'fdr']))
    expect(mustGetConcept(registry, 'Tillgangar')).toMatchObject({ balance: 'debit', periodType: 'instant' })
    expect(mustGetConcept(registry, 'Soliditet').dataType).toBe('xbrli:pureItemType')
    expect(mustGetConcept(registry, 'MedelantaletAnstallda').dataType).toBe('xbrli:decimalItemType')
    expect(mustGetConcept(registry, 'FinansiellRapportList').dataType).toBe('enum:enumerationItemType')
    expect(mustGetConcept(registry, 'SprakSvenskaMember').ns).toBe('se-mem-base')
  })

  it('holds the equity statement, the cash flow and the K3 balance sheet posts', () => {
    expect(mustGetConcept(registry, 'ForandringEgetKapitalAktiekapitalNyemission').sections).toContain('fscie')
    expect(mustGetConcept(registry, 'ForandringEgetKapitalTotaltUtdelning').sections).toContain('fscie')
    expect(mustGetConcept(registry, 'KassaflodeLopandeVerksamheten').sections).toContain('fcf')
    expect(mustGetConcept(registry, 'LikvidaMedel').periodType).toBe('instant')
    expect(mustGetConcept(registry, 'FondUtvecklingsutgifter').sections).toContain('fbs')
    expect(mustGetConcept(registry, 'BalanseradeUtgifterUtvecklingsarbetenLiknandeArbeten').sections).toContain('fbs')
  })

  it('models the signature tuples, the revisorspåteckning included', () => {
    expect(registry.tuples['UnderskriftArsredovisningForetradareTuple'].members.map((m) => m.name)).toEqual([
      'UnderskriftHandlingTilltalsnamn',
      'UnderskriftHandlingEfternamn',
      'UnderskriftHandlingRoll',
      'UnderskriftArsredovisningForetradareAvvikandemening',
      'UndertecknandeDatum',
      'ForetraddJuridiskPersonAgareHandelsbolag',
    ])
    expect(registry.tuples['UnderskriftRevisorspateckningTuple'].members.map((m) => m.name)).toEqual([
      'UnderskriftHandlingTilltalsnamn',
      'UnderskriftHandlingEfternamn',
      'UnderskriftHandlingTitel',
      'UnderskriftRevisorspateckningRevisorHuvudansvarig',
    ])
    for (const name of [
      'RevisorspateckningRevisionsberattelseEnligtStandardutformning',
      'RevisorspateckningRevisionsberattelseAvvikerStandardutformning',
      'ValtRevisionsbolagsnamn',
    ]) {
      expect(getConcept(registry, name), name).not.toBeNull()
    }
  })

  it('makes every tuple member and tuple an emittable concept', () => {
    for (const [name, tuple] of Object.entries(registry.tuples)) {
      expect(mustGetConcept(registry, name).kind).toBe('tuple')
      for (const member of tuple.members) expect(getConcept(registry, member.name), member.name).not.toBeNull()
    }
  })

  it('includes the fastställelseintyg concepts with their enumerations', () => {
    expect(mustGetConcept(registry, 'ArsstammaIntygande').ns).toBe('se-bol-base')
    expect(mustGetConcept(registry, 'UnderskriftFaststallelseintygForetradareForetradarroll').enumeration).toContain(
      'Verkställande direktör',
    )
  })
})

describe('the K3 AB risbs entry point', () => {
  it('references the K3 risbs schema and the fastställelseintyg', () => {
    expect(getEntryPoint(K3_AB_RISBS_2021_10_31.id)).toBe(K3_AB_RISBS_2021_10_31)
    expect(K3_AB_RISBS_2021_10_31.schemaRefs).toEqual([
      'http://xbrl.taxonomier.se/se/fr/gaap/k3/risbs/2021-10-31/se-k3-risbs-2021-10-31.xsd',
      'http://xbrl.taxonomier.se/se/fr/gaap/coa/rplc/2020-12-01/se-coa-rplc-2020-12-01.xsd',
    ])
    expect(K3_AB_RISBS_2021_10_31.registryId).toBe('k3-ab-2021-10-31')
  })

  it('declares a namespace for every prefix its registry uses', () => {
    const registry = getRegistry(K3_AB_RISBS_2021_10_31.registryId)
    const prefixes = new Set(Object.values(registry.concepts).map((concept) => concept.ns))
    for (const prefix of prefixes) expect(K3_AB_RISBS_2021_10_31.namespaces[prefix], prefix).toBeDefined()
    expect(K3_AB_RISBS_2021_10_31.namespaces['se-gaap-ext']).toBe('http://www.taxonomier.se/se/fr/gaap/gaap-ext/2021-10-31')
  })

  it('declares the unit of the entry point the writer was made for', () => {
    const header = (entryPoint: typeof K3_AB_RISBS_2021_10_31) => {
      const writer = new FactWriter(entryPoint, getRegistry(entryPoint.registryId), '556999-9997')
      writer.addDurationContext('period0', '2026-01-01', '2026-12-31')
      const fact = writer.antalAnstallda('MedelantaletAnstallda', 'period0', 3)
      return { fact, header: writer.renderHeader() }
    }
    const k3 = header(K3_AB_RISBS_2021_10_31)
    expect(k3.fact).toContain('unitRef="antal-personer"')
    expect(k3.header).toContain('<xbrli:unit id="antal-personer"><xbrli:measure>se-k3-type:AntalPersoner</xbrli:measure></xbrli:unit>')
    const k2 = header(K2_AB_RISBS_2024_09_12)
    expect(k2.fact).toContain('unitRef="antal-anstallda"')
    expect(k2.header).toContain('<xbrli:unit id="antal-anstallda"><xbrli:measure>se-k2-type:AntalAnstallda</xbrli:measure></xbrli:unit>')
  })

  it('counts medelantal anställda in the K3 unit (official K3 example)', () => {
    expect(K3_AB_RISBS_2021_10_31.units.antalAnstallda).toEqual({ id: 'antal-personer', measure: 'se-k3-type:AntalPersoner' })
    expect(K3_AB_RISBS_2021_10_31.namespaces['se-k3-type']).toBe('http://www.taxonomier.se/se/fr/k3/datatype')
  })
})
