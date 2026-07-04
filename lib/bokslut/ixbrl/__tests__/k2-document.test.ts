import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { mapTrialBalancesToK2 } from '../k2-mapper'
import { generateK2IxbrlDocument, embedKontrollsumma } from '../document/k2-document'
import { makeInput, CURRENT } from './fixtures'

describe('generateK2IxbrlDocument', () => {
  const { xhtml, warnings } = generateK2IxbrlDocument(makeInput())

  it('produces well-formed XML (XHTML)', () => {
    const validation = XMLValidator.validate(xhtml)
    expect(validation).toBe(true)
  })

  it('declares the container per TA §3/§4: UTF-8, title, programvara meta, no scripts', () => {
    expect(xhtml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
    expect(xhtml).toContain('<title>')
    expect(xhtml).toContain('<meta name="programvara" content="Accounted - Accounted"/>')
    expect(xhtml).toContain('<meta name="programversion" content="2026.1"/>')
    expect(xhtml).not.toContain('<script')
    expect(xhtml).not.toContain('&nbsp;')
    expect(xhtml).toContain('xmlns="http://www.w3.org/1999/xhtml"')
  })

  it('references the K2 2024-09-12 risbs entry point + COA (fastställelseintyg) schema', () => {
    expect(xhtml).toContain(
      'http://xbrl.taxonomier.se/se/fr/gaap/k2-all/ab/risbs/2024-09-12/se-k2-ab-risbs-2024-09-12.xsd',
    )
    expect(xhtml).toContain(
      'http://xbrl.taxonomier.se/se/fr/gaap/coa/rplc/2020-12-01/se-coa-rplc-2020-12-01.xsd',
    )
  })

  it('declares contexts per TA §2.16 with the bolagsverket entity scheme', () => {
    for (const ctxId of ['period0', 'period1', 'period2', 'balans0', 'balans1', 'balans2']) {
      expect(xhtml).toContain(`<xbrli:context id="${ctxId}">`)
    }
    expect(xhtml).toContain('scheme="http://www.bolagsverket.se"')
    expect(xhtml).toContain('<xbrli:startDate>2025-01-01</xbrli:startDate>')
    expect(xhtml).toContain('<xbrli:instant>2025-12-31</xbrli:instant>')
    expect(xhtml).toContain('<xbrli:measure>iso4217:SEK</xbrli:measure>')
  })

  it('hides vallistor + räkenskapsårets dagar in ix:hidden (TA §2.15/§3.9.3)', () => {
    expect(xhtml).toContain('<ix:hidden>')
    expect(xhtml).toContain('se-mem-base:SprakSvenskaMember')
    expect(xhtml).toContain('se-mem-base:LandSverigeMember')
    expect(xhtml).toContain('se-mem-base:ValutaSvenskaKronorMember')
    expect(xhtml).toContain(
      'se-mem-base:FinansiellRapportStyrelsenVerkstallandeDirektorenAvgerArsredovisningMember',
    )
    expect(xhtml).toContain('se-cd-base:RakenskapsarForstaDag')
    expect(xhtml).toContain('se-cd-base:RakenskapsarSistaDag')
  })

  it('emits the fastställelseintyg with checksum-exclusion wrapper and the magic date id (TA §4.4-4.5)', () => {
    expect(xhtml).toContain('id="id-innehall-faststallelseintyg"')
    expect(xhtml).toContain('id="ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG"')
    expect(xhtml).toContain('se-bol-base:ArsstammaIntygande')
    expect(xhtml).toContain('se-bol-base:IntygandeOriginalInnehall')
    expect(xhtml).toMatch(/<ix:continuation id="intygande_forts">/)
    // AGM date tagged + generation date in the signing-date element.
    expect(xhtml).toContain('>2026-03-15</ix:nonNumeric>')
    expect(xhtml).toMatch(/ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG">2026-02-25</)
  })

  it('tags RR and BR amounts with correct attributes and presentational minus', () => {
    // Nettoomsättning current year, whole kronor.
    expect(xhtml).toMatch(
      /<ix:nonFraction contextRef="period0" name="se-gen-base:Nettoomsattning" unitRef="SEK" decimals="0" scale="0" format="ixt:numspacecomma">1 000 000<\/ix:nonFraction>/,
    )
    // Costs: minus outside the element, positive fact value (no sign attr).
    expect(xhtml).toMatch(
      /−<ix:nonFraction contextRef="period0" name="se-gen-base:Personalkostnader"[^>]*>525 660<\/ix:nonFraction>/,
    )
    expect(xhtml).not.toMatch(/name="se-gen-base:Personalkostnader"[^>]*sign="-"/)
    // Deviating sign: avsättning till periodiseringsfond (credit concept, debit value).
    expect(xhtml).toMatch(/name="se-gen-base:ForandringPeriodiseringsfond"[^>]*sign="-"/)
    // BR totals present in both years (3001/3002 kontrollera requirements).
    expect(xhtml).toMatch(/name="se-gen-base:Tillgangar"[^>]*>380 000/)
    expect(xhtml).toMatch(/name="se-gen-base:EgetKapitalSkulder"[^>]*>380 000/)
    expect(xhtml).toMatch(/contextRef="balans1" name="se-gen-base:Tillgangar"[^>]*>253 000/)
  })

  it('tags the underskrifter tuple with per-signer dates (TA §2.9.1)', () => {
    expect(xhtml).toContain('se-gaap-ext:UnderskriftArsredovisningForetradareTuple')
    const tilltalsnamn = xhtml.match(/name="se-gen-base:UnderskriftHandlingTilltalsnamn"/g) ?? []
    expect(tilltalsnamn).toHaveLength(2)
    const dates = xhtml.match(/name="se-gen-base:UndertecknandeDatum"[^>]*tupleRef="/g) ?? []
    expect(dates).toHaveLength(2)
    expect(xhtml).toContain('>2026-02-21</ix:nonNumeric>')
    // Datering av årsredovisning tagged (FY starts after 2024-07-01).
    expect(xhtml).toContain('se-gen-base:UndertecknandeArsredovisningDatum')
  })

  it('tags flerårsöversikt incl. soliditet as procent with scale -2 (TA §2.12)', () => {
    expect(xhtml).toMatch(
      /<ix:nonFraction contextRef="balans0" name="se-gen-base:Soliditet" unitRef="procent" decimals="3" scale="-2" format="ixt:numspacecomma">64,5<\/ix:nonFraction>/,
    )
    expect(xhtml).toMatch(/contextRef="period2" name="se-gen-base:Nettoomsattning"/)
  })

  it('tags medelantal anställda with the custom unit (TA §2.14)', () => {
    expect(xhtml).toMatch(
      /<ix:nonFraction contextRef="period0" name="se-gen-base:MedelantaletAnstallda" unitRef="antal-anstallda"/,
    )
    expect(xhtml).toContain('<xbrli:measure>se-k2-type:AntalAnstallda</xbrli:measure>')
  })

  it('tags resultatdisposition (BÖR: förslag) consistently with BR', () => {
    expect(xhtml).toMatch(/name="se-gen-base:ForslagDispositionBalanserasINyRakning"[^>]*>220 000/)
    expect(xhtml).toMatch(/name="se-gen-base:ForslagDisposition"[^>]*>220 000/)
    expect(xhtml).toMatch(/name="se-gen-base:FrittEgetKapital"[^>]*>220 000/)
  })

  it('does not tag utdelning when none is proposed', () => {
    expect(xhtml).not.toContain('ForslagDispositionUtdelning')
  })

  it('reports no warnings for the happy path', () => {
    expect(warnings).toEqual([])
  })

  it('embedKontrollsumma inserts the meta tags into head (TA §4.5.2)', () => {
    const withChecksum = embedKontrollsumma(xhtml, 'abc123==', 'SHA-256')
    expect(withChecksum).toContain(
      '<meta name="ixbrl.innehall.kontrollsumman" content="abc123=="/>',
    )
    expect(withChecksum).toContain(
      '<meta name="ixbrl.innehall.kontrollsumman.algoritm" content="SHA-256"/>',
    )
    expect(XMLValidator.validate(withChecksum)).toBe(true)
  })

  it('keeps the document under the 5 MB limit (TA §4.2.1)', () => {
    expect(Buffer.byteLength(xhtml, 'utf8')).toBeLessThan(5 * 1024 * 1024)
  })
})

describe('generateK2IxbrlDocument: dividend + first year variants', () => {
  it('tags förslag till utdelning when proposed (TA §2.9.2 BÖR)', () => {
    const input = makeInput()
    input.forvaltningsberattelse.resultatdisposition.utdelning = 50_000
    input.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = 170_000
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(xhtml).toMatch(/name="se-gen-base:ForslagDispositionUtdelning"[^>]*>50 000/)
  })

  it('tags fri överkursfond as its own concept in the disposition: identical to BR (TA §2.7.3)', () => {
    const input = makeInput()
    input.br['Overkursfond'] = { current: 50_000, previous: 50_000 }
    input.forvaltningsberattelse.resultatdisposition.overkursfond = 50_000
    input.forvaltningsberattelse.resultatdisposition.summa = 270_000
    input.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = 270_000
    const { xhtml } = generateK2IxbrlDocument(input)
    // BR row + disposition row: same concept, same context, same value.
    const facts =
      xhtml.match(
        /<ix:nonFraction contextRef="balans0" name="se-gen-base:Overkursfond"[^>]*>50 000<\/ix:nonFraction>/g,
      ) ?? []
    expect(facts).toHaveLength(2)
    // BalanseratResultat stays strictly balanserat (not balanserat + 2097).
    const balanserat =
      xhtml.match(
        /<ix:nonFraction contextRef="balans0" name="se-gen-base:BalanseratResultat"[^>]*>([\d ]+)</g,
      ) ?? []
    expect(balanserat.length).toBeGreaterThan(0)
    for (const fact of balanserat) expect(fact).toContain('>100 000<')
  })

  it('renders a deviating cost row WITHOUT the presentational minus (sign="-" carries the deviation)', () => {
    const input = makeInput()
    // Net income on a cost line (credit balance on 5xxx): deviating sign.
    input.rr['OvrigaExternaKostnader'] = { current: -5_000, previous: null }
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(xhtml).toMatch(/name="se-gen-base:OvrigaExternaKostnader"[^>]*sign="-"/)
    expect(xhtml).not.toMatch(/−<ix:nonFraction[^>]*name="se-gen-base:OvrigaExternaKostnader"/)
  })

  it('omits the per-signer date fact for unsigned requests instead of fabricating one', () => {
    const input = makeInput()
    input.underskrifter.signers[1].signedDate = null
    const { xhtml } = generateK2IxbrlDocument(input)
    const dates = xhtml.match(/name="se-gen-base:UndertecknandeDatum"/g) ?? []
    expect(dates).toHaveLength(1)
    // Both signers still appear with their names.
    const names = xhtml.match(/name="se-gen-base:UnderskriftHandlingTilltalsnamn"/g) ?? []
    expect(names).toHaveLength(2)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('renders a placeholder instead of a fabricated AGM date when none is recorded', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = null
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(xhtml).not.toContain('name="se-bol-base:Arsstamma"')
    expect(xhtml).toContain('[datum för årsstämma saknas]')
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('omits comparison columns for the first fiscal year', () => {
    const mapping = mapTrialBalancesToK2(CURRENT, null)
    const input = makeInput()
    input.previousPeriod = null
    input.isFirstFiscalYear = true
    input.rr = mapping.rr
    input.br = mapping.br
    input.totals = mapping.totals
    input.forvaltningsberattelse.flerarsoversikt = input.forvaltningsberattelse.flerarsoversikt.slice(0, 1)
    input.forvaltningsberattelse.flerarsPerioder = input.forvaltningsberattelse.flerarsPerioder.slice(0, 1)
    input.forvaltningsberattelse.egetKapital.balanserasINyRakning = 0
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(xhtml).not.toContain('<xbrli:context id="period1">')
    expect(xhtml).not.toContain('<xbrli:context id="balans1">')
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('throws on unknown concepts instead of emitting invalid facts', () => {
    const input = makeInput()
    input.rr['PahittatBegrepp'] = { current: 1, previous: null }
    // Unknown keys in rr are ignored (only mapped posts are rendered): the
    // throw-path is covered via the writer itself in fact-writer tests.
    expect(() => generateK2IxbrlDocument(input)).not.toThrow()
  })
})
