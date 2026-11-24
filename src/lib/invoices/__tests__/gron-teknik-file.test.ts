import { describe, it, expect } from 'vitest'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { buildGronTeknikFile, GRON_TEKNIK_MAX_ARENDEN_PER_FILE } from '@/lib/invoices/gron-teknik-file'

/**
 * buildGronTeknikFile: the grön teknik Begaran file, schema V1
 * (skattered/begaran/1.0). The first case rebuilds Skatteverket's own example
 * file Gronteknik_V1.0.xml from an invoice: a charging point in a
 * bostadsrätt, Kostnad 20 000, OvrigKostnad 5 000, BetaltBelopp 10 000,
 * BegartBelopp 10 000.
 */

// Synthetic test identities from Skatteverket's official example files.
const PNR = '199110306645'
const UTFORARE = '165566778899'
const TODAY = '2026-11-23'

function line(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Montage laddbox',
    quantity: 1,
    unit: 'st',
    unit_price: 16000,
    line_total: 16000,
    vat_rate: 25,
    vat_amount: 4000,
    deduction_type: 'gron_teknik',
    deduction_amount: 10000,
    labor_hours: 20,
    work_type: 'INSTALLATION_LADDPUNKT',
    housing_designation: null,
    apartment_number: '1201',
    brf_org_number: '799900-0040',
    created_at: '2026-03-01T00:00:00Z',
    ...overrides,
  }
}

const travel = (): InvoiceItem =>
  line({
    id: 'item-travel',
    sort_order: 1,
    description: 'Resa och maskiner',
    unit_price: 4000,
    line_total: 4000,
    vat_amount: 1000,
    deduction_type: null,
    deduction_amount: 0,
    labor_hours: null,
    work_type: null,
    apartment_number: null,
    brf_org_number: null,
  })

function gronInvoice(overrides: Partial<Invoice> = {}, items: InvoiceItem[] = [line(), travel()]): Invoice {
  const deduction = items.reduce((sum, i) => sum + (i.deduction_amount ?? 0), 0)
  const total = items.reduce((sum, i) => sum + i.line_total + i.vat_amount, 0)
  return makeInvoice({
    id: 'invoice-1',
    invoice_number: '123456',
    status: 'paid',
    paid_at: '2026-03-17T10:00:00Z',
    total,
    deduction_total: deduction,
    paid_amount: total - deduction,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    deduction_personnummer_last4: PNR.slice(-4),
    items,
    ...overrides,
  })
}

describe('buildGronTeknikFile', () => {
  it("rebuilds Skatteverket's example file from a charging point invoice", () => {
    const result = buildGronTeknikFile({ name: 'GrönTeknik', utforare: UTFORARE, invoices: [gronInvoice()], today: TODAY })

    expect(result.blockers).toEqual([])
    expect(result.xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Begaran xmlns="http://xmls.skatteverket.se/se/skatteverket/skattered/begaran/1.0">',
        '\t<NamnPaBegaran>GrönTeknik</NamnPaBegaran>',
        '\t<TypAvBegaran>GRON_TEKNIK</TypAvBegaran>',
        `\t<Utforare>${UTFORARE}</Utforare>`,
        '\t<Arende>',
        '\t\t<FakturaNr>123456</FakturaNr>',
        `\t\t<Kopare>${PNR}</Kopare>`,
        '\t\t<Fastighet>',
        '\t\t\t<LagenhetsNr>1201</LagenhetsNr>',
        '\t\t\t<BrfOrgNr>167999000040</BrfOrgNr>',
        '\t\t</Fastighet>',
        '\t\t<UtfortArbete>',
        '\t\t\t<TypAvUtfortArbete>INSTALLATION_LADDPUNKT</TypAvUtfortArbete>',
        '\t\t\t<AntalTimmar>20</AntalTimmar>',
        '\t\t\t<Kostnad>20000</Kostnad>',
        '\t\t</UtfortArbete>',
        '\t\t<OvrigKostnad>5000</OvrigKostnad>',
        '\t\t<Betalningsdatum>2026-03-17</Betalningsdatum>',
        '\t\t<BetaltBelopp>10000</BetaltBelopp>',
        '\t\t<BegartBelopp>10000</BegartBelopp>',
        '\t</Arende>',
        '</Begaran>',
      ].join('\n'),
    )
    expect(result.requested_total).toBe(10000)
    expect(result.file_name).toBe('gron_teknik_begaran_2026-11-23.xml')
    expect(result.arenden).toEqual([
      {
        invoice_id: 'invoice-1',
        invoice_number: '123456',
        personnummer_last4: '6645',
        betalnings_datum: '2026-03-17',
        work_type: 'INSTALLATION_LADDPUNKT',
        kostnad: 20000,
        betalt_belopp: 10000,
        begart_belopp: 10000,
      },
    ])
  })

  it('makes one ärende per installation type and states övrig kostnad once', () => {
    const solar = line({
      id: 'item-solar',
      sort_order: 2,
      description: 'Solpaneler med montage',
      unit_price: 40000,
      line_total: 40000,
      vat_amount: 10000,
      deduction_amount: 7500,
      labor_hours: 30,
      work_type: 'INSTALLATION_SOLCELLER',
      apartment_number: null,
      brf_org_number: null,
      housing_designation: 'Exempelby 1:1',
    })
    const charger = line({ apartment_number: null, brf_org_number: null, housing_designation: 'Exempelby 1:1' })
    const result = buildGronTeknikFile({
      name: 'GT',
      utforare: UTFORARE,
      invoices: [gronInvoice({}, [charger, travel(), solar])],
      today: TODAY,
    })

    expect(result.blockers).toEqual([])
    // Skatteverket's list order: solar panels first.
    expect(result.arenden.map((a) => [a.work_type, a.kostnad, a.betalt_belopp, a.begart_belopp])).toEqual([
      ['INSTALLATION_SOLCELLER', 50000, 42500, 7500],
      ['INSTALLATION_LADDPUNKT', 20000, 10000, 10000],
    ])
    expect(result.requested_total).toBe(17500)
    expect(result.xml?.match(/<Arende>/g)).toHaveLength(2)
    expect(result.xml?.match(/<UtfortArbete>/g)).toHaveLength(2)
    expect(result.xml?.match(/<OvrigKostnad>\d+<\/OvrigKostnad>/g)).toEqual([
      '<OvrigKostnad>5000</OvrigKostnad>',
      '<OvrigKostnad>0</OvrigKostnad>',
    ])
    expect(result.xml).toContain('<Fastighetsbeteckning>Exempelby 1:1</Fastighetsbeteckning>')
    expect(result.xml).not.toContain('<LagenhetsNr>')
  })

  it('escapes text and cuts FakturaNr and NamnPaBegaran to the schema lengths', () => {
    const items = [line({ apartment_number: null, brf_org_number: null, housing_designation: 'Ö & Å 1:<2>' }), travel()]
    const result = buildGronTeknikFile({
      name: 'Begäran <mars> & april',
      utforare: UTFORARE,
      invoices: [gronInvoice({ invoice_number: '123456789012345678901234' }, items)],
      today: TODAY,
    })
    expect(result.xml).toContain('<NamnPaBegaran>Begäran &lt;mars&gt; &amp;</NamnPaBegaran>')
    expect(result.xml).toContain('<FakturaNr>12345678901234567890</FakturaNr>')
    expect(result.xml).toContain('<Fastighetsbeteckning>Ö &amp; Å 1:&lt;2&gt;</Fastighetsbeteckning>')
  })

  it('keeps one payment year per file', () => {
    const later = gronInvoice({ id: 'invoice-2', invoice_number: '2', paid_at: '2027-01-05T09:00:00Z' })
    const result = buildGronTeknikFile({
      name: 'GT',
      utforare: UTFORARE,
      invoices: [gronInvoice(), later],
      today: '2027-01-10',
    })
    expect(result.arenden.map((a) => a.invoice_id)).toEqual(['invoice-1'])
    expect(result.blockers).toEqual([expect.objectContaining({ invoice_id: 'invoice-2', code: 'MIXED_PAYMENT_YEARS' })])
  })

  it(`stops at ${GRON_TEKNIK_MAX_ARENDEN_PER_FILE} ärenden per file`, () => {
    const invoices = Array.from({ length: GRON_TEKNIK_MAX_ARENDEN_PER_FILE + 1 }, (_, i) =>
      gronInvoice({ id: `invoice-${i}`, invoice_number: String(i) }),
    )
    const result = buildGronTeknikFile({ name: 'GT', utforare: UTFORARE, invoices, today: TODAY })
    expect(result.arenden).toHaveLength(GRON_TEKNIK_MAX_ARENDEN_PER_FILE)
    expect(result.blockers).toEqual([
      expect.objectContaining({ invoice_id: `invoice-${GRON_TEKNIK_MAX_ARENDEN_PER_FILE}`, code: 'TOO_MANY_CASES' }),
    ])
  })

  it('passes on the blocker of an invoice the claim refuses, and makes no file from nothing', () => {
    const unpaid = gronInvoice({ status: 'sent', paid_at: null, paid_amount: 0 })
    const result = buildGronTeknikFile({ name: 'GT', utforare: UTFORARE, invoices: [unpaid], today: TODAY })
    expect(result.xml).toBeNull()
    expect(result.blockers).toEqual([expect.objectContaining({ code: 'NOT_PAID' })])
  })

  it('names the invoice in the warnings it carries over', () => {
    const late = gronInvoice({ paid_at: '2025-06-01T09:00:00Z' })
    const result = buildGronTeknikFile({ name: 'GT', utforare: UTFORARE, invoices: [late], today: '2026-02-02' })
    expect(result.warnings).toEqual([expect.stringMatching(/^Faktura 123456: Betalningen \(2025-06-01\) har passerat/)])
  })
})
