/**
 * What Bolagsverket checks in the file itself, beyond well-formed XBRL:
 * schema enumerations (fastställelseintyg sentences, företrädarroll), the
 * sign of each equity movement, one spelling of the org number, säte and
 * repeated amounts tagged, and a printout with a header on every sheet.
 * Each case failed on the generator before the October 2026 fixes; Arelle
 * reported the enumeration errors as xmlSchema:valueError.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { FactWriter } from '../document/ix'
import { certificateRole } from '../certificate-role'
import { getEntryPoint } from '../taxonomy/entry-points'
import { getRegistry } from '../taxonomy/registry'
import type { IxbrlArsredovisningInput } from '../types'
import { makeInput } from './fixtures'

function generate(patch: (input: IxbrlArsredovisningInput) => void = () => {}) {
  const input = makeInput()
  patch(input)
  return generateK2IxbrlDocument(input)
}

/** Inner text of every ix:nonNumeric fact with this QName. */
function nonNumeric(xhtml: string, name: string): string[] {
  const pattern = new RegExp(`<ix:nonNumeric[^>]*name="${name}"[^>]*>([\\s\\S]*?)</ix:nonNumeric>`, 'g')
  return [...xhtml.matchAll(pattern)].map((match) => match[1])
}

/** Every ix:nonFraction element (tag and text) with this QName. */
function nonFraction(xhtml: string, name: string): string[] {
  const pattern = new RegExp(`<ix:nonFraction[^>]*name="${name}"[^>]*>[^<]*</ix:nonFraction>`, 'g')
  return [...xhtml.matchAll(pattern)].map((match) => match[0])
}

const entryPoint = getEntryPoint('k2-ab-risbs-2024-09-12')
const registry = getRegistry(entryPoint.registryId)

describe('fastställelseintyg values the schema enumerates', () => {
  it('carries the allowed values from se-comp-base 2020-12-01 in the registry', () => {
    expect(registry.concepts['ArsstammaResultatDispositionGodkannaStyrelsensForslag'].enumeration).toEqual([
      'Årsstämman beslöt att godkänna styrelsens förslag till behandling av ansamlad förlust.',
      'Årsstämman beslöt att godkänna styrelsens förslag till vinstdisposition.',
    ])
    expect(registry.concepts['UnderskriftFaststallelseintygForetradareForetradarroll'].enumeration).toEqual([
      'Styrelseledamot',
      'Styrelsesuppleant',
      'Verkställande direktör',
      'Likvidator',
      'Likvidatorssuppleant',
    ])
  })

  it('refuses a value outside the enumeration when the fact is written', () => {
    const writer = new FactWriter(entryPoint, registry, '556999-9997')
    writer.addInstantContext('balans0', '2025-12-31')
    expect(() =>
      writer.textPlain(
        'ArsstammaResultatDispositionGodkannaStyrelsensForslag',
        'balans0',
        'Årsstämman beslöt att godkänna styrelsens förslag till resultatdisposition.',
      ),
    ).toThrow(/not an allowed value/)
    expect(() =>
      writer.textHtml('ArsstammaResultatDispositionGodkannaStyrelsensForslag', 'balans0', '<p>x</p>'),
    ).toThrow(/enumerated concept/)
  })

  it('approves the vinstdisposition when the free equity is positive', () => {
    const { xhtml } = generate()
    expect(nonNumeric(xhtml, 'se-bol-base:ArsstammaResultatDispositionGodkannaStyrelsensForslag')).toEqual([
      'Årsstämman beslöt att godkänna styrelsens förslag till vinstdisposition.',
    ])
  })

  it('approves the behandling av ansamlad förlust when the free equity is negative', () => {
    const { xhtml } = generate((input) => {
      input.forvaltningsberattelse.resultatdisposition.summa = -8_983
    })
    expect(nonNumeric(xhtml, 'se-bol-base:ArsstammaResultatDispositionGodkannaStyrelsensForslag')).toEqual([
      'Årsstämman beslöt att godkänna styrelsens förslag till behandling av ansamlad förlust.',
    ])
  })

  it('words a rejected proposal with the same object and keeps the decision text', () => {
    const { xhtml } = generate((input) => {
      input.forvaltningsberattelse.resultatdisposition.summa = -8_983
      input.faststallelseintyg.resultatdispositionOutcome = 'alternative_decision'
      input.faststallelseintyg.resultatdispositionDecision = 'Förlusten balanseras i ny räkning.'
    })
    expect(
      nonNumeric(xhtml, 'se-bol-base:ArsstammaResultatDispositionInteGodkannaStyrelsensForslag'),
    ).toEqual(['Årsstämman beslöt att inte godkänna styrelsens förslag till behandling av ansamlad förlust.'])
    expect(nonNumeric(xhtml, 'se-bol-base:ArsstammaResultatDispositionBeslutstext')).toEqual([
      'Förlusten balanseras i ny räkning.',
    ])
  })

  it('keeps a space between the intyg sentences in the XBRL value', () => {
    const { xhtml } = generate()
    expect(xhtml).toMatch(/2026-03-15<\/ix:nonNumeric>\. <br\/>/)
  })
})

describe('fastställelseintyg signer role', () => {
  it('translates the roster roles to the taxonomy vocabulary', () => {
    expect(certificateRole('Styrelseordförande')).toBe('Styrelseledamot')
    expect(certificateRole('VD')).toBe('Verkställande direktör')
    expect(certificateRole(' verkställande  direktör ')).toBe('Verkställande direktör')
    expect(certificateRole('Styrelseledamot')).toBe('Styrelseledamot')
    expect(certificateRole('Styrelsesuppleant')).toBe('Styrelsesuppleant')
    expect(certificateRole('Revisor')).toBe('Revisor')
  })

  it('writes a chair as Styrelseledamot on the intyg but keeps the role on the signature', () => {
    const { xhtml } = generate((input) => {
      input.faststallelseintyg.signerRole = 'Styrelseordförande'
      input.underskrifter.signers[0].role = 'Styrelseordförande'
    })
    expect(nonNumeric(xhtml, 'se-bol-base:UnderskriftFaststallelseintygForetradareForetradarroll')).toEqual([
      'Styrelseledamot',
    ])
    expect(nonNumeric(xhtml, 'se-gen-base:UnderskriftHandlingRoll')).toContain('Styrelseordförande')
  })

  it('writes VD as Verkställande direktör', () => {
    const { xhtml } = generate((input) => {
      input.faststallelseintyg.signerRole = 'VD'
    })
    expect(nonNumeric(xhtml, 'se-bol-base:UnderskriftFaststallelseintygForetradareForetradarroll')).toEqual([
      'Verkställande direktör',
    ])
  })

  it('fails generation on a role the taxonomy does not know instead of filing a guess', () => {
    expect(() =>
      generate((input) => {
        input.faststallelseintyg.signerRole = 'Revisor'
      }),
    ).toThrow(/UnderskriftFaststallelseintygForetradareForetradarroll/)
  })
})

describe('förändringar i eget kapital', () => {
  it('reports "Balanseras i ny räkning" as a decrease of the årets-resultat column', () => {
    const { xhtml } = generate()
    const [aretsResultat] = nonFraction(xhtml, 'se-gen-base:ForandringEgetKapitalAretsResultatBalanserasNyRakning')
    expect(aretsResultat).toContain('sign="-"')
    expect(aretsResultat).toContain('>40 000<')
    expect(xhtml).toContain(`−${aretsResultat}`)
    const [balanserat] = nonFraction(xhtml, 'se-gen-base:ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')
    expect(balanserat).not.toContain('sign=')
    expect(balanserat).toContain('>40 000<')
  })

  it('turns both signs around when a loss is carried forward', () => {
    const { xhtml } = generate((input) => {
      input.forvaltningsberattelse.egetKapital.balanserasINyRakning = -15_000
    })
    const [aretsResultat] = nonFraction(xhtml, 'se-gen-base:ForandringEgetKapitalAretsResultatBalanserasNyRakning')
    expect(aretsResultat).not.toContain('sign=')
    const [balanserat] = nonFraction(xhtml, 'se-gen-base:ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')
    expect(balanserat).toContain('sign="-"')
  })
})

describe('organisationsnummer and säte', () => {
  it('writes the org number as NNNNNN-NNNN whatever the settings hold', () => {
    const { xhtml } = generate((input) => {
      input.company.orgNumber = '5569999997'
    })
    expect(xhtml).toContain('<xbrli:identifier scheme="http://www.bolagsverket.se">556999-9997</xbrli:identifier>')
    expect(nonNumeric(xhtml, 'se-cd-base:Organisationsnummer')).toEqual(['556999-9997'])
    expect(xhtml).not.toContain('5569999997')
  })

  it('tags säte on the cover and leaves it out when unknown', () => {
    expect(nonNumeric(generate().xhtml, 'se-cd-base:ForetagetsSate')).toEqual(['Sundsvall'])
    const { xhtml } = generate((input) => {
      input.company.registeredOffice = null
    })
    expect(nonNumeric(xhtml, 'se-cd-base:ForetagetsSate')).toEqual([])
  })
})

describe('aktiekapital note', () => {
  const withNote = (aktiekapital: number) =>
    generate((input) => {
      input.noter.push({
        number: 7,
        title: 'Aktiekapital',
        body: 'Aktiekapital: 25 000 kr. Antal aktier: 250. Kvotvärde per aktie: 100 kr.',
      })
      input.disclosures.aktiekapitalNot = { aktiekapital, antalAktier: 250 }
    })

  it('tags the registered amount, which repeats the balance sheet fact', () => {
    const { xhtml, warnings } = withNote(25_000)
    const facts = nonFraction(xhtml, 'se-gen-base:Aktiekapital').filter((tag) => tag.includes('contextRef="balans0"'))
    const before = nonFraction(generate().xhtml, 'se-gen-base:Aktiekapital').filter((tag) =>
      tag.includes('contextRef="balans0"'),
    )
    expect(facts.length).toBe(before.length + 1)
    expect(new Set(facts.map((tag) => tag.replace(/^.*>([^<]*)<.*$/, '$1')))).toEqual(new Set(['25 000']))
    expect(xhtml).toMatch(/Antal aktier: 250\. Kvotvärde per aktie: 100 kr\./)
    expect(warnings.some((warning) => warning.includes('Aktiekapitalet i noten'))).toBe(false)
  })

  it('leaves the amount untagged and warns when the books disagree with the register', () => {
    const { xhtml, warnings } = withNote(50_000)
    expect(xhtml).toContain('Aktiekapital: 50 000 kr.')
    expect(warnings.some((warning) => warning.includes('Aktiekapitalet i noten (50000 kr)'))).toBe(true)
  })
})

describe('print layout', () => {
  const { xhtml } = generate()

  it('puts the balance sheet on two sheets and numbers every page header', () => {
    const headers = [...xhtml.matchAll(/<span class="ar-page-no">(\d+) \((\d+)\)<\/span>/g)]
    expect(headers.map((match) => match[1])).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(new Set(headers.map((match) => match[2]))).toEqual(new Set(['7']))
    const pages = xhtml.split('<div class="ar-page"').slice(1)
    expect(pages[3]).toContain('Balansräkning: Tillgångar')
    expect(pages[3]).not.toContain('Balansräkning: Eget kapital och skulder')
    expect(pages[4]).toContain('Balansräkning: Eget kapital och skulder')
  })

  it('uses no inline layout styles or flexbox', () => {
    expect(xhtml).not.toContain('padding-left:1.2em')
    expect(xhtml).not.toContain('display: flex')
  })

  it('prints the kontrollbalansräkning statement the PDF prints', () => {
    expect(xhtml).not.toContain('Kontrollbalansräkning har upprättats')
    const flagged = generate((input) => {
      input.forvaltningsberattelse.kontrollbalansrakningUpprattad = true
    })
    expect(flagged.xhtml).toContain('Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.')
  })

  it('heads the medelantal column with the period when the year is not a calendar year', () => {
    const { xhtml: broken } = generate((input) => {
      input.period = { start: '2025-07-17', end: '2026-12-31' }
    })
    expect(broken).toContain('<th class="num">2025-07-17 till 2026-12-31</th>')
    expect(xhtml).toContain('<th class="num">2025</th>')
  })
})

describe('XML-illegal characters', () => {
  it('drops a pasted control character instead of breaking the document', () => {
    const { xhtml } = generate((input) => {
      input.forvaltningsberattelse.vasentligaHandelser = 'Ny lokal\u000B tecknad.'
    })
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(xhtml).toContain('Ny lokal tecknad.')
  })
})
