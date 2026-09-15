import { describe, expect, it } from 'vitest'
import { buildKU55Item, generateKU55Xml, normalizeKu55OrgNumber, normalizePersonalNumber, type KU55Transfer } from '../ku55'

const base: KU55Transfer = {
  transferId: 't1',
  specificationNumber: 1,
  apartmentNumber: 'Lgh 1203',
  transferDate: '2026-03-15',
  share: 0.5,
  kind: 'sale',
  price: 2_450_000.4,
  additionalPrice: null,
  forvarvDate: '2015-06-01',
  forvarvGenomArvGavaBodelning: false,
  forvarvPrice: 1_200_000,
  kapitaltillskott: 34_567.6,
  inreFondVidOverlatelse: 1_500,
  inreFondVidForvarv: 800,
  andelFormogenhet1974: null,
  gemensamIndividuell: 'I',
  oaktaBostadsforetag: false,
  seller: { memberId: 'm1', name: 'Anna Andersson', personalNumber: '8501011234', postalAddress: null },
}

describe('buildKU55Item', () => {
  it('maps a sale to the KU55 fältkoder in whole kronor with the share as percent', () => {
    const item = buildKU55Item(base, 2026)
    expect(item.complete).toBe(true)
    expect(item.problems).toEqual([])
    expect(item.fields).toEqual({
      '215': '198501011234',
      '203': 2026,
      '570': 1,
      '630': 'Lgh 1203',
      '631': '20260315',
      '632': '50.00',
      '634': 2_450_000,
      '635': 1_500,
      '636': 34_568,
      '640': '20150601',
      '643': 1_200_000,
      '644': 800,
      '646': 'I',
    })
  })

  it('marks arv, gåva and bodelning (633), oäkta (638) and an inherited förvärv (642), and drops the price', () => {
    const item = buildKU55Item(
      { ...base, kind: 'arv', price: null, forvarvGenomArvGavaBodelning: true, oaktaBostadsforetag: true, additionalPrice: 10_000 },
      2026,
    )
    expect(item.complete).toBe(true)
    expect(item.fields['633']).toBe(1)
    expect(item.fields['638']).toBe(1)
    expect(item.fields['642']).toBe(1)
    expect(item.fields['639']).toBe(10_000)
    expect(item.fields['634']).toBeUndefined()
  })

  it('reports a missing personnummer and a missing sale price as incomplete, a missing förvärvsdatum as a warning', () => {
    const noId = buildKU55Item({ ...base, seller: { ...base.seller, personalNumber: null } }, 2026)
    expect(noId.complete).toBe(false)
    expect(noId.problems[0]).toContain('Personnummer saknas')
    expect(noId.fields['215']).toBeUndefined()
    const noPrice = buildKU55Item({ ...base, price: null }, 2026)
    expect(noPrice.complete).toBe(false)
    expect(noPrice.problems[0]).toContain('Överlåtelsepris saknas')
    const noForvarv = buildKU55Item({ ...base, forvarvDate: null }, 2026)
    expect(noForvarv.complete).toBe(true)
    expect(noForvarv.problems).toEqual(['Förvärvsdatum saknas (fältkod 640).'])
  })
})

describe('normalizePersonalNumber', () => {
  it('keeps twelve digits, adds the century to ten, and handles the + separator', () => {
    expect(normalizePersonalNumber('19850101-1234', 2026)).toBe('198501011234')
    expect(normalizePersonalNumber('850101-1234', 2026)).toBe('198501011234')
    expect(normalizePersonalNumber('0501011234', 2026)).toBe('200501011234')
    expect(normalizePersonalNumber('250101+1234', 2026)).toBe('192501011234')
    expect(normalizePersonalNumber('abc', 2026)).toBeNull()
  })
})

describe('generateKU55Xml', () => {
  const company = {
    orgNumber: '769600-1234',
    companyName: 'Brf Solhöjden & Co',
    incomeYear: 2026,
    contactName: 'Kassör Karin',
    contactPhone: '+46812345678',
    contactEmail: 'karin@brf.se',
    programName: 'accounted',
    createdAt: '2027-01-15T10:00:00.000Z',
  }

  it('emits the Kontrolluppgifter 12.0 envelope with one Blankett per complete KU, in schema order', () => {
    const items = [buildKU55Item(base, 2026), buildKU55Item({ ...base, transferId: 't2', specificationNumber: 2, seller: { ...base.seller, personalNumber: null } }, 2026)]
    const xml = generateKU55Xml(company, items)
    expect(xml).toContain('xmlns:ku="http://xmls.skatteverket.se/se/skatteverket/ai/komponent/infoForBeskattning/12.0"')
    expect(xml).toContain('<ku:Organisationsnummer>167696001234</ku:Organisationsnummer>')
    expect(xml).toContain('<ku:NamnUppgiftslamnare faltkod="202">Brf Solhöjden &amp; Co</ku:NamnUppgiftslamnare>')
    expect(xml).toContain('<ku:Skapad>2027-01-15T10:00:00</ku:Skapad>')
    expect(xml.match(/<ku:Blankett /g)).toHaveLength(1)
    expect(xml).toContain('<ku:Inkomsttagare faltkod="215">198501011234</ku:Inkomsttagare>')
    const order = ['Inkomstar', 'Specifikationsnummer', 'BostRattBeteckning', 'Overlatelsedatum', 'OverlatenAndel', 'Overlatelsepris', 'InreRepFondOverlatelse', 'Kapitaltillskott', 'Forvarvsdatum', 'Forvarvspris', 'InreRepFondForvarv', 'GemensamIndividuell']
    const positions = order.map((name) => xml.indexOf(`<ku:${name} `))
    expect(positions.every((p) => p > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(xml).toContain('<ku:OverlatenAndel faltkod="632">50.00</ku:OverlatenAndel>')
    expect(xml).toContain('<ku:Period>2026</ku:Period>')
  })

  it('refuses an organisationsnummer that cannot become the 16-prefixed twelve digits', () => {
    expect(() => normalizeKu55OrgNumber('12345')).toThrow(/organisationsnumret/)
    expect(normalizeKu55OrgNumber('7696001234')).toBe('167696001234')
  })
})
