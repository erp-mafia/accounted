/**
 * Golden tests against the official Bolagsverket/taxonomier.se example
 * documents in dev_docs/bokslut/exempel/. They pin our generator's
 * conventions (context naming, entity scheme, fact attributes, hidden
 * vallistor, fastställelseintyg structure) to what a known-accepted filing
 * actually looks like.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRegistry } from '../taxonomy/registry'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { makeInput } from './fixtures'

const EXEMPEL_PATH = resolve(
  __dirname,
  '../../../../dev_docs/bokslut/exempel/k2/faststalld-arsredovisning-exempel-1-rev20240214.xhtml',
)
const official = readFileSync(EXEMPEL_PATH, 'utf8')
const generated = generateK2IxbrlDocument(makeInput()).xhtml

function factNames(xhtml: string): Set<string> {
  const names = new Set<string>()
  for (const match of xhtml.matchAll(/<ix:(?:nonFraction|nonNumeric|tuple) [^>]*name="([\w:-]+)"/g)) {
    names.add(match[1])
  }
  return names
}

describe('golden: official K2 exempel-1', () => {
  it('every concept the official example tags exists in our 2024-09-12 registry, modulo known removals', () => {
    const registry = getRegistry('k2-ab-2024-09-12')
    const missing: string[] = []
    for (const qname of factNames(official)) {
      const local = qname.split(':')[1]
      if (!registry.concepts[local]) missing.push(qname)
    }
    // The official example targets the 2021-10-31 taxonomy. Exactly two of
    // its concepts were removed in 2024-09-12 (verified against the element
    // list): the equity-change total now reuses EgetKapital, and the
    // underskrift-ort concept was dropped with BFN's updated signing rules.
    // Our generator accounts for both. Anything beyond these two means the
    // registry lost coverage: investigate before widening this list.
    expect(missing.sort()).toEqual([
      'se-gen-base:ForandringEgetKapitalTotalt',
      'se-gen-base:UndertecknandeArsredovisningOrt',
    ])
  })

  it('our generated document follows the official context conventions', () => {
    for (const fragment of [
      '<xbrli:identifier scheme="http://www.bolagsverket.se">',
      '<xbrli:context id="period0">',
      '<xbrli:context id="balans0">',
      '<xbrli:unit id="SEK">',
      '<xbrli:measure>iso4217:SEK</xbrli:measure>',
    ]) {
      expect(official).toContain(fragment)
      expect(generated).toContain(fragment)
    }
  })

  it('our hidden vallista set matches the official example for a standard AB', () => {
    const officialHidden =
      official.match(/<ix:hidden>([\s\S]*?)<\/ix:hidden>/)?.[1] ?? ''
    for (const concept of [
      'se-cd-base:SprakHandlingUpprattadList',
      'se-cd-base:LandForetagetsSateList',
      'se-cd-base:RedovisningsvalutaHandlingList',
      'se-cd-base:BeloppsformatList',
      'se-gen-base:FinansiellRapportList',
      'se-cd-base:RakenskapsarForstaDag',
      'se-cd-base:RakenskapsarSistaDag',
    ]) {
      expect(officialHidden).toContain(concept)
      expect(generated).toContain(concept)
    }
  })

  it('our fastställelseintyg structure mirrors the official one', () => {
    for (const fragment of [
      'se-bol-base:ArsstammaIntygande',
      'se-bol-base:FaststallelseResultatBalansrakning',
      'se-bol-base:Arsstamma',
      'se-bol-base:IntygandeOriginalInnehall',
      'se-bol-base:UnderskriftFaststallelseintygElektroniskt',
      'se-bol-base:UnderskriftFaststallelseintygForetradareTilltalsnamn',
      'se-bol-base:UnderskriftFastallelseintygDatum',
      'ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG',
    ]) {
      expect(official).toContain(fragment)
      expect(generated).toContain(fragment)
    }
    // Same continuation pattern joining intygande + original-innehåll.
    expect(official).toMatch(/continuedAt="intygande_forts"/)
    expect(generated).toMatch(/continuedAt="intygande_forts"/)
  })

  it('shared monetary facts carry the same attribute conventions as the official file', () => {
    // Official: <ix:nonFraction contextRef=… name=… unitRef="SEK" … format="ixt:numspacecomma">
    const officialNetto = official.match(
      /<ix:nonFraction[^>]*name="se-gen-base:Nettoomsattning"[^>]*>/,
    )?.[0]
    const generatedNetto = generated.match(
      /<ix:nonFraction[^>]*name="se-gen-base:Nettoomsattning"[^>]*>/,
    )?.[0]
    expect(officialNetto).toBeDefined()
    expect(generatedNetto).toBeDefined()
    for (const attr of ['unitRef="SEK"', 'format="ixt:numspacecomma"']) {
      expect(officialNetto).toContain(attr)
      expect(generatedNetto).toContain(attr)
    }
    // The official RR shows costs with the minus OUTSIDE the fact element and
    // no sign attribute: verify we do the same for Personalkostnader.
    expect(official).toMatch(/-<ix:nonFraction[^>]*name="se-gen-base:Personalkostnader"/)
    expect(generated).toMatch(/−<ix:nonFraction[^>]*name="se-gen-base:Personalkostnader"/)
    expect(generated).not.toMatch(/name="se-gen-base:Personalkostnader"[^>]*sign=/)
  })

  it('underskrifter use the same tuple + member concepts as the official file', () => {
    for (const fragment of [
      'se-gaap-ext:UnderskriftArsredovisningForetradareTuple',
      'se-gen-base:UnderskriftHandlingTilltalsnamn',
      'se-gen-base:UnderskriftHandlingEfternamn',
      'se-gen-base:UnderskriftHandlingRoll',
    ]) {
      expect(official).toContain(fragment)
      expect(generated).toContain(fragment)
    }
  })
})
