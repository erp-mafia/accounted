/**
 * Golden tests against the official K3 example (taxonomier.se, fastställd
 * årsredovisning exempel 1, K3 risbs 2021-10-31) in
 * docs/reference/bokslut/exempel/k3/. They pin the K3 registry's coverage
 * and the K3 document's conventions to what a known-accepted K3 filing
 * looks like.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getRegistry } from '../taxonomy/registry'
import { generateK3IxbrlDocument } from '../document/k3-document'
import { makeK3Input } from './fixtures'

const EXEMPEL_PATH = resolve(
  __dirname,
  '../../../../../docs/reference/bokslut/exempel/k3/faststalld-arsredovisning-exempel-1-rev20240214.xhtml',
)
const official = readFileSync(EXEMPEL_PATH, 'utf8')
const input = makeK3Input()
input.revisorspateckning = {
  required: true,
  revisionsbolag: 'Revisionsbyrån AB',
  opinion: 'unmodified',
  revisorer: [
    { firstName: 'Rita', lastName: 'Revisor', titel: 'Auktoriserad revisor', huvudansvarig: true, signedDate: '2026-02-21' },
  ],
}
const generated = generateK3IxbrlDocument(input).xhtml

function factNames(xhtml: string): Set<string> {
  const names = new Set<string>()
  for (const match of xhtml.matchAll(/<ix:(?:nonFraction|nonNumeric|tuple) [^>]*name="([\w:-]+)"/g)) {
    names.add(match[1])
  }
  return names
}

/** The first opening tag of a fact, attributes in any order. */
function factTag(xhtml: string, name: string): string | undefined {
  return xhtml.match(new RegExp(`<ix:nonFraction[^>]*name="${name}"[^>]*>`))?.[0]
}

describe('golden: official K3 exempel-1', () => {
  it('both reference the K3 risbs 2021-10-31 entry point', () => {
    const schemaRef = 'http://xbrl.taxonomier.se/se/fr/gaap/k3/risbs/2021-10-31/se-k3-risbs-2021-10-31.xsd'
    expect(official).toContain(schemaRef)
    expect(generated).toContain(schemaRef)
  })

  it('every K3 concept the official example tags exists in our K3 registry', () => {
    const registry = getRegistry('k3-ab-2021-10-31')
    // se-misc-base is the separate "race" taxonomy for information outside
    // the årsredovisning taxonomy; the K3 document never uses it.
    const missing = [...factNames(official)]
      .filter((qname) => !qname.startsWith('se-misc-base:'))
      .filter((qname) => !registry.concepts[qname.split(':')[1]])
    expect(missing).toEqual([])
  })

  it('declares the K3 units the way the official example does', () => {
    for (const unit of ['SEK', 'antal-personer']) {
      expect(official).toMatch(new RegExp(`<xbrli:unit id="${unit}">`))
      expect(generated).toMatch(new RegExp(`<xbrli:unit id="${unit}">`))
    }
    expect(official).toContain('se-k3-type:AntalPersoner')
    expect(generated).toContain('se-k3-type:AntalPersoner')
    expect(factTag(official, 'se-gen-base:MedelantaletAnstallda')).toContain('unitRef="antal-personer"')
    expect(factTag(generated, 'se-gen-base:MedelantaletAnstallda')).toContain('unitRef="antal-personer"')
  })

  it('states the unit with MatEnhet and no Beloppsformat vallista', () => {
    expect(official).toContain('se-cd-base:MatEnhet')
    expect(generated).toContain('se-cd-base:MatEnhet')
    expect(official).not.toContain('BeloppsformatList')
    expect(generated).not.toContain('BeloppsformatList')
  })

  it('tags "Minskning av kassaflöde …" positive with the minus outside the element', () => {
    expect(official).toMatch(/-<ix:nonFraction[^>]*name="se-gen-base:ErlagdRanta"/)
    expect(generated).toMatch(/−<ix:nonFraction[^>]*name="se-gen-base:ErlagdRanta"/)
    expect(factTag(official, 'se-gen-base:ErlagdRanta')).not.toContain('sign=')
    expect(factTag(generated, 'se-gen-base:ErlagdRanta')).not.toContain('sign=')
  })

  it('tags the equity movement out of årets resultat with sign="-", as the official example does', () => {
    const name = 'se-gen-base:ForandringEgetKapitalAretsResultatBalanserasNyRakning'
    expect(factTag(official, name)).toContain('sign="-"')
    expect(factTag(generated, name)).toContain('sign="-"')
    for (const total of ['se-gen-base:ForandringEgetKapitalTotaltBalanserasNyRakning', 'se-gen-base:ForandringEgetKapitalBalanseratResultatBalanserasNyRakning']) {
      expect(official).toContain(total)
      expect(generated).toContain(total)
    }
  })

  it('tags likvida medel in the kassaflödesanalys as balances (balans contexts)', () => {
    for (const xhtml of [official, generated]) {
      expect(xhtml).toMatch(/contextRef="balans1" name="se-gen-base:LikvidaMedel"/)
      expect(xhtml).toMatch(/contextRef="balans0" name="se-gen-base:LikvidaMedel"/)
    }
  })

  it('uses the same revisorspåteckning concepts as the official example', () => {
    for (const fragment of [
      'se-gaap-ext:UnderskriftRevisorspateckningTuple',
      'se-gen-base:RevisorspateckningRevisionsberattelseEnligtStandardutformning',
      'se-cd-base:ValtRevisionsbolagsnamn',
      'se-gen-base:UnderskriftHandlingTitel',
    ]) {
      expect(official).toContain(fragment)
      expect(generated).toContain(fragment)
    }
  })
})
