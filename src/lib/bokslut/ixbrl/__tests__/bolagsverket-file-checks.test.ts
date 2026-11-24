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
    expect(xhtml).toMatch(/2026-03-15<\/ix:nonNumeric><\/span>\. <br\/>/)
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

  it('divides long notes into pages that each carry their header and their own sheet number', () => {
    // A page taller than a sheet runs on to a sheet without a header in
    // Bolagsverket's PDF, and every header after it counts a sheet too few.
    const paragraph =
      'Bolaget tillämpar samma redovisningsprinciper som föregående räkenskapsår om inte annat anges i noten. '.repeat(4)
    const long = generate((input) => {
      for (let index = 0; index < 12; index += 1) {
        input.noter.push({
          number: input.noter.length + 1,
          title: `Övrig upplysning ${index + 1}`,
          body: [paragraph, paragraph, paragraph].join('\n\n'),
        })
      }
    })
    const pages = long.xhtml.split('<div class="ar-page"').slice(1)
    const notePages = pages.filter((page) => /<h3 id="not-\d+">/.test(page))
    expect(notePages.length).toBeGreaterThan(2)
    // Every page has one header, numbered in sequence out of the same total.
    const headers = [...long.xhtml.matchAll(/<span class="ar-page-no">(\d+) \((\d+)\)<\/span>/g)]
    expect(headers).toHaveLength(pages.length)
    expect(headers.map((match) => Number(match[1]))).toEqual(pages.map((_, index) => index + 1))
    expect(new Set(headers.map((match) => Number(match[2])))).toEqual(new Set([pages.length]))
    // The section's heading is printed once, with the first note, and every
    // note once, in order; a note's heading is never the last thing on a page.
    expect(long.xhtml.match(/<h2>Noter<\/h2>/g)).toHaveLength(1)
    expect(notePages[0]).toMatch(/<h2>Noter<\/h2>\n<h3 id="not-1">/)
    const numbers = [...long.xhtml.matchAll(/<h3 id="not-(\d+)">/g)].map((match) => Number(match[1]))
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, index) => index + 1))
    for (const page of notePages) expect(page).not.toMatch(/<\/h3>\s*<\/div>\s*$/)
  })

  it('numbers the page after a note taller than a sheet by the sheets that note fills', () => {
    // One paragraph of 150 forced lines is a single piece: it printed on
    // four sheets in Bolagsverket's converter, three of them without a header.
    const tall = generate((input) => {
      input.noter.push(
        {
          number: input.noter.length + 1,
          title: 'Uppställning',
          body: Array.from({ length: 150 }, (_, index) => `Rad ${index + 1}`).join('\n'),
        },
        { number: input.noter.length + 2, title: 'Efter uppställningen', body: 'Inga.' },
      )
    })
    const pages = tall.xhtml.split('<div class="ar-page"').slice(1)
    const headers = pages.map((page) => /<span class="ar-page-no">(\d+) \((\d+)\)<\/span>/.exec(page)!)
    const numbers = headers.map((match) => Number(match[1]))
    const tallPage = pages.findIndex((page) => page.includes('Rad 150'))
    expect(tallPage).toBeGreaterThan(0)
    expect(pages[tallPage + 1]).toContain('Efter uppställningen')
    // Every page before it is one sheet, the tall one four, the rest one.
    expect(numbers).toEqual(pages.map((_, index) => (index <= tallPage ? index + 1 : index + 4)))
    expect(new Set(headers.map((match) => Number(match[2])))).toEqual(new Set([pages.length + 3]))
  })

  it('divides a long note on långfristiga skulder between its paragraphs and keeps the amount with the last one', () => {
    const paragraph =
      'Bolaget har lån hos kreditinstitut som amorteras enligt plan och som löper med rörlig ränta under hela löptiden. '.repeat(3)
    const long = generate((input) => {
      input.noter = input.noter.map((note) =>
        note.title === 'Långfristiga skulder'
          ? { ...note, body: Array.from({ length: 40 }, () => paragraph).join('\n\n') }
          : note,
      )
    })
    const pages = long.xhtml.split('<div class="ar-page"').slice(1)
    const withText = pages.filter((page) => page.includes('Bolaget har lån hos kreditinstitut'))
    expect(withText.length).toBeGreaterThan(1)
    expect(long.xhtml.split('Bolaget har lån hos kreditinstitut').length - 1).toBe(40 * 3)
    // The tagged amount follows the last paragraph of the text on its page.
    expect(withText[withText.length - 1]).toMatch(/hela löptiden\.<\/p><p class="note-fact">Belopp som förfaller/)
    const headers = [...long.xhtml.matchAll(/<span class="ar-page-no">(\d+) \((\d+)\)<\/span>/g)]
    expect(headers.map((match) => Number(match[1]))).toEqual(pages.map((_, index) => index + 1))
  })

  it('keeps a tagged text of any length as one fact on a page of its own, and numbers the pages after it by its sheets', () => {
    // The principles are one fact: it cannot be divided between two pages
    // without a continuation, so it runs over the sheets it needs.
    const paragraph =
      'Bolaget tillämpar samma redovisningsprinciper som föregående räkenskapsår om inte annat anges i noten. '.repeat(3)
    const tagged = generate((input) => {
      input.noter = input.noter.map((note) =>
        note.number === 1 ? { ...note, body: Array.from({ length: 60 }, () => paragraph).join('\n\n') } : note,
      )
    })
    const pages = tagged.xhtml.split('<div class="ar-page"').slice(1)
    const facts = nonNumeric(tagged.xhtml, 'se-gen-base:RedovisningsVarderingsprinciper')
    expect(facts).toHaveLength(1)
    expect(facts[0].split('<p>').length - 1).toBe(60)
    const factPage = pages.findIndex((page) => page.includes('se-gen-base:RedovisningsVarderingsprinciper'))
    const numbers = pages.map((page) => Number(/<span class="ar-page-no">(\d+) \(\d+\)<\/span>/.exec(page)![1]))
    const totals = new Set(pages.map((page) => Number(/<span class="ar-page-no">\d+ \((\d+)\)<\/span>/.exec(page)![1])))
    const sheets = numbers[factPage + 1] - numbers[factPage]
    expect(sheets).toBeGreaterThan(2)
    // Every other page is one sheet: the total is the pages and the fact's further sheets.
    expect(totals).toEqual(new Set([pages.length + sheets - 1]))
    expect(numbers[numbers.length - 1]).toBe(pages.length + sheets - 1)
  })

  it('leaves notes that fit one sheet on one page, as before', () => {
    const pages = xhtml.split('<div class="ar-page"').slice(1)
    expect(pages.filter((page) => /<h3 id="not-\d+">/.test(page))).toHaveLength(1)
  })

  it('prints a zero as 0 on a cost row, never as a minus and a zero', () => {
    const writer = new FactWriter(entryPoint, registry, '556999-9997')
    writer.addDurationContext('period0', '2025-01-01', '2025-12-31')
    expect(writer.money('OvrigaRorelsekostnader', 'period0', 0, { displayMinus: true })).toMatch(/^<ix:nonFraction[^>]*>0<\/ix:nonFraction>$/)
    expect(writer.money('OvrigaRorelsekostnader', 'period0', 5000, { displayMinus: true })).toMatch(/^−<ix:nonFraction[^>]*>5 000<\/ix:nonFraction>$/)
    // A cost that is an income for the year still shows without the minus.
    expect(writer.money('OvrigaRorelsekostnader', 'period0', -5000, { displayMinus: true })).toMatch(/^<ix:nonFraction[^>]*sign="-"[^>]*>5 000<\/ix:nonFraction>$/)
  })

  it('keeps each date of the title and of the intyg on one line', () => {
    expect(xhtml).toContain(
      '<h1>Årsredovisning för räkenskapsåret <span class="nowrap">2025-01-01</span> till <span class="nowrap">2025-12-31</span></h1>',
    )
    expect(xhtml).toMatch(/<span class="nowrap"><ix:nonNumeric[^>]*name="se-bol-base:Arsstamma">2026-03-15<\/ix:nonNumeric><\/span>/)
    expect(xhtml).toContain('.nowrap { white-space: nowrap; }')
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
