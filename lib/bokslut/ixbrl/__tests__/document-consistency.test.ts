/**
 * Mechanical guards for TA §2.7.3 (repeated facts must be value-identical:
 * Bolagsverket rejects inconsistent duplicates) and TA §3.2 (valid XHTML with
 * only the five XML escape entities).
 */

import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { makeInput } from './fixtures'
import type { IxbrlArsredovisningInput } from '../types'

/** Parse every ix:nonFraction into { name, contextRef, value } where value
 *  includes the sign attribute (the rendered text is always absolute). */
function numericFacts(
  xhtml: string,
): Array<{ name: string; contextRef: string; value: string }> {
  const facts: Array<{ name: string; contextRef: string; value: string }> = []
  for (const match of xhtml.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    const attrs = match[1]
    const name = attrs.match(/name="([^"]+)"/)?.[1] ?? ''
    const contextRef = attrs.match(/contextRef="([^"]+)"/)?.[1] ?? ''
    const sign = /sign="-"/.test(attrs) ? '-' : ''
    facts.push({ name, contextRef, value: `${sign}${match[2]}` })
  }
  return facts
}

function assertNoConflictingDuplicates(input: IxbrlArsredovisningInput): void {
  const { xhtml } = generateK2IxbrlDocument(input)
  const groups = new Map<string, Set<string>>()
  for (const fact of numericFacts(xhtml)) {
    const key = `${fact.name}@${fact.contextRef}`
    const values = groups.get(key) ?? new Set<string>()
    values.add(fact.value)
    groups.set(key, values)
  }
  expect(groups.size).toBeGreaterThan(0)
  const conflicts = [...groups.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([key, values]) => `${key}: ${[...values].join(' vs ')}`)
  expect(conflicts).toEqual([])
}

describe('duplicate-fact consistency (TA §2.7.3)', () => {
  it('every repeated name+context fact has exactly one distinct value (base fixture)', () => {
    assertNoConflictingDuplicates(makeInput())
  })

  it('… with a proposed dividend', () => {
    const input = makeInput()
    input.forvaltningsberattelse.resultatdisposition.utdelning = 50_000
    input.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = 170_000
    input.forvaltningsberattelse.egetKapital.utdelning = 50_000
    assertNoConflictingDuplicates(input)
  })

  it('… with fri överkursfond in BR, eget kapital and resultatdisposition', () => {
    const input = makeInput()
    input.br['Overkursfond'] = { current: 50_000, previous: 50_000 }
    // FrittEgetKapital is tagged both as the BR subtotal and the disposition
    // "Summa": keep the single source consistent like build-input does.
    input.totals.frittEgetKapital = { current: 270_000, previous: 150_000 }
    input.forvaltningsberattelse.resultatdisposition.overkursfond = 50_000
    input.forvaltningsberattelse.resultatdisposition.summa = 270_000
    input.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = 270_000
    assertNoConflictingDuplicates(input)
  })
})

describe('XML escaping (TA §3.2)', () => {
  it('company name and note bodies with <, & and " produce well-formed XML', () => {
    const input = makeInput()
    input.company.name = 'Müller & Söner <Test> "AB"'
    input.forvaltningsberattelse.allmantOmVerksamheten =
      'Handel med <komponenter> & "specialverktyg" där 1 < 2.'
    input.noter.push({
      number: 4,
      title: 'Övrigt & "annat" <viktigt>',
      body: 'Villkor: a < b & c > d, citerat som "fritt".',
    })
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(xhtml).toContain('Müller &amp; Söner &lt;Test&gt; "AB"')
    // No raw < survives inside text nodes (only as markup).
    expect(xhtml).not.toContain('<komponenter>')
  })
})
