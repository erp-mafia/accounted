import { describe, it, expect } from 'vitest'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import {
  buildRotRutFile,
  evaluateInvoiceForFile,
  isPastRequestDeadline,
  normalizeBrfOrgNr,
} from '@/lib/invoices/rot-rut-file'

// Personnummer from Skatteverket's official example files (synthetic test
// identities published by the agency: never real people).
const PNR_A = '198406012388'
const PNR_B = '199604102393'

const TODAY = '2026-07-02'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Arbete',
    quantity: 1,
    unit: 'tim',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    deduction_type: 'rot',
    deduction_amount: 3000,
    labor_hours: 25,
    work_type: 'BYGG',
    housing_designation: 'Stockholm Vasastan 1:23',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

function makeRotInvoice(overrides: Partial<Invoice> = {}, items?: InvoiceItem[]): Invoice {
  return makeInvoice({
    status: 'paid',
    paid_at: '2026-06-20T10:00:00Z',
    deduction_total: 3000,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR_A),
    deduction_personnummer_last4: PNR_A.slice(-4),
    items: items ?? [makeItem()],
    ...overrides,
  })
}

describe('buildRotRutFile: rot', () => {
  it('produces a schema-shaped rot file for a paid invoice', () => {
    const result = buildRotRutFile({
      type: 'rot',
      name: 'ROT 2026-07-02',
      invoices: [makeRotInvoice()],
      today: TODAY,
    })

    expect(result.blockers).toHaveLength(0)
    expect(result.arenden).toHaveLength(1)
    expect(result.requested_total).toBe(3000)
    expect(result.file_name).toBe('rot_begaran_2026-07-02.xml')

    const xml = result.xml!
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('xmlns:ns1="http://xmls.skatteverket.se/se/skatteverket/ht/begaran/6.0"')
    expect(xml).toContain('xmlns:ns2="http://xmls.skatteverket.se/se/skatteverket/ht/komponent/begaran/6.0"')
    expect(xml).toContain('<ns2:NamnPaBegaran>ROT 2026-07-02</ns2:NamnPaBegaran>')
    expect(xml).toContain('<ns2:RotBegaran>')
    expect(xml).toContain(`<ns2:Kopare>${PNR_A}</ns2:Kopare>`)
    expect(xml).toContain('<ns2:BetalningsDatum>2026-06-20</ns2:BetalningsDatum>')
    expect(xml).toContain('<ns2:PrisForArbete>12500</ns2:PrisForArbete>')
    expect(xml).toContain('<ns2:BetaltBelopp>9500</ns2:BetaltBelopp>')
    expect(xml).toContain('<ns2:BegartBelopp>3000</ns2:BegartBelopp>')
    expect(xml).toContain('<ns2:Ovrigkostnad>0</ns2:Ovrigkostnad>')
    expect(xml).toContain('<ns2:Fastighetsbeteckning>Stockholm Vasastan 1:23</ns2:Fastighetsbeteckning>')
    expect(xml).toContain('<ns2:Bygg>')
    expect(xml).toContain('<ns2:AntalTimmar>25</ns2:AntalTimmar>')
    expect(xml).toContain('<ns2:Materialkostnad>0</ns2:Materialkostnad>')
  })

  it('emits ärende elements in the XSD sequence order', () => {
    const xml = buildRotRutFile({
      type: 'rot',
      name: 'Ordning',
      invoices: [makeRotInvoice()],
      today: TODAY,
    }).xml!

    const order = [
      'Kopare',
      'BetalningsDatum',
      'PrisForArbete',
      'BetaltBelopp',
      'BegartBelopp',
      'FakturaNr',
      'Ovrigkostnad',
      'Fastighetsbeteckning',
      'UtfortArbete',
    ]
    const positions = order.map((el) => xml.indexOf(`<ns2:${el}`))
    for (const pos of positions) expect(pos).toBeGreaterThan(-1)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('aggregates hours per work type and orders work elements per XSD', () => {
    const items = [
      makeItem({ id: 'i1', work_type: 'VVS', labor_hours: 3, line_total: 3000, vat_amount: 750, deduction_amount: 900 }),
      makeItem({ id: 'i2', work_type: 'EL', labor_hours: 2, line_total: 2000, vat_amount: 500, deduction_amount: 600 }),
      makeItem({ id: 'i3', work_type: 'VVS', labor_hours: 2.4, line_total: 1000, vat_amount: 250, deduction_amount: 300 }),
    ]
    const xml = buildRotRutFile({
      type: 'rot',
      name: 'Aggregering',
      invoices: [makeRotInvoice({}, items)],
      today: TODAY,
    }).xml!

    // 3 + 2.4 h VVS → 5 (whole hours per XSD long)
    expect(xml).toMatch(/<ns2:Vvs>\s*<ns2:AntalTimmar>5<\/ns2:AntalTimmar>/)
    expect(xml).toMatch(/<ns2:El>\s*<ns2:AntalTimmar>2<\/ns2:AntalTimmar>/)
    // El precedes Vvs in the XSD sequence
    expect(xml.indexOf('<ns2:El>')).toBeLessThan(xml.indexOf('<ns2:Vvs>'))
  })

  it('uses lägenhetsnummer + normalized BRF orgnr for bostadsrätt', () => {
    const items = [
      makeItem({ housing_designation: null, apartment_number: '1101', brf_org_number: '769600-0000' }),
    ]
    const xml = buildRotRutFile({
      type: 'rot',
      name: 'Brf',
      invoices: [makeRotInvoice({}, items)],
      today: TODAY,
    }).xml!

    expect(xml).not.toContain('Fastighetsbeteckning')
    expect(xml).toContain('<ns2:LagenhetsNr>1101</ns2:LagenhetsNr>')
    expect(xml).toContain('<ns2:BrfOrgNr>167696000000</ns2:BrfOrgNr>')
  })

  it('escapes XML special characters and clamps NamnPaBegaran to 16 chars', () => {
    const items = [makeItem({ housing_designation: 'Gränby 1:2 & "Södra" <3' })]
    const result = buildRotRutFile({
      type: 'rot',
      name: 'Väldigt långt namn på begäran som klipps',
      invoices: [makeRotInvoice({ invoice_number: 'F<&>2026' }, items)],
      today: TODAY,
    })
    const xml = result.xml!

    expect(xml).toContain('Gränby 1:2 &amp; &quot;Södra&quot; &lt;3')
    expect(xml).toContain('<ns2:FakturaNr>F&lt;&amp;&gt;2026</ns2:FakturaNr>')
    const name = xml.match(/<ns2:NamnPaBegaran>(.*)<\/ns2:NamnPaBegaran>/)?.[1]
    expect(name).toBe('Väldigt långt na')
  })
})

describe('buildRotRutFile: rut', () => {
  function makeRutInvoice(items: InvoiceItem[]): Invoice {
    return makeRotInvoice(
      { deduction_personnummer_encrypted: encryptPersonnummer(PNR_B) },
      items,
    )
  }

  it('wraps ärenden in HushallBegaran and accepts IT-tjänster', () => {
    const items = [
      makeItem({ deduction_type: 'rut', work_type: 'IT', labor_hours: 4, housing_designation: null, deduction_amount: 5000 }),
    ]
    const xml = buildRotRutFile({
      type: 'rut',
      name: 'RUT juni',
      invoices: [makeRutInvoice(items)],
      today: TODAY,
    }).xml!

    expect(xml).toContain('<ns2:HushallBegaran>')
    expect(xml).not.toContain('RotBegaran')
    expect(xml).toMatch(/<ns2:ItTjanster>\s*<ns2:AntalTimmar>4<\/ns2:AntalTimmar>/)
    // No property elements for rut
    expect(xml).not.toContain('Fastighetsbeteckning')
  })

  it('reports schablontjänster as Utfort without hours', () => {
    const items = [
      makeItem({ deduction_type: 'rut', work_type: 'TVATT', labor_hours: null, housing_designation: null, deduction_amount: 250 }),
    ]
    const xml = buildRotRutFile({
      type: 'rut',
      name: 'Schablon',
      invoices: [makeRutInvoice(items)],
      today: TODAY,
    }).xml!

    expect(xml).toMatch(/<ns2:TvattVidTvattinrattning>\s*<ns2:Utfort>true<\/ns2:Utfort>/)
    expect(xml).not.toContain('AntalTimmar')
  })
})

describe('eligibility blockers', () => {
  it('NOT_PAID for unpaid invoices', () => {
    const result = evaluateInvoiceForFile('rot', makeRotInvoice({ status: 'sent' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('NOT_PAID')
  })

  it('MISSING_PAYMENT_DATE when paid without paid_at', () => {
    const result = evaluateInvoiceForFile('rot', makeRotInvoice({ paid_at: null }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MISSING_PAYMENT_DATE')
  })

  it('NO_DEDUCTION_OF_TYPE when the invoice has no lines of the requested type', () => {
    const result = evaluateInvoiceForFile('rut', makeRotInvoice())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('NO_DEDUCTION_OF_TYPE')
  })

  it('MIXED_DEDUCTION_TYPES when rot and rut lines share an invoice', () => {
    const items = [
      makeItem(),
      makeItem({ id: 'i2', deduction_type: 'rut', work_type: 'STAD', labor_hours: 2 }),
    ]
    const result = evaluateInvoiceForFile('rot', makeRotInvoice({}, items))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MIXED_DEDUCTION_TYPES')
  })

  it('MISSING_PERSONNUMMER without an encrypted personnummer', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({ deduction_personnummer_encrypted: null }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MISSING_PERSONNUMMER')
  })

  it('PERSONNUMMER_UNREADABLE on undecryptable ciphertext', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({ deduction_personnummer_encrypted: 'deadbeef' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('PERSONNUMMER_UNREADABLE')
  })

  it('MISSING_WORK_TYPE when a deduction line has no arbetstyp', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [makeItem({ work_type: null })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MISSING_WORK_TYPE')
  })

  it('INVALID_WORK_TYPE for IT flagged as rot (rut-only service)', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [makeItem({ work_type: 'IT' })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('INVALID_WORK_TYPE')
  })

  it('MISSING_HOURS when a non-schablon line lacks labor hours', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [makeItem({ labor_hours: null })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MISSING_HOURS')
  })

  it('HOURS_OUT_OF_RANGE above 999 hours', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [makeItem({ labor_hours: 1200 })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('HOURS_OUT_OF_RANGE')
  })

  it('MISSING_PROPERTY when a rot invoice has no property info', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [makeItem({ housing_designation: null })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('MISSING_PROPERTY')
  })

  it('INVALID_BRF_ORGNR on a malformed BRF orgnr', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [
        makeItem({ housing_designation: null, apartment_number: '1101', brf_org_number: '123' }),
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('INVALID_BRF_ORGNR')
  })

  it('PRICE_BELOW_MINIMUM when arbetskostnaden rounds below 2 kr', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [
        makeItem({ line_total: 1, vat_amount: 0, deduction_amount: 0.3, labor_hours: 1 }),
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('PRICE_BELOW_MINIMUM')
  })

  it('ZERO_DEDUCTION when the deduction rounds to 0 kr', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [
        makeItem({ line_total: 100, vat_amount: 25, deduction_amount: 0, labor_hours: 1 }),
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('ZERO_DEDUCTION')
  })

  it('DEDUCTION_EXCEEDS_PAYMENT when begärt belopp exceeds what the buyer paid', () => {
    // 100 kr work, 60 kr deduction → buyer paid 40 kr < 60 kr requested.
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({}, [
        makeItem({ line_total: 80, vat_amount: 20, deduction_amount: 60, labor_hours: 1 }),
      ]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('DEDUCTION_EXCEEDS_PAYMENT')
  })

  it('allows begärt belopp equal to betalt belopp (50 % rut)', () => {
    const result = evaluateInvoiceForFile(
      'rut',
      makeRotInvoice({}, [
        makeItem({
          deduction_type: 'rut',
          work_type: 'STAD',
          line_total: 80,
          vat_amount: 20,
          deduction_amount: 50,
          labor_hours: 2,
          housing_designation: null,
        }),
      ]),
    )
    expect(result.ok).toBe(true)
  })

  it('collects blockers per invoice while still emitting eligible ones', () => {
    const result = buildRotRutFile({
      type: 'rot',
      name: 'Blandat',
      invoices: [makeRotInvoice(), makeRotInvoice({ status: 'sent', invoice_number: 'F-BAD' })],
      today: TODAY,
    })
    expect(result.arenden).toHaveLength(1)
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0].invoice_number).toBe('F-BAD')
    expect(result.xml).not.toBeNull()
  })

  it('returns xml: null when nothing is eligible', () => {
    const result = buildRotRutFile({
      type: 'rot',
      name: 'Tomt',
      invoices: [makeRotInvoice({ status: 'sent' })],
      today: TODAY,
    })
    expect(result.xml).toBeNull()
    expect(result.requested_total).toBe(0)
  })
})

describe('deadline + helpers', () => {
  it('warns when the 31 January deadline has passed', () => {
    const invoice = makeRotInvoice({ paid_at: '2024-12-30T00:00:00Z' })
    const result = buildRotRutFile({ type: 'rot', name: 'Sen', invoices: [invoice], today: TODAY })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('31 januari')
  })

  it('isPastRequestDeadline boundary behavior', () => {
    expect(isPastRequestDeadline('2025-06-01', '2026-01-31')).toBe(false)
    expect(isPastRequestDeadline('2025-06-01', '2026-02-01')).toBe(true)
    expect(isPastRequestDeadline('2026-01-15', '2026-07-02')).toBe(false)
  })

  it('normalizeBrfOrgNr handles 10/12 digits and rejects the rest', () => {
    expect(normalizeBrfOrgNr('769600-0000')).toBe('167696000000')
    expect(normalizeBrfOrgNr('167696000000')).toBe('167696000000')
    expect(normalizeBrfOrgNr('76960')).toBeNull()
    // 12 digits without the sekelsiffra 16 prefix is not a valid orgnr.
    expect(normalizeBrfOrgNr('123456789012')).toBeNull()
  })

  it('matches the shape of Skatteverkets official rot example', () => {
    // Mirror exempel_rot_3st.xml ärende 2: fastighet + one work type.
    const items = [
      makeItem({
        work_type: 'GLAS_PLAT',
        labor_hours: 4,
        housing_designation: 'TEST 1:7',
        line_total: 1600,
        vat_amount: 400,
        deduction_amount: 600,
      }),
    ]
    const xml = buildRotRutFile({
      type: 'rot',
      name: 'Exempel Rot',
      invoices: [makeRotInvoice({}, items)],
      today: TODAY,
    }).xml!

    expect(xml).toMatch(
      /<ns2:Arenden>\s*<ns2:Kopare>\d{12}<\/ns2:Kopare>\s*<ns2:BetalningsDatum>\d{4}-\d{2}-\d{2}<\/ns2:BetalningsDatum>\s*<ns2:PrisForArbete>2000<\/ns2:PrisForArbete>\s*<ns2:BetaltBelopp>1400<\/ns2:BetaltBelopp>\s*<ns2:BegartBelopp>600<\/ns2:BegartBelopp>/,
    )
    expect(xml).toMatch(/<ns2:Fastighetsbeteckning>TEST 1:7<\/ns2:Fastighetsbeteckning>\s*<ns2:UtfortArbete>\s*<ns2:GlasPlatarbete>/)
  })
})
