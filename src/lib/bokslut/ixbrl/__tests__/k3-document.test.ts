/**
 * The K3 iXBRL document (K3 AB risbs 2021-10-31, rev 2026-08-31): the
 * fixture is the K2 test company under K3 with its own K3 post, the equity
 * specification from the ledger and a chapter 7 kassaflödesanalys. The
 * golden file pins the whole document; the cases below pin what matters on
 * their own, so a change to the golden file has to be read, not accepted.
 */

import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { generateIxbrlDocument } from '../document/generate'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { generateK3IxbrlDocument } from '../document/k3-document'
import { k3CashFlowFromStatement, k3EquityFromClosingBalances } from '../k3-adapters'
import { getRegistry } from '../taxonomy/registry'
import { K3_EQUITY_PREVIOUS_YEAR, makeInput, makeK3Input } from './fixtures'

/** Every tagged fact as "name@context" → displayed value with sign="-" read as a leading minus. */
function facts(xhtml: string, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of xhtml.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    if (!match[1].includes(`name="se-gen-base:${name}"`)) continue
    const context = /contextRef="([^"]+)"/.exec(match[1])?.[1] ?? ''
    out[context] = `${/sign="-"/.test(match[1]) ? '-' : ''}${match[2].replace(/\s/g, '')}`
  }
  return out
}

/** The text in front of a fact: a presentational minus sits right before the element. */
function precededByMinus(xhtml: string, name: string, contextRef: string): boolean {
  const index = xhtml.search(new RegExp(`<ix:nonFraction contextRef="${contextRef}" name="se-gen-base:${name}"`))
  expect(index).toBeGreaterThan(0)
  return xhtml[index - 1] === '−'
}

function taggedNames(xhtml: string): Set<string> {
  const names = new Set<string>()
  for (const match of xhtml.matchAll(/<ix:(?:nonFraction|nonNumeric|tuple) [^>]*name="([\w-]+):([\w-]+)"/g)) {
    names.add(`${match[1]}:${match[2]}`)
  }
  return names
}

describe('generateK3IxbrlDocument', () => {
  const { xhtml, warnings } = generateK3IxbrlDocument(makeK3Input())

  it('produces well-formed XHTML', () => {
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(xhtml).not.toContain('<script')
  })

  it('pins the whole document (golden file)', async () => {
    await expect(xhtml).toMatchFileSnapshot('__snapshots__/k3-document.golden.xhtml')
  })

  it('references the K3 risbs entry point and the fastställelseintyg schema', () => {
    expect(xhtml).toContain('http://xbrl.taxonomier.se/se/fr/gaap/k3/risbs/2021-10-31/se-k3-risbs-2021-10-31.xsd')
    expect(xhtml).toContain('http://xbrl.taxonomier.se/se/fr/gaap/coa/rplc/2020-12-01/se-coa-rplc-2020-12-01.xsd')
    expect(xhtml).not.toContain('/k2-all/')
    expect(xhtml).toContain('xmlns:se-k3-type="http://www.taxonomier.se/se/fr/k3/datatype"')
  })

  it('tags only concepts of the K3 registry', () => {
    const registry = getRegistry('k3-ab-2021-10-31')
    const unknown = [...taggedNames(xhtml)].filter((qname) => !registry.concepts[qname.split(':')[1]])
    expect(unknown).toEqual([])
  })

  it('states the unit with MatEnhet, not the K2 Beloppsformat vallista', () => {
    expect(xhtml).toMatch(/<ix:nonNumeric contextRef="period0" name="se-cd-base:MatEnhet">Om inte annat särskilt anges/)
    expect(xhtml).not.toContain('BeloppsformatList')
  })

  it('counts medelantal anställda in the K3 unit (antal-personer)', () => {
    expect(xhtml).toContain('<xbrli:unit id="antal-personer"><xbrli:measure>se-k3-type:AntalPersoner</xbrli:measure></xbrli:unit>')
    expect(xhtml).toMatch(/name="se-gen-base:MedelantaletAnstallda" unitRef="antal-personer"/)
    expect(xhtml).not.toContain('se-k2-type')
  })

  it('tags K3 posts of its own (uppskjuten skattefordran) in the balance sheet', () => {
    expect(facts(xhtml, 'UppskjutenSkattefordran')).toEqual({ balans0: '5000', balans1: '0' })
    expect(facts(xhtml, 'Kundfordringar').balans0).toBe('45000')
    expect(facts(xhtml, 'FinansiellaAnlaggningstillgangar').balans0).toBe('5000')
    expect(facts(xhtml, 'Tillgangar').balans0).toBe('380000')
  })

  it('tags the K2 names K3 renames under their K3 names', () => {
    const input = makeK3Input()
    input.rr.OvrigaBokslutsdispositioner = { current: -1_000, previous: 0 }
    input.br.OvrigaObeskattadeReserver = { current: 2_000, previous: 0 }
    const renamed = generateK3IxbrlDocument(input).xhtml
    expect(renamed).not.toContain('se-gen-base:OvrigaBokslutsdispositioner')
    expect(renamed).not.toContain('se-gen-base:OvrigaObeskattadeReserver')
    expect(facts(renamed, 'AndraBokslutsdispositioner').period0).toBe('-1000')
    expect(facts(renamed, 'AndraObeskattadeReserver').balans0).toBe('2000')
  })

  it('carries the förvaltningsberättelse texts K3 asks for, by concept', () => {
    expect(xhtml).toContain('se-gen-base:VerksamhetenArtInriktning')
    expect(xhtml).toContain('se-gen-base:ViktigaForhallandenVasentligaHandelser')
    expect(xhtml).toMatch(/name="se-gen-base:UppgiftAgareMerAnTioProcentAndelarRoster"[^>]*><p>Bolaget ägs till 100 procent/)
  })

  describe('förändringar i eget kapital', () => {
    it('opens at last year’s balances and closes at the balance sheet’s', () => {
      expect(facts(xhtml, 'Aktiekapital')).toMatchObject({ balans1: '25000', balans0: '25000' })
      expect(facts(xhtml, 'EgetKapital')).toEqual({ balans0: '245000', balans1: '125000' })
    })

    it('tags each movement with its post’s concept, decreases with sign="-"', () => {
      expect(facts(xhtml, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '40000' })
      expect(facts(xhtml, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-40000' })
      expect(facts(xhtml, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
      expect(facts(xhtml, 'ForandringEgetKapitalAretsResultatAretsResultat')).toEqual({ period0: '120000' })
      expect(facts(xhtml, 'ForandringEgetKapitalTotaltAretsResultat')).toEqual({ period0: '120000' })
    })

    it('as a statement of its own: both years, after the kassaflödesanalys, the jämförelseår from balans2', () => {
      const input = makeK3Input()
      input.k3!.equity = { ...input.k3!.equity, placement: 'separate_statement', previous: K3_EQUITY_PREVIOUS_YEAR.posts }
      const separate = generateK3IxbrlDocument(input).xhtml
      expect(XMLValidator.validate(separate)).toBe(true)
      const kfa = separate.indexOf('<h2>Kassaflödesanalys</h2>')
      const ek = separate.indexOf('<h2>Förändring av eget kapital (kr)</h2>')
      const noter = separate.indexOf('<h2>Noter</h2>')
      expect(kfa).toBeGreaterThan(0)
      expect(ek).toBeGreaterThan(kfa)
      expect(noter).toBeGreaterThan(ek)
      expect(separate).not.toContain('<h3>Förändringar i eget kapital</h3>')
      expect(facts(separate, 'EgetKapital')).toEqual({ balans0: '245000', balans1: '125000', balans2: '85000' })
      expect(facts(separate, 'BalanseratResultat')).toMatchObject({ balans2: '35000', balans1: '60000', balans0: '100000' })
      expect(facts(separate, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period1: '-25000', period0: '-40000' })
      expect(facts(separate, 'ForandringEgetKapitalTotaltAretsResultat')).toEqual({ period1: '40000', period0: '120000' })
    })

    it('declares balans2 for the jämförelseår when the flerårsöversikt did not', () => {
      const input = makeK3Input()
      input.forvaltningsberattelse.flerarsoversikt = input.forvaltningsberattelse.flerarsoversikt.slice(0, 2)
      input.forvaltningsberattelse.flerarsPerioder = input.forvaltningsberattelse.flerarsPerioder.slice(0, 2)
      expect(generateK3IxbrlDocument(input).xhtml).not.toContain('<xbrli:context id="balans2">')
      input.k3!.equity = { ...input.k3!.equity, placement: 'separate_statement', previous: K3_EQUITY_PREVIOUS_YEAR.posts }
      const separate = generateK3IxbrlDocument(input).xhtml
      expect(separate).toContain('<xbrli:context id="balans2">')
      expect(separate).toMatch(/<xbrli:context id="balans2">[\s\S]*?<xbrli:instant>2023-12-31<\/xbrli:instant>/)
      expect(facts(separate, 'EgetKapital').balans2).toBe('85000')
    })

    it('shows the fallback built from closing balances the same way', () => {
      const input = makeK3Input()
      input.k3!.equity = k3EquityFromClosingBalances(input.br)
      const fallback = generateK3IxbrlDocument(input).xhtml
      expect(facts(fallback, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-40000' })
      expect(facts(fallback, 'EgetKapital')).toEqual({ balans0: '245000', balans1: '125000' })
    })
  })

  describe('kassaflödesanalys', () => {
    it('tags the chapter 7 lines in the year’s context', () => {
      expect(facts(xhtml, 'JusteringPosterSomInteIngarIKassaflodet')).toEqual({ period0: '20000' })
      expect(facts(xhtml, 'KassaflodeLopandeVerksamhetenForeForandringarRorelsekapital')).toEqual({ period0: '170000' })
      expect(facts(xhtml, 'ForandringKassaflodeRorelsefodringar')).toEqual({ period0: '-50000' })
      expect(facts(xhtml, 'KassaflodeLopandeVerksamheten')).toEqual({ period0: '85000' })
      expect(facts(xhtml, 'AretsKassaflode')).toEqual({ period0: '85000' })
    })

    it('tags "Minskning av kassaflöde …" concepts positive with a presentational minus', () => {
      expect(facts(xhtml, 'ErlagdRanta')).toEqual({ period0: '4000' })
      expect(precededByMinus(xhtml, 'ErlagdRanta', 'period0')).toBe(true)
      expect(facts(xhtml, 'BetaldSkatt')).toEqual({ period0: '1340' })
      expect(facts(xhtml, 'ErhallenRanta')).toEqual({ period0: '1000' })
      expect(precededByMinus(xhtml, 'ErhallenRanta', 'period0')).toBe(false)
    })

    it('tags likvida medel as balances at the year’s start and end', () => {
      expect(facts(xhtml, 'LikvidaMedel')).toEqual({ balans1: '185000', balans0: '270000' })
    })

    it('repeats the RR figure on the result line, so the duplicate fact is value-identical', () => {
      expect(new Set(Object.values(facts(xhtml, 'Rorelseresultat')))).toEqual(new Set(['154340', '62000']))
      expect(xhtml.match(/name="se-gen-base:Rorelseresultat"/g)).toHaveLength(3)
    })

    it('leaves the comparative column empty when the statement has no comparative year', () => {
      expect(facts(xhtml, 'KassaflodeLopandeVerksamheten').period1).toBeUndefined()
    })

    it('fills the comparative column and prints a zero decrease as 0, not −0', () => {
      const input = makeK3Input()
      const current = Object.fromEntries(input.k3!.cashFlow!.rows.map((row) => [row.key, row.current]))
      input.k3!.cashFlow = k3CashFlowFromStatement({
        current: { amounts: current, reconciliation: { is_reconciled: true } },
        previous: {
          amounts: {
            rorelseresultat: 62_000,
            kassaflode_fore_rorelsekapital: 62_000,
            kassaflode_lopande: 62_000,
            investering_materiella: -80_000,
            kassaflode_investering: -80_000,
            arets_kassaflode: -18_000,
            likvida_medel_ib: 203_000,
            likvida_medel_ub: 185_000,
          },
          reconciliation: { is_reconciled: true },
        },
      })
      const withPrevious = generateK3IxbrlDocument(input).xhtml
      expect(facts(withPrevious, 'InvesteringMateriellaAnlaggningstillgangar')).toEqual({ period0: '0', period1: '80000' })
      expect(precededByMinus(withPrevious, 'InvesteringMateriellaAnlaggningstillgangar', 'period0')).toBe(false)
      expect(precededByMinus(withPrevious, 'InvesteringMateriellaAnlaggningstillgangar', 'period1')).toBe(true)
      expect(facts(withPrevious, 'LikvidaMedel')).toEqual({ balans2: '203000', balans1: '185000', balans0: '270000' })
    })

    it('is left out when the report has none', () => {
      const input = makeK3Input()
      input.k3!.cashFlow = null
      expect(generateK3IxbrlDocument(input).xhtml).not.toContain('Kassaflödesanalys')
    })
  })

  it('renders the revisorspåteckning with the K3 tuple', () => {
    const input = makeK3Input()
    input.revisorspateckning = {
      required: true,
      revisionsbolag: 'Revisionsbyrån AB',
      opinion: 'unmodified',
      revisorer: [
        { firstName: 'Rita', lastName: 'Revisor', titel: 'Huvudansvarig revisor', huvudansvarig: true, signedDate: '2026-02-21' },
      ],
    }
    const signed = generateK3IxbrlDocument(input).xhtml
    expect(signed).toContain('<ix:tuple name="se-gaap-ext:UnderskriftRevisorspateckningTuple"')
    expect(signed).toMatch(/name="se-cd-base:ValtRevisionsbolagsnamn">Revisionsbyrån AB/)
    expect(signed).toMatch(/name="se-gen-base:RevisorspateckningRevisionsberattelseEnligtStandardutformning">2026-02-21/)
  })

  it('passes the input warnings through', () => {
    expect(warnings).toEqual([])
  })

  it('tags the note on lån till ledande befattningshavare (ÅRL 5 kap. 18 §) as one fact with its paragraphs', () => {
    const input = makeK3Input()
    input.noter = [
      ...input.noter,
      { number: input.noter.length + 1, title: 'Lån till ledande befattningshavare', body: 'Lån om 5 000 kr.\n\nUtan ränta.' },
    ]
    const document = generateK3IxbrlDocument(input).xhtml
    expect(XMLValidator.validate(document)).toBe(true)
    expect(document).toMatch(
      /contextRef="period0" name="se-gen-base:NotLanSakerheterAtagandenFormanLedandeBefattningshavare"[^>]*><p>Lån om 5 000 kr\.<\/p>\s*<p>Utan ränta\.<\/p><\/ix:nonNumeric>/,
    )
  })

  it('refuses a K2 entry point and an input without its K3 part', () => {
    expect(() => generateK3IxbrlDocument(makeInput())).toThrow(/not a K3 entry point/)
    const input = makeK3Input()
    delete input.k3
    expect(() => generateK3IxbrlDocument(input)).toThrow(/no K3 part/)
  })
})

describe('generateIxbrlDocument', () => {
  it('builds the K2 document for a K2 entry point, unchanged', () => {
    const input = makeInput()
    expect(generateIxbrlDocument(input).xhtml).toBe(generateK2IxbrlDocument(input).xhtml)
  })

  it('builds the K3 document for a K3 entry point', () => {
    const input = makeK3Input()
    expect(generateIxbrlDocument(input).xhtml).toBe(generateK3IxbrlDocument(input).xhtml)
  })
})
