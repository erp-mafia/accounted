import { describe, it, expect } from 'vitest'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { proposeSendLines } from '@/lib/bookkeeping/propose-send-lines'
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

  it('is byte-identical for a plain SEK invoice (conversion is a no-op)', () => {
    // Locks the SEK output: threading currency through the amount block must
    // not move a single character for the overwhelmingly common case.
    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ns1:Begaran xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        + ' xmlns:ns1="http://xmls.skatteverket.se/se/skatteverket/ht/begaran/6.0"'
        + ' xmlns:ns2="http://xmls.skatteverket.se/se/skatteverket/ht/komponent/begaran/6.0">',
      '\t<ns2:NamnPaBegaran>ROT 2026-07-02</ns2:NamnPaBegaran>',
      '\t<ns2:RotBegaran>',
      '\t\t<ns2:Arenden>',
      `\t\t\t<ns2:Kopare>${PNR_A}</ns2:Kopare>`,
      '\t\t\t<ns2:BetalningsDatum>2026-06-20</ns2:BetalningsDatum>',
      '\t\t\t<ns2:PrisForArbete>12500</ns2:PrisForArbete>',
      '\t\t\t<ns2:BetaltBelopp>9500</ns2:BetaltBelopp>',
      '\t\t\t<ns2:BegartBelopp>3000</ns2:BegartBelopp>',
      '\t\t\t<ns2:FakturaNr>F-2024001</ns2:FakturaNr>',
      '\t\t\t<ns2:Ovrigkostnad>0</ns2:Ovrigkostnad>',
      '\t\t\t<ns2:Fastighetsbeteckning>Stockholm Vasastan 1:23</ns2:Fastighetsbeteckning>',
      '\t\t\t<ns2:UtfortArbete>',
      '\t\t\t\t<ns2:Bygg>',
      '\t\t\t\t\t<ns2:AntalTimmar>25</ns2:AntalTimmar>',
      '\t\t\t\t\t<ns2:Materialkostnad>0</ns2:Materialkostnad>',
      '\t\t\t\t</ns2:Bygg>',
      '\t\t\t</ns2:UtfortArbete>',
      '\t\t</ns2:Arenden>',
      '\t</ns2:RotBegaran>',
      '</ns1:Begaran>',
    ].join('\n')

    const result = buildRotRutFile({
      type: 'rot',
      name: 'ROT 2026-07-02',
      invoices: [makeRotInvoice()],
      today: TODAY,
    })
    expect(result.xml).toBe(expected)
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

describe('foreign-currency invoices: kronor conversion', () => {
  /**
   * Begaran.xsd has no currency attribute: every belopp is an xs:long in
   * kronor. The ledger already converts (BAS 1513 is debited in SEK), so the
   * file has to convert with the same rate or the receivable can never clear.
   */

  /** The ledger's own 1513 debit for this invoice, per öre. */
  function ledger1513(invoice: Invoice): number {
    const lines = proposeSendLines({ invoice, entityType: 'enskild_firma' })
    return lines
      .filter((l) => l.account_number === '1513')
      .reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
  }

  const EUR_RATE = 11.4

  function makeEurRotInvoice(item: Partial<InvoiceItem>, overrides: Partial<Invoice> = {}): Invoice {
    const merged = makeItem(item)
    return makeRotInvoice(
      {
        currency: 'EUR',
        exchange_rate: EUR_RATE,
        subtotal: merged.line_total,
        vat_amount: merged.vat_amount,
        total: merged.line_total + merged.vat_amount,
        ...overrides,
      },
      [merged],
    )
  }

  it('emits SEK whole kronor for a 3 000 EUR rot invoice', () => {
    // 3 000 EUR arbete + 750 EUR moms = 3 750 EUR inkl. moms; avdrag 30% av
    // inkl.-moms-arbetet = 1 125 EUR (HUSFL 6-9 §§), rate 11,40:
    //   PrisForArbete 34 200 + 8 550   = 42 750 kr
    //   BegartBelopp  1 125 × 11,40    = 12 825 kr
    //   BetaltBelopp  42 750 - 12 825  = 29 925 kr
    const invoice = makeEurRotInvoice({
      unit_price: 3000,
      quantity: 1,
      line_total: 3000,
      vat_amount: 750,
      deduction_amount: 1125,
      labor_hours: 10,
    })

    const result = buildRotRutFile({ type: 'rot', name: 'EUR', invoices: [invoice], today: TODAY })
    expect(result.blockers).toHaveLength(0)

    const xml = result.xml!
    expect(xml).toContain('<ns2:PrisForArbete>42750</ns2:PrisForArbete>')
    expect(xml).toContain('<ns2:BegartBelopp>12825</ns2:BegartBelopp>')
    expect(xml).toContain('<ns2:BetaltBelopp>29925</ns2:BetaltBelopp>')
    expect(result.requested_total).toBe(12825)

    // The begäran and the receivable must be the same claim.
    expect(result.arenden[0].begart_belopp).toBe(Math.round(ledger1513(invoice)))
  })

  it('asks for 8 906 kr, not 781, on the 781.25 EUR deduction case', () => {
    // The bug this test pins: a EUR avdrag booked to 1513 in kronor while
    // the begäran asked Skatteverket for the raw EUR figure (read as kronor).
    // 2 083,33 EUR arbete + 520,83 moms = 2 604,16 inkl.; 30% = 781,25 EUR
    // = 8 906,25 kr at 11,40, whole-kronor 8 906 in the file.
    const invoice = makeEurRotInvoice({
      unit_price: 2083.33,
      quantity: 1,
      line_total: 2083.33,
      vat_amount: 520.83,
      deduction_amount: 781.25,
      labor_hours: 8,
    })

    const result = buildRotRutFile({ type: 'rot', name: 'EUR 625', invoices: [invoice], today: TODAY })
    expect(result.blockers).toHaveLength(0)

    const xml = result.xml!
    expect(xml).toContain('<ns2:BegartBelopp>8906</ns2:BegartBelopp>')
    expect(xml).not.toContain('<ns2:BegartBelopp>781</ns2:BegartBelopp>')
    expect(ledger1513(invoice)).toBe(8906.25)
    expect(result.arenden[0].begart_belopp).toBe(8906)
  })

  it('MISSING_EXCHANGE_RATE rather than a guessed figure when the rate is absent', () => {
    for (const rate of [null, 0, -1]) {
      const invoice = makeEurRotInvoice(
        { unit_price: 3000, line_total: 3000, vat_amount: 750, deduction_amount: 900 },
        { exchange_rate: rate },
      )
      const result = evaluateInvoiceForFile('rot', invoice)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.blocker.code).toBe('MISSING_EXCHANGE_RATE')
        expect(result.blocker.message).toContain('växelkurs')
      }
    }
  })

  it('refuses to build a file from a rate-less foreign invoice', () => {
    const invoice = makeEurRotInvoice(
      { unit_price: 3000, line_total: 3000, vat_amount: 750, deduction_amount: 900 },
      { exchange_rate: null },
    )
    const result = buildRotRutFile({ type: 'rot', name: 'Utan kurs', invoices: [invoice], today: TODAY })
    expect(result.xml).toBeNull()
    expect(result.requested_total).toBe(0)
    expect(result.blockers.map((b) => b.code)).toEqual(['MISSING_EXCHANGE_RATE'])
  })

  it('requested_total sums kronor, never mixed currencies', () => {
    // One SEK invoice (3 000 kr avdrag) + one EUR invoice (900 EUR = 10 260 kr).
    const sekInvoice = makeRotInvoice()
    const eurInvoice = makeEurRotInvoice({
      unit_price: 3000,
      quantity: 1,
      line_total: 3000,
      vat_amount: 750,
      deduction_amount: 900,
      labor_hours: 10,
    })

    const result = buildRotRutFile({
      type: 'rot',
      name: 'Blandad valuta',
      invoices: [sekInvoice, eurInvoice],
      today: TODAY,
    })

    expect(result.blockers).toHaveLength(0)
    expect(result.arenden.map((a) => a.begart_belopp)).toEqual([3000, 10260])
    expect(result.requested_total).toBe(13260)
    // The old scalar added 3 000 kr to 900 EUR and called it 3 900.
    expect(result.requested_total).not.toBe(3900)
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

  it('FUTURE_PAYMENT_DATE when the recorded payment is after today', () => {
    const result = evaluateInvoiceForFile(
      'rot',
      makeRotInvoice({ paid_at: '2026-07-03T10:00:00Z' }),
      { today: TODAY },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.blocker.code).toBe('FUTURE_PAYMENT_DATE')
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

  it('MIXED_PAYMENT_YEARS when one file spans more than one payment year', () => {
    const result = buildRotRutFile({
      type: 'rot',
      name: 'Två år',
      invoices: [
        makeRotInvoice({ id: 'invoice-2026', invoice_number: 'F-2026' }),
        makeRotInvoice({
          id: 'invoice-2025',
          invoice_number: 'F-2025',
          paid_at: '2025-12-30T10:00:00Z',
        }),
      ],
      today: TODAY,
    })

    expect(result.arenden).toHaveLength(1)
    expect(result.blockers).toEqual([
      expect.objectContaining({ invoice_id: 'invoice-2025', code: 'MIXED_PAYMENT_YEARS' }),
    ])
  })

  it('TOO_MANY_CASES when a file contains more than 100 cases', () => {
    // Reuse one encrypted synthetic personnummer. Creating 101 independent
    // ciphertexts would benchmark the KDF rather than the file-size rule.
    const baseInvoice = makeRotInvoice()
    const invoices = Array.from({ length: 101 }, (_, index) => ({
      ...baseInvoice,
      id: `invoice-${index + 1}`,
      invoice_number: `F-${index + 1}`,
    }))
    const result = buildRotRutFile({
      type: 'rot',
      name: 'För många',
      invoices,
      today: TODAY,
    })

    expect(result.arenden).toHaveLength(100)
    expect(result.blockers).toEqual([
      expect.objectContaining({ invoice_id: 'invoice-101', code: 'TOO_MANY_CASES' }),
    ])
  }, 30_000)

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
