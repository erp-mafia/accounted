import { describe, it, expect } from 'vitest'
import { extractNameCandidates, extractVatNumbers } from '../name-extract'

describe('extractNameCandidates', () => {
  it('reads a Swedish legal person out of an assistant-written description', () => {
    const c = extractNameCandidates('1511768101 · Visma Spcs AB, faktura 2025-10-02, programvarulicens/abonnemang')
    expect(c[0]).toMatchObject({ name: 'Visma Spcs AB', legalForm: 'AB', foreign: false, source: 'legal_form' })
  })

  it('finds the company after a bank memo head and keeps (publ)', () => {
    const c = extractNameCandidates(
      'TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746, The Intelligence Company AB (publ). TIC Identity-abonnemang.',
    )
    expect(c[0]).toMatchObject({ name: 'The Intelligence Company AB (publ)', legalForm: 'AB (publ)', foreign: false })
    expect(c.map((x) => x.name)).toContain('TIC identity')
  })

  it('marks foreign legal forms with their country and does not offer them to SCB', () => {
    expect(extractNameCandidates('Utlägg Framer · Framer B.V. (NL), webbdesignverktyg. Säljaren debiterat svensk moms via OSS (NL VAT NL853695386B01 på fakturan).')[0]).toMatchObject({
      name: 'Framer B.V.',
      legalForm: 'B.V.',
      country: 'NL',
      foreign: true,
    })
    expect(extractNameCandidates('Polar website software Överföring via internet · Polar Software Inc. (USA) - utländsk moms 24,75 USD ej avdragsgill')[0]).toMatchObject({
      name: 'Polar Software Inc.',
      country: 'US',
      foreign: true,
    })
    expect(extractNameCandidates('Hostinger utlägg · Hostinger International Ltd (CY). Faktura 17,49 USD inkl 3,50 USD cypriotisk/EU-moms.')[0]).toMatchObject({
      name: 'Hostinger International Ltd',
      legalForm: 'Ltd',
      country: 'CY',
      foreign: true,
    })
    expect(extractNameCandidates('Utlägg Anthropic · Anthropic PBC, 206,12 EUR inkl. 41,22 EUR VAT-Sweden 25% via OSS.')[0]).toMatchObject({
      name: 'Anthropic PBC',
      country: 'US',
      foreign: true,
    })
  })

  it('anchors on a country word when there is no legal form, and marks the head foreign too', () => {
    const c = extractNameCandidates(
      'Claude Maj H Överföring via internet · Anthropic Ireland, faktura 22,5 EUR inkl 4,5 EUR VAT-Sweden 25% via OSS. Säljardebiterad moms ej avdragsgill.',
    )
    expect(c[0]).toMatchObject({ name: 'Anthropic Ireland', country: 'IE', foreign: true, source: 'country' })
    expect(c[1]).toMatchObject({ name: 'Claude Maj H', country: 'IE', foreign: true, source: 'head' })
  })

  it('drops lead words and counters before the name', () => {
    expect(extractNameCandidates('Delbetalning till 2 Fortnox Aktiebolag, faktura 4711')[0]).toMatchObject({ name: 'Fortnox AB', foreign: false })
    expect(extractNameCandidates('Kundbet Acme Konsult AB')[0]).toMatchObject({ name: 'Acme Konsult AB', foreign: false })
    expect(extractNameCandidates('Rättelse: Leverantörsfaktura 18299, RosholmDell Advokatbyrå AB (ankomst 2)')[0]).toMatchObject({
      name: 'RosholmDell Advokatbyrå AB',
      foreign: false,
    })
    expect(extractNameCandidates('Rättelse: Google oktober · Google Cloud EMEA Limited (Irland, EU). Faktura 2025-09-30')[0]).toMatchObject({
      name: 'Google Cloud EMEA Ltd',
      country: 'IE',
      foreign: true,
    })
  })

  it('keeps a Swedish company Swedish even when the text mentions VAT-Sweden', () => {
    const c = extractNameCandidates('Telia Sverige AB, faktura, VAT-Sweden 25%')
    expect(c[0]).toMatchObject({ name: 'Telia Sverige AB', country: 'SE', foreign: false })
  })

  it('falls back to the cleaned head for plain bank text', () => {
    const c = extractNameCandidates('BEIJER BYGGMATERIAL 2089')
    expect(c).toEqual([{ name: 'BEIJER BYGGMATERIAL', foreign: false, source: 'head' }])
  })

  it('does not mistake uppercase words or SL for legal forms', () => {
    expect(extractNameCandidates('SL biljett Stockholm').some((c) => c.source === 'legal_form')).toBe(false)
    expect(extractNameCandidates('DELBETALNING KONTOR').some((c) => c.source === 'legal_form')).toBe(false)
  })
})

describe('extractVatNumbers', () => {
  it('reads EU VAT numbers and ignores uppercase words', () => {
    expect(extractVatNumbers('NL VAT NL853695386B01 på fakturan; rekommendera SE559538621901 hos leverantören')).toEqual([
      { vat: 'NL853695386B01', country: 'NL' },
      { vat: 'SE559538621901', country: 'SE' },
    ])
    expect(extractVatNumbers('DELBETALNING SEKRETESS')).toEqual([])
  })
})
