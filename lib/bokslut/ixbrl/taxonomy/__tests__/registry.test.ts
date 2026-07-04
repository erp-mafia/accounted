import { describe, expect, it } from 'vitest'
import { getRegistry, getConcept, mustGetConcept } from '../registry'
import { getEntryPoint, resolveEntryPoint, K2_AB_RISBS_2024_09_12 } from '../entry-points'

describe('taxonomy registry (k2-ab-2024-09-12)', () => {
  const registry = getRegistry('k2-ab-2024-09-12')

  it('loads with the expected shape', () => {
    expect(registry._meta.taxonomy).toBe('k2-ab')
    expect(registry._meta.version).toBe('2024-09-12')
    expect(registry._meta.conceptCount).toBeGreaterThan(1000)
    expect(registry._meta.tupleCount).toBeGreaterThan(10)
  })

  it('exposes the RR risbs concepts with correct balance/period attributes', () => {
    const netto = mustGetConcept(registry, 'Nettoomsattning')
    expect(netto.ns).toBe('se-gen-base')
    expect(netto.balance).toBe('credit')
    expect(netto.periodType).toBe('duration')
    expect(netto.dataType).toBe('xbrli:monetaryItemType')

    const personal = mustGetConcept(registry, 'Personalkostnader')
    expect(personal.balance).toBe('debit')

    const aretsResultat = mustGetConcept(registry, 'AretsResultat')
    expect(aretsResultat.balance).toBe('credit')
    expect(aretsResultat.sections).toContain('rr-kostnadsslagsindelad')
  })

  it('exposes the BR totals used by kontrollera rules 3001/3002', () => {
    const tillgangar = mustGetConcept(registry, 'Tillgangar')
    expect(tillgangar.periodType).toBe('instant')
    expect(tillgangar.balance).toBe('debit')

    const ekSkulder = mustGetConcept(registry, 'EgetKapitalSkulder')
    expect(ekSkulder.periodType).toBe('instant')
    expect(ekSkulder.balance).toBe('credit')
  })

  it('includes the fastställelseintyg concepts from comp-base (se-bol-base)', () => {
    for (const name of [
      'ArsstammaIntygande',
      'IntygandeOriginalInnehall',
      'UnderskriftFastallelseintygDatum',
      'Arsstamma',
      'FaststallelseResultatBalansrakning',
    ]) {
      const concept = mustGetConcept(registry, name)
      expect(concept.ns).toBe('se-bol-base')
    }
    // The signing-date element is instant (tagged against balans0).
    expect(mustGetConcept(registry, 'UnderskriftFastallelseintygDatum').periodType).toBe(
      'instant',
    )
  })

  it('models the underskrifter tuple with the per-signer date member', () => {
    const tuple = registry.tuples['UnderskriftArsredovisningForetradareTuple']
    expect(tuple).toBeDefined()
    expect(tuple.ns).toBe('se-gaap-ext')
    const memberNames = tuple.members.map((m) => m.name)
    expect(memberNames).toContain('UnderskriftHandlingTilltalsnamn')
    expect(memberNames).toContain('UnderskriftHandlingEfternamn')
    expect(memberNames).toContain('UnderskriftHandlingRoll')
    // TA §2.9.1: DatumForUndertecknande per signer: element name UndertecknandeDatum.
    expect(memberNames).toContain('UndertecknandeDatum')
  })

  it('exposes vallista concepts and their members', () => {
    expect(mustGetConcept(registry, 'SprakHandlingUpprattadList').dataType).toBe(
      'enum:enumerationItemType',
    )
    expect(getConcept(registry, 'SprakSvenskaMember')?.ns).toBe('se-mem-base')
  })

  it('throws on unknown concepts and registries', () => {
    expect(() => mustGetConcept(registry, 'PåhittatBegrepp')).toThrow(/not in taxonomy/)
    expect(() => getRegistry('k9-hund')).toThrow(/Unknown taxonomy registry/)
    expect(getConcept(registry, 'PåhittatBegrepp')).toBeNull()
  })
})

describe('entry points', () => {
  it('resolves the K2 AB risbs MVP entry point', () => {
    const ep = resolveEntryPoint('k2')
    expect(ep).toBe(K2_AB_RISBS_2024_09_12)
    expect(ep.schemaRefs[0]).toContain('k2-all/ab/risbs/2024-09-12')
    // Fastställelseintyg (certificate of adoption) schema must ride along.
    expect(ep.schemaRefs[1]).toContain('coa/rplc/2020-12-01')
    expect(getEntryPoint(ep.id)).toBe(ep)
  })

  it('keeps base-concept namespaces on the 2021-10-31 generation', () => {
    const ns = K2_AB_RISBS_2024_09_12.namespaces
    expect(ns['se-gen-base']).toBe('http://www.taxonomier.se/se/fr/gen-base/2021-10-31')
    expect(ns['se-bol-base']).toBe('http://www.bolagsverket.se/se/fr/comp-base/2020-12-01')
    expect(ns['se-gaap-ext']).toBe('http://www.taxonomier.se/se/fr/gaap/gaap-ext/2024-09-12')
  })

  it('rejects K3 with an actionable message', () => {
    expect(() => resolveEntryPoint('k3')).toThrow(/K3/)
  })
})
